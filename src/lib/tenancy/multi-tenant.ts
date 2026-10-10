import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  ActiveTenantNotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import type { ScopedDb, TenantContext } from "./context";
import { FLEET_ROLE_FN } from "./fleet-role";

// The closure-extended `$extends` client is not the bare PrismaClient type, but it
// still exposes `$transaction`. Accept anything transaction-capable for the *On helpers so
// tests can pass their own client without depending on the (mockable) singleton.
type TransactionCapable = Pick<PrismaClient, "$extends" | "$transaction">;

// Models that carry a tenant_id we auto-inject on write. Excludes global/identity
// tables (User, AuditLog, McpOAuth*) and Tenant (no tenant_id column). RLS is the hard
// boundary; this extension only supplies tenant_id on insert (so WITH CHECK passes and
// callers need not pass it) and overrides any caller-supplied tenant_id (anti-spoof).
const TENANT_SCOPED_MODELS = new Set<string>([
  "Appointment",
  "ChatwootInstance",
  "ChatwootWebhookDelivery",
  "Inbox",
  "InboxObserver",
  "Contact",
  "ContactAuthGrant",
  "Conversation",
  "MessageReplyClaim",
  "AgentTurnDelivery",
  "ReplyDispensal",
  "Agent",
  "BusinessHours",
  "KnowledgeBase",
  "KnowledgeChunk",
  "KnowledgeSource",
  "ApprovalQueueItem",
  "VaultEntry",
  "ToolDefinition",
  "CodeToolDefinition",
  "McpServerConnection",
  "IntegrationInstance",
  "AgentToolSelection",
  "IntegrationExternalRef",
  "InboundDelivery",
  "ConversionEvent",
  "WebhookSubscription",
  "OutboundWebhookDelivery",
  "SchedulerJob",
  "SpendCostSnapshot",
  "ProactiveBreaker",
  "UnpricedModelAnnouncement",
  "DocumentTemplate",
  "IssuedDocument",
  "DocumentApprovalRequest",
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

// Closure-bound to a fixed tenantId (validated approach: reading the tenant from
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

// A SUPER_ADMIN's target is the only tenant id that reaches this boundary from OUTSIDE the process
// (the persisted `X-Tenant-Id`, an MCP `tenant` argument), so it can name a deleted tenant; unchecked,
// RLS scopes to an empty tenant, reads load empty defaults and writes fail as non-AppError Prisma
// errors ("something went wrong"). Same question and answer as MCP's `resolveTenantSelector`. A module
// that rebuilds a TENANT_ADMIN context around a bare id defeats this check, which is why
// `tests/modules/tenant-selector-entry-points.test.ts` fences the transports (docs/tenancy.md, rule 5).
// One statement inside the already-open transaction, rather than a transaction of its own on every
// fleet request at the boundary.
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
    // NOTE: same status and key as the MCP selector and `getTenant`, in a class of its own because
    // only this refusal is about the selector the CALLER WAS CARRYING, which the console must drop
    // (src/lib/console-params.ts).
    throw new ActiveTenantNotFoundError(tenantId);
  }
}

// No network/LLM await inside `fn`: the transaction pins a pooled connection and long I/O would
// exhaust the pool. That includes A SECOND POSTGRES (the LangGraph checkpointer has its own pool): a
// connection held idle-in-transaction across another pool's round-trips drains this one just the
// same. If `fn` awaits anything that is not this transaction, it does not belong. `...On` variants
// take the base client explicitly so integration tests can pass their own (real) client.

// Stated rather than inherited, although these ARE the Prisma defaults: a drained pool's two errors
// name exactly these numbers ("Unable to start a transaction in the given time" is `maxWait`, "expired
// transaction" is `timeout`), so naming them makes the budget greppable from the error. The other
// half is `DB_POOL_MAX`, usually the real culprit behind a `maxWait` error (docs/deploy.md).
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

// Audited cross-tenant / fleet path. Becomes the fleet role for the length of this transaction,
// which is what the `fleet_super_admin` policy on every table under RLS is written `TO`, so RLS
// allows all rows (incl. tenant_id NULL audit rows and creating new tenants). Caller must have role
// SUPER_ADMIN; enforce at the call site. The legacy `app.is_super_admin` GUC grants nothing, which
// `tests/lib/rls-policy-shape.test.ts` asserts.

// `set_config('role', ...)` rather than `SET LOCAL ROLE`: equally transaction-local, but it takes the
// role as an EXPRESSION, so the database resolves the name. `Prisma.raw` keeps the function CALL as
// SQL rather than a bind parameter; `FLEET_ROLE_FN` is a constant, never caller input.
export async function asSuperAdminOn<T>(
  base: TransactionCapable,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('role', ${Prisma.raw(FLEET_ROLE_FN)}, true)`;
    return fn(tx as unknown as ScopedDb);
  }, SCOPED_TX_OPTIONS);
}

export async function asSuperAdmin<T>(
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return asSuperAdminOn(basePrisma, fn);
}

// The transaction a mutation on a GLOBAL identity table (`users`, `invitations`, `mcp_oauth_*`, no
// RLS, scoped by a hand-written `where`) opens, at the reach of WHO is writing: a tenant admin gets
// the scoped one, a SUPER_ADMIN gets `asSuperAdmin`, the only mode that can write `tenant_id NULL`.
// Keyed on the ROLE, never the subject: choosing by the target's tenant would read it before the
// transaction locks the row, and a concurrent write could move it; the subject's tenant is read
// INSIDE, under the lock. For a SUPER_ADMIN no `app.tenant_id` is set, so tenant_id is not
// auto-injected, which is why this is not a general replacement for `runScopedOn`.
export async function asPrincipalOn<T>(
  base: TransactionCapable,
  ctx: TenantContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  if (ctx.role === "SUPER_ADMIN") return asSuperAdminOn(base, fn);
  return runScopedOn(base, ctx, fn);
}
