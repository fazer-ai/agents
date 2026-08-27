import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import type { ActorType } from "@/lib/tenancy/context";
import { truncForAudit } from "@/modules/audit/projection";

export interface AuditEntry {
  actorId?: bigint | null;
  // The same union `TenantContext` carries, and not a bare string: the value is written straight
  // into a column nothing validates, so a typo here is a row attributed to a door that does not
  // exist and it is only readable, never reportable.
  actorType?: ActorType;
  action: string;
  target?: string | null;
  // NOTE: before/after MUST be allowlist-sanitized by the caller — never secrets/PII in
  // the clear (the row is readable by tenant admins and, for tenant_id NULL rows, by
  // super admins). Pass only the safe projection.
  before?: unknown;
  after?: unknown;
}

// Appends an audit row. tenantId is explicit (the audit_logs table is excluded from
// auto-injection; tenant_id NULL = a fleet/global action visible only to SUPER_ADMIN).
// Call inside a runScoped tx (tenantId = that tenant) or an asSuperAdmin tx (any tenantId,
// incl. null) so the RLS WITH CHECK passes.
export async function recordAudit(
  db: ScopedDb,
  tenantId: bigint | null,
  entry: AuditEntry,
): Promise<void> {
  await db.auditLog.create({
    data: {
      tenantId,
      actorId: entry.actorId ?? null,
      actorType: entry.actorType ?? "user",
      action: entry.action,
      target: entry.target ?? null,
      // NOTE: nullable Json columns need Prisma.DbNull for SQL NULL (raw `null` is rejected).
      before:
        entry.before == null
          ? Prisma.DbNull
          : (entry.before as Prisma.InputJsonValue),
      after:
        entry.after == null
          ? Prisma.DbNull
          : (entry.after as Prisma.InputJsonValue),
    },
  });
}

// Records a mutation from INSIDE the service that performs it, in the caller's own transaction.
//
// The trail used to be written by the MCP transport, after the service it called had committed
// (`recordMcpAudit`). Two things follow from writing it here instead, and neither is available one
// layer up. It covers whichever door the mutation came through, because the MCP tools and the REST
// controllers reach the same functions — a change made in the console left no row at all. And it
// shares the mutation's transaction, so a lost row means a lost change: the second transaction the
// transport opened could fail on its own and leave the change with no record of who made it.
//
// The actor comes from the context and never from an argument: `userId` is the principal the request
// resolved, and `actorType` is how it authenticated. A caller that could pass its own would be able
// to attribute a change to somebody else.
export async function auditMutation(
  db: ScopedDb,
  ctx: TenantContext,
  entry: Omit<AuditEntry, "actorId" | "actorType">,
): Promise<void> {
  await recordAudit(db, ctx.tenantId, {
    ...entry,
    actorId: ctx.userId,
    actorType: ctx.actorType ?? "user",
    // Bounded here rather than at each call site: a service records its own rows, and the one that
    // forgets is the one whose projection carries a system prompt.
    before:
      entry.before === undefined ? undefined : truncForAudit(entry.before),
    after: entry.after === undefined ? undefined : truncForAudit(entry.after),
  });
}

export interface AuditLogItem {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorType: string;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

// Reads the audit log for the active tenant (RLS-scoped: a TENANT_ADMIN sees only their tenant's
// rows; fleet/global tenant_id NULL rows are visible only via the audited asSuperAdmin path, not
// here). before/after were allowlist-sanitized at write time.
export async function listAudit(
  ctx: TenantContext,
  opts: { limit?: number; action?: string } = {},
  base: PrismaClient = basePrisma,
): Promise<AuditLogItem[]> {
  assertUsableCount(opts.limit, "limit");
  const take = Math.min(opts.limit ?? 100, 500);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.auditLog.findMany({
      where: opts.action ? { action: opts.action } : {},
      orderBy: { id: "desc" },
      take,
      select: {
        id: true,
        tenantId: true,
        actorId: true,
        actorType: true,
        action: true,
        target: true,
        before: true,
        after: true,
        createdAt: true,
      },
    }),
  );
  return rows.map((r) => ({
    id: String(r.id),
    tenantId: r.tenantId === null ? null : String(r.tenantId),
    actorId: r.actorId === null ? null : String(r.actorId),
    actorType: r.actorType,
    action: r.action,
    target: r.target,
    before: r.before,
    after: r.after,
    createdAt: r.createdAt.toISOString(),
  }));
}
