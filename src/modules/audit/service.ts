import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { AuditAction } from "@/lib/audit/actions";
import { canonicalAuditAction } from "@/lib/audit/actions";
import type { AuditScope } from "@/lib/audit/scope";
import { parseDbId } from "@/lib/db-id";
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

// Records a mutation from INSIDE the service that performs it, in the caller's own transaction, so it
// covers every door (MCP tools and REST controllers reach the same functions) and a lost row means a
// lost change. The actor comes from the context, never from an argument: a caller that could pass its
// own could attribute a change to somebody else.
export async function auditMutation(
  db: ScopedDb,
  ctx: TenantContext,
  entry: Omit<AuditEntry, "actorId" | "actorType">,
): Promise<void> {
  await auditMutationOn(db, ctx, ctx.tenantId, entry);
}

// The same record, for a mutation whose SUBJECT is not the tenant the actor is operating as:
// `tenantId` is the trail of the row that CHANGED. A fleet-level change is `null` (keying on the
// context would file it under whichever tenant the header named), and a SUPER_ADMIN can write a tenant
// other than the selected one. `null` rows are also the only ones that survive their tenant: audit
// rows cascade on tenant delete, so a `tenant.delete` keyed on its own tenant would erase itself.
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

// Whether a projected change is a change at all. The trail records changes, and several editors
// PATCH their whole form on every save. It answers only for what the PROJECTION holds, so a service
// whose projection cannot show a change (a value stored encrypted) carries its own marker, as the
// alert-channel URL does in `channels.ts`.
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
  // How the actor authenticated: what separates a change made at the console from one made by a
  // token.
  actorType?: ActorType;
  actorId?: bigint;
  // Both bounds inclusive, matching the Logs page's own since/until.
  since?: Date;
  until?: Date;
}

export interface ListAuditOpts extends AuditFilterOpts {
  limit?: number;
  // Keyset on `(created_at, id)`, which is also the order the page is read in. See `AuditCursor`
  // below for why it is both columns and not either one alone.
  cursor?: AuditCursor;
  // WHICH TRAIL, and it is a question rather than a filter. `fleet` and `all` are a different query:
  // rows with no tenant are unreachable from the tenant read (NULL satisfies no RLS comparison), so
  // the widening is a role change into the fleet role, and that is SUPER_ADMIN's alone.
  scope?: AuditScope;
}

export interface AuditPage {
  entries: AuditLogItem[];
  // Pass back as `cursor` for the next (older) page; null when there are no more rows. Opaque:
  // `<ISO instant>|<id>`, and callers are not to build one (see `parseAuditCursor`).
  nextCursor: string | null;
  // The newest row IN THE WHOLE TRAIL, past any filter, and null when the trail is empty. Compared
  // against a record's own updatedAt, it tells the operator a change happened that nothing here
  // describes. The greatest timestamp, not the greatest id's: `createdAt` is written by the client, so
  // a later commit can carry an earlier stamp.
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

// The operator's filter alone, shared by every reader so an export cannot answer a different question
// than the list did. The cursor is NOT here: it is where the reader is, not what it asked for, and a
// one-shot dump would silently start halfway down.
export function buildAuditWhere(
  opts: AuditFilterOpts,
): Prisma.AuditLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (opts.since) createdAt.gte = opts.since;
  if (opts.until) createdAt.lte = opts.until;
  return {
    // Through the redirect, so a reader who learned a name before it was renamed still finds the
    // rows. THE ONLY FUNNEL: the page, the export and the MCP door all arrive here.
    ...(opts.action ? { action: canonicalAuditAction(opts.action) } : {}),
    ...(opts.actorType ? { actorType: opts.actorType } : {}),
    ...(opts.actorId !== undefined ? { actorId: opts.actorId } : {}),
    ...(opts.since || opts.until ? { createdAt } : {}),
  };
}

// WHICH TRAIL, and who may ask for it. Refused and never narrowed: a scope that quietly answered with
// the caller's own rows would be a silent omission wearing the name of the fix. Kept separate from the
// operator's filter because `latestAt` is the newest row of the trail PAST ANY FILTER.
export function auditTrailFor(
  ctx: TenantContext,
  scope: AuditScope,
): Prisma.AuditLogWhereInput {
  if (scope !== "tenant" && ctx.role !== "SUPER_ADMIN") {
    throw new ForbiddenError(
      "Reading the fleet trail requires a super admin",
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
    // NOTE: the row-comparison `(created_at, id) < (t, i)`, spelled the way Prisma can express it
    // (same plan as the tuple form), so the predicate stays inside the shared `where`.
    ...(opts.cursor?.at
      ? {
          OR: [
            { createdAt: { lt: opts.cursor.at.createdAt } },
            {
              createdAt: opts.cursor.at.createdAt,
              id: { lt: opts.cursor.at.id },
            },
          ],
        }
      : {}),
  };
  const scope = opts.scope ?? "tenant";
  const trail = auditTrailFor(ctx, scope);
  const read = async (db: ScopedDb) => ({
    rows: await db.auditLog.findMany({
      where: { ...trail, ...where },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
    nextCursor: hasMore ? nextAuditCursor(page[page.length - 1]) : null,
    latestAt: latest._max.createdAt?.toISOString() ?? null,
  };
}

// The page's position, as the two columns it is ordered by. Ordering by `created_at` makes a window
// cut on it a range scan of an existing index instead of a backward walk of the primary key. The id is
// the tie-break: `created_at` is not unique and is sent by the Node process (the column's DEFAULT
// never runs), so a keyset on the time alone would repeat or skip a row of a tied pair.
export interface AuditKeyset {
  createdAt: Date;
  id: bigint;
}

export interface AuditCursor {
  // Where the last page stopped. Always present: a cursor IS a position. A bare id is not one (a row
  // can carry a stamp older than a row with a smaller id), so it is a malformed cursor and gets a 400.
  at: AuditKeyset;
}

// `<ISO instant>|<id>`. Opaque to callers by contract, readable on purpose when a support question
// is "which page was it on": a cursor nobody can read is one nobody can check.
const CURSOR_SEP = "|";

// The instant half, as `toISOString` spells it for a four-digit year that is not `0000`. The shape is
// the range check: past four digits `toISOString` uses the expanded form, reaching years no
// `timestamptz` holds, and `0000` is the one four-digit year Postgres refuses. Both would fail at bind
// time, turning a malformed cursor into a 500 where this endpoint promises a 400.
const CURSOR_INSTANT = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeAuditCursor(at: AuditKeyset): string {
  return `${at.createdAt.toISOString()}${CURSOR_SEP}${at.id}`;
}

// Returns null for anything that is not one of ours, a bare id included (see `AuditCursor.at`).
export function parseAuditCursor(raw: string): AuditCursor | null {
  const parts = raw.split(CURSOR_SEP);
  if (parts.length !== 2) return null;
  const head = parts[0] as string;
  const when = new Date(head);
  // NOTE: canonical or nothing, checked by round trip. `new Date` rolls a nonexistent date forward
  // (`2026-02-30` becomes March 2nd, skipping rows) and reads offset-less forms in the server's own
  // zone, so one cursor would name different instants on two deployments.
  if (!CURSOR_INSTANT.test(head)) return null;
  if (Number.isNaN(when.getTime()) || when.toISOString() !== head) return null;
  // `parseDbId` and not a `BigInt` cast: it is the one bounded parse in the tree, so the id half of
  // a cursor is held to the same range as an id arriving anywhere else. A cast would take a
  // 40-digit string and hand Postgres a value it answers with a 500 at bind time.
  const id = parseDbId(parts[1] ?? "");
  if (id === null || id <= 0n) return null;
  return { at: { createdAt: when, id } };
}

function nextAuditCursor(last: AuditKeyset | undefined): string | null {
  return last ? encodeAuditCursor(last) : null;
}
