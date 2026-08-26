import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  ActiveTenantNotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import type { ScopedDb, TenantContext } from "./context";

// NOTE: the closure-extended `$extends` client is not the bare PrismaClient type, but it
// still exposes `$transaction`. Accept anything transaction-capable for the *On helpers so
// tests can pass their own client without depending on the (mockable) singleton.
type TransactionCapable = Pick<PrismaClient, "$extends" | "$transaction">;

// NOTE: models that carry a tenant_id we auto-inject on write. Excludes global/identity
// tables (User, AuditLog, McpOAuth*) and Tenant (no tenant_id column). RLS is the hard
// boundary; this extension only supplies tenant_id on insert (so WITH CHECK passes and
// callers need not pass it) and overrides any caller-supplied tenant_id (anti-spoof).
const TENANT_SCOPED_MODELS = new Set<string>([
  "Appointment",
  "ChatwootInstance",
  "ChatwootWebhookDelivery",
  "Inbox",
  "Contact",
  "Conversation",
  "Agent",
  "BusinessHours",
  "KnowledgeBase",
  "KnowledgeChunk",
  "ApprovalQueueItem",
  "VaultEntry",
  "ToolDefinition",
  "McpServerConnection",
  "IntegrationInstance",
  "AgentToolSelection",
  "IntegrationExternalRef",
  "InboundDelivery",
  "ConversionEvent",
  "WebhookSubscription",
  "OutboundWebhookDelivery",
  "SchedulerJob",
  "DocumentTemplate",
  "IssuedDocument",
  "Experiment",
  "PromptVariantAssignment",
  "LlmUsage",
  "ExecutionLog",
  "AlertChannel",
  "AlertDelivery",
  "ApiKey",
  "AttendanceSummary",
  "PlaygroundTurnNote",
]);

function withTenant<T>(data: T, tenantId: bigint): T {
  return { ...(data as object), tenantId } as T;
}

// NOTE: closure-bound to a fixed tenantId (validated approach: reading the tenant from
// AsyncLocalStorage inside the callback is unreliable on `create`).
function makeScopedExtension(tenantId: bigint) {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        // biome-ignore lint/suspicious/noExplicitAny: Prisma extension args are dynamic.
        async $allOperations({ model, operation, args, query }: any) {
          if (model && TENANT_SCOPED_MODELS.has(model)) {
            if (operation === "create") {
              args.data = withTenant(args.data, tenantId);
            } else if (
              operation === "createMany" ||
              operation === "createManyAndReturn"
            ) {
              args.data = Array.isArray(args.data)
                ? args.data.map((d: unknown) => withTenant(d, tenantId))
                : withTenant(args.data, tenantId);
            } else if (operation === "upsert") {
              args.create = withTenant(args.create, tenantId);
            }
          }
          return query(args);
        },
      },
    },
  });
}

// A SUPER_ADMIN's target tenant is the only tenant id that reaches this boundary from OUTSIDE the
// process: it comes from a per-request selector (the `X-Tenant-Id` header, which the console persists
// in the browser, or an MCP call's `tenant` argument), so it can name a tenant that no longer exists.
// Every context this process builds for itself carries an id it just read from a row, and carries
// TENANT_ADMIN, which is what makes the role the whole predicate.
//
// Unverified, that id is not an error anywhere, which is the problem. RLS scopes the transaction to a
// tenant with no rows, so a READ answers with defaults (a settings screen loads empty, looking
// healthy) and a WRITE fails inside Prisma (measured: P2025 on an update, P2003 on an insert).
// Neither of those is an AppError, so `onError` falls through to its generic branch and the operator
// is told "something went wrong", with no reason, on a screen whose data was never real. Issue #223.
//
// The MCP transport already asks this question, per call, before it builds the principal
// (`resolveTenantSelector`, answering "Tenant not found"). Same question, same answer, so the two
// transports cannot diverge.
//
// They diverged anyway, twice, and both times the same way: a REST controller unwrapped the request
// context down to `ctx.tenantId` and handed the bare id to a module that rebuilt a TENANT_ADMIN
// context around it, so this check saw an internal id and skipped. #268 was the playground; #280 was
// knowledge/RAG, experiments, integrations, documents and the n8n export. Nothing here can catch
// that — the lie is well-formed by the time it arrives — so the fence is on the transport, where the
// provenance is still known: `tests/modules/tenant-selector-entry-points.test.ts`.
//
// One statement, in a transaction that is already open, and only where the id is unverified. Asking
// at the request boundary instead would cost a transaction of its own on every request the fleet
// operator makes, and the first-run operator of EVERY installation is a SUPER_ADMIN.
async function requireTenantExists(
  db: ScopedDb,
  tenantId: bigint,
): Promise<void> {
  // Visible under the GUC set above iff it exists: the tenants policy is `id = app.tenant_id`.
  const row = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!row) {
    // The same status and key the MCP selector and `getTenant` already answer with, in a class of
    // its own: this is the only one of the seven that refuses the selector the CALLER WAS CARRYING
    // rather than a tenant its request named, and the console has to tell them apart to know whether
    // to drop what it has stored (src/lib/console-params.ts).
    throw new ActiveTenantNotFoundError(tenantId);
  }
}

// NOTE: no network/LLM await inside `fn` — the transaction pins a pooled connection and
// long I/O would exhaust the pool. Keep fn to DB work; do network I/O outside.
//
// "Network" includes A SECOND POSTGRES. The `ingest:<threadId>` sections used to await the LangGraph
// checkpointer, which has its own pool and its own connections, from in here, and the rule read as satisfied
// because nothing was calling an HTTP API. It cost the same: a connection held idle-in-transaction
// across another pool's round-trips, this pool drained, and every unrelated query failing on
// `maxWait` (issue #225). If `fn` awaits anything that is not this transaction, it does not belong.
//
// `...On` variants take the base client explicitly so integration tests can pass their own
// (real) client instead of the singleton, which unit tests mock globally.
// Stated rather than inherited. These ARE the Prisma defaults, and that is the problem: the two
// failures a drained pool produces name these exact numbers ("Unable to start a transaction in the
// given time" is `maxWait`; "a query cannot be executed on an expired transaction" is `timeout`),
// and neither number appeared anywhere in this repository. Naming them here is what makes the
// budget greppable from the error, and tunable in one place if it ever has to move.
export const SCOPED_TX_OPTIONS = {
  // Time to WAIT for a free connection before giving up.
  maxWait: 2_000,
  // Time the transaction may stay open once it has one. Every section in here is DB-only work by the
  // rule above, so this is a ceiling on a pathology, not a budget anything should approach.
  timeout: 5_000,
} as const;

export async function runScopedOn<T>(
  base: TransactionCapable,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  if (ctx.tenantId === null) {
    throw new TenantTargetRequiredError();
  }
  const tenantId = ctx.tenantId;
  const extended = base.$extends(makeScopedExtension(tenantId));
  return extended.$transaction(async (tx) => {
    // transaction-local GUC: RLS policies scope every statement to this tenant; resets
    // on commit/rollback so it cannot leak to the next request on a pooled connection.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
    const db = tx as unknown as ScopedDb;
    if (ctx.role === "SUPER_ADMIN") await requireTenantExists(db, tenantId);
    return fn(db);
  }, SCOPED_TX_OPTIONS);
}

export async function runScoped<T>(
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return runScopedOn(basePrisma, ctx, fn);
}

// NOTE: audited cross-tenant / fleet path. Sets app.is_super_admin so RLS allows all
// rows (incl. tenant_id NULL audit rows and creating new tenants where WITH CHECK could
// not otherwise pass). Caller must have role SUPER_ADMIN; enforce at the call site.
export async function asSuperAdminOn<T>(
  base: TransactionCapable,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'on', true)`;
    return fn(tx as unknown as ScopedDb);
  }, SCOPED_TX_OPTIONS);
}

export async function asSuperAdmin<T>(
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return asSuperAdminOn(basePrisma, fn);
}
