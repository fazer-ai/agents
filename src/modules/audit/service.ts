import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { AuditAction } from "@/lib/audit/actions";
import type { AuditScope } from "@/lib/audit/scope";
import { ForbiddenError } from "@/lib/errors";
import { assertUsableCount } from "@/lib/query-param";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import type { ActorType } from "@/lib/tenancy/context";
import { truncForAudit } from "@/modules/audit/projection";

export interface AuditEntry {
  actorId?: bigint | null;
  // The same union `TenantContext` carries, and not a bare string: the value is written straight
  // into a column nothing validates, so a typo here is a row attributed to a door that does not
  // exist and it is only readable, never reportable.
  actorType?: ActorType;
  action: AuditAction;
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
  await auditMutationOn(db, ctx, ctx.tenantId, entry);
}

// The same record, for a mutation whose SUBJECT is not the tenant the actor is operating as.
//
// `tenantId` is which trail the row joins, and it answers to the row that CHANGED, not to the
// principal that changed it. Two shapes need it and the plain `auditMutation` gets both wrong:
//
// - A fleet-level change belongs to no tenant (`null`). Branding is global, and a SUPER_ADMIN with a
//   tenant selected in the console has a `ctx.tenantId`, so keying on the context would file a change
//   to the whole deployment under whichever tenant the header happened to name.
// - A SUPER_ADMIN may write a tenant OTHER than the selected one: `PATCH /v1/tenants/7` succeeds with
//   `X-Tenant-Id: 5`, because the update runs `asSuperAdmin` and never consults the context (measured).
//   The row belongs to 7.
//
// And `null` is not merely "no tenant": those rows are the only ones that SURVIVE the tenant. Every
// audit row is `ON DELETE CASCADE` on its tenant, so a `tenant.delete` recorded against the tenant it
// deletes is erased by the same statement, leaving the one act whose record matters most with no
// record at all (measured).
export async function auditMutationOn(
  db: ScopedDb,
  ctx: TenantContext,
  tenantId: bigint | null,
  entry: Omit<AuditEntry, "actorId" | "actorType">,
): Promise<void> {
  await recordAudit(db, tenantId, {
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

// Whether a projected change is a change at all.
//
// The trail records changes, and `docs/api-and-fleet.md` states that as a property of the trail
// rather than of one family: more than one editor in this console PATCHes its whole form on every
// save, so a row per apply would fill the trail with saves that moved nothing. It lives here because
// the projections it compares are built to be compared — same literal, same key order on both sides.
//
// It answers for what the PROJECTION holds and nothing else, so a service whose projection cannot
// show a change (a value stored encrypted, say) has to carry its own marker for it. The alert-channel
// URL is the case, and `channels.ts` says how.
export function projectionMoved(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
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

// The filter surface the page's controls project onto, shared by the list and the export so the two
// cannot drift. Pagination and scope are deliberately NOT here: see `buildAuditWhere`.
export interface AuditFilterOpts {
  action?: string;
  // How the actor authenticated. Its value is one word on every row until the write side of #306
  // lands, which is exactly why it is worth filtering by afterwards: it is what separates a change
  // made at the console from one made by a token.
  actorType?: ActorType;
  actorId?: bigint;
  // Both bounds inclusive, matching the Logs page's own since/until.
  since?: Date;
  until?: Date;
}

export interface ListAuditOpts extends AuditFilterOpts {
  limit?: number;
  // Keyset: rows with id < cursor. On the ID and never on the time, because `created_at` here is
  // written by the CLIENT and not by the database (measured: rows appended inside one transaction
  // come back with stamps LATER than that transaction's own `now()`, and differing from each
  // other). At millisecond resolution a tie between two rows of one burst is ordinary, and nothing
  // makes the column agree with insertion order in the first place. So a time cursor over it can
  // repeat one of a tied pair or skip it; the id is the only monotonic key this table has.
  cursor?: bigint;
  // WHICH TRAIL, and it is a question rather than a filter.
  //
  // `tenant` is the RLS read every caller has always had. `fleet` and `all` are a DIFFERENT QUERY:
  // the rows keyed to no tenant are not filtered out of the tenant read, they are unreachable from
  // it, because the policy is `tenant_id = current_setting('app.tenant_id')` and NULL satisfies no
  // comparison. Reaching them means entering the fleet role, which is the only role the
  // `fleet_super_admin` policy (`USING true`) admits — so the widening is a role change, and a role
  // change is SUPER_ADMIN's alone.
  scope?: AuditScope;
}

export interface AuditPage {
  entries: AuditLogItem[];
  // Pass back as `cursor` for the next (older) page; null when there are no more rows.
  nextCursor: string | null;
  // The newest row IN THE WHOLE TRAIL, past any filter, and null when the trail is empty.
  //
  // It is the one number that says something about what the trail does NOT hold: compared against a
  // record's own updatedAt, it is how an operator learns that a change happened which nothing here
  // can describe. Narrowed to the filter it would report the newest row the operator happens to be
  // looking at, which answers a question nobody asked and reads like the answer to this one.
  //
  // The greatest TIMESTAMP, not the timestamp of the greatest id. The two disagree here: `createdAt`
  // is written by the client (measured), so a row that committed later can carry an earlier stamp,
  // and this number is compared against a record's own `updatedAt` — a comparison between times has
  // to be answered by the largest time or it reports a covered record as newer than the trail.
  latestAt: string | null;
}

// The columns a trail row is read by. Hoisted because the read is now assembled once and run under
// one of two roles, and a select that drifted between the two would answer differently depending on
// which trail was asked for.
const AUDIT_SELECT = {
  id: true,
  tenantId: true,
  actorId: true,
  actorType: true,
  action: true,
  target: true,
  before: true,
  after: true,
  createdAt: true,
} as const;

// Reads the audit log. `before`/`after` were allowlist-sanitized at write time.
//
// The default is the tenant's own trail, RLS-scoped, which is what every caller had before #520.
// The two wider scopes enter the fleet role and are refused outright to anyone but a SUPER_ADMIN:
// REFUSED AND NOT NARROWED, because a scope that quietly answered with the caller's own rows would
// be the same silent omission this exists to end, wearing the name of the fix.
// THE OPERATOR'S FILTER, alone: what the page's controls say, and nothing about which trail or where
// the page is. Extracted so a second reader cannot answer a different question than the list did --
// an export whose rows do not match the screen is worse than no export, because it is quoted.
//
// The cursor is NOT here, and that is the seam: it is where the reader is, not what it asked for, so
// a one-shot dump has no use for it and would silently start halfway down.
export function buildAuditWhere(
  opts: AuditFilterOpts,
): Prisma.AuditLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (opts.since) createdAt.gte = opts.since;
  if (opts.until) createdAt.lte = opts.until;
  return {
    ...(opts.action ? { action: opts.action } : {}),
    ...(opts.actorType ? { actorType: opts.actorType } : {}),
    ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
    ...(opts.since || opts.until ? { createdAt } : {}),
  };
}

// WHICH TRAIL, and who may ask for it. Refused and never narrowed: a scope that quietly answered
// with the caller's own rows would be the omission #520 exists to end, wearing the name of the fix.
// Returns the trail's own predicate, kept SEPARATE from the operator's filter above because
// `latestAt` is documented as the newest row of the trail PAST ANY FILTER -- it takes this one and
// not the other.
export function auditTrailFor(
  ctx: TenantContext,
  scope: AuditScope,
): Prisma.AuditLogWhereInput {
  if (scope !== "tenant" && ctx.role !== "SUPER_ADMIN") {
    throw new ForbiddenError(
      "Reading the fleet trail requires SUPER_ADMIN",
      "errors.auditScopeForbidden",
    );
  }
  return scope === "fleet" ? { tenantId: null } : {};
}

// Runs a read under the role the scope requires: the tenant's own RLS transaction, or the fleet role
// that the `fleet_super_admin` policy (`USING true`) is the only admitter of. Both readers go through
// here so neither can reach a trail by a route the other does not have.
export function readInScope<T>(
  base: PrismaClient,
  ctx: TenantContext,
  scope: AuditScope,
  read: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return scope === "tenant"
    ? runScopedOn(base, ctx, read)
    : asSuperAdminOn(base, read);
}

export async function listAudit(
  ctx: TenantContext,
  opts: ListAuditOpts = {},
  base: PrismaClient = basePrisma,
): Promise<AuditPage> {
  assertUsableCount(opts.limit, "limit");
  const take = Math.min(opts.limit ?? 100, 500);
  const where: Prisma.AuditLogWhereInput = {
    ...buildAuditWhere(opts),
    ...(opts.cursor !== undefined ? { id: { lt: opts.cursor } } : {}),
  };
  const scope = opts.scope ?? "tenant";
  const trail = auditTrailFor(ctx, scope);
  const read = async (db: ScopedDb) => ({
    rows: await db.auditLog.findMany({
      where: { ...trail, ...where },
      orderBy: { id: "desc" },
      // NOTE: One extra row is what tells the caller a next page exists, without a second count over
      // a table that only grows.
      take: take + 1,
      select: AUDIT_SELECT,
    }),
    latest: await db.auditLog.aggregate({
      _max: { createdAt: true },
      where: trail,
    }),
  });
  const { rows, latest } = await readInScope(base, ctx, scope, read);
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    entries: page.map((r) => ({
      id: String(r.id),
      tenantId: r.tenantId === null ? null : String(r.tenantId),
      actorId: r.actorId === null ? null : String(r.actorId),
      actorType: r.actorType,
      action: r.action,
      target: r.target,
      before: r.before,
      after: r.after,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? String(page[page.length - 1]?.id) : null,
    latestAt: latest._max.createdAt?.toISOString() ?? null,
  };
}
