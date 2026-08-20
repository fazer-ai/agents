import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { TenantTargetRequiredError } from "@/lib/errors";
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
  "Quote",
  "Experiment",
  "PromptVariantAssignment",
  "LlmUsage",
  "ExecutionLog",
  "AlertChannel",
  "AlertDelivery",
  "ApiKey",
  "AttendanceSummary",
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

// NOTE: no network/LLM await inside `fn` — the transaction pins a pooled connection and
// long I/O would exhaust the pool. Keep fn to DB work; do network I/O outside.
//
// `...On` variants take the base client explicitly so integration tests can pass their own
// (real) client instead of the singleton, which unit tests mock globally.
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
    return fn(tx as unknown as ScopedDb);
  });
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
  });
}

export async function asSuperAdmin<T>(
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return asSuperAdminOn(basePrisma, fn);
}
