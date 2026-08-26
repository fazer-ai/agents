import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";

export interface AuditEntry {
  actorId?: bigint | null;
  // user | mcp | system
  actorType?: string;
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
