import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { AuditAction } from "@/lib/audit/actions";
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
  // Keyset on `(created_at, id)`, which is also the order the page is read in. See `AuditCursor`
  // below for why it is both columns and not either one alone.
  cursor?: AuditCursor;
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
  // Pass back as `cursor` for the next (older) page; null when there are no more rows. Opaque:
  // `<ISO instant>|<id>`, and callers are not to build one (see `parseAuditCursor`).
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
    // NOTE: the row-comparison `(created_at, id) < (t, i)`, spelled the way Prisma can express it.
    // Measured against the tuple form on the same probe: identical plans, 45 buffers against 39 for
    // a tenant and 5 against 5 for `all` -- so this costs nothing, and it keeps the predicate inside
    // the same `where` the list and the export already share.
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
    // The pre-#530 bound, ANDed with the keyset above rather than replacing it: the walk is ordered
    // the new way and cut where the old one stopped. See `AuditCursor.beforeId`.
    ...(opts.cursor?.beforeId != null
      ? { id: { lt: opts.cursor.beforeId } }
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
    nextCursor: hasMore
      ? nextAuditCursor(page[page.length - 1], opts.cursor?.beforeId ?? null)
      : null,
    latestAt: latest._max.createdAt?.toISOString() ?? null,
  };
}

// THE PAGE'S POSITION, AS THE TWO COLUMNS IT IS ORDERED BY (issue #530).
//
// It used to be the id alone, and that was cheap to say and expensive to run: `created_at` was a
// plain predicate over a walk ordered by `id`, so a window that is not the newest one made Postgres
// walk the primary key backwards discarding everything outside it. Measured on a 500k-row probe with
// this table's own indexes, a 30-day window 80 days back: 9,277 buffers and 24.3 ms for a tenant,
// 9,237 and 38.6 ms for `all`, throwing away 448,000 rows to collect 51. Ordering by the column the
// window is cut on turns the same question into a range scan of an index that is already sorted the
// way the page is read: 39 buffers and 0.15 ms, 5 and 0.02 ms. No new index -- the ones the table
// already has serve it once the ORDER BY matches them.
//
// The id STAYS, as the tie-break, because `created_at` is not unique and is not the database's:
// Prisma sends the value from the Node process on every insert (measured -- the column's
// `DEFAULT CURRENT_TIMESTAMP` never runs), so a burst can share a millisecond and two processes can
// disagree about the order. A keyset on the time alone would repeat a row of a tied pair or skip it.
export interface AuditKeyset {
  createdAt: Date;
  id: bigint;
}

export interface AuditCursor {
  // Where the last page stopped. Null on the FIRST page of a walk that began before #530, which
  // has a bound and no position yet.
  at: AuditKeyset | null;
  // THE PRE-#530 BOUND, AND IT RIDES TO THE END OF THE WALK.
  //
  // The previous release paged `id < X` under `ORDER BY id`, so a cursor it handed out means "every
  // row with id >= X is already on the caller's screen". That set is NOT a prefix of the new order:
  // `created_at` is written by the client (measured), so a row can carry a stamp older than a row
  // with a smaller id. Translating X into the `(created_at, id)` of row X therefore answers from a
  // different place -- every unseen row stamped ahead of X sits ahead of that tuple and is never
  // returned. Measured on the dev trail, one process and 75 rows: from id 88 the old walk owed 19
  // rows and the translated cursor returned 2, skipping all 19.
  //
  // Kept as a bound instead, and carried, the page is ordered the new way and cut the old way,
  // which enumerates exactly what the old walk still owed: nothing skipped, nothing repeated.
  // Dropping it after the first page would stop skipping and start repeating, because the pages
  // that follow would be keyed on the tuple alone and reach back into rows already shown.
  //
  // THE OTHER HALF OF THE OVERLAP CANNOT BE CLOSED FROM HERE: a container still on the old release
  // refuses the `<instant>|<id>` this one emits, because its own parser predates the format. That
  // is a 400 for the length of the drain, recoverable by reloading the page.
  //
  // TEMPORARY. Remove one release after #530 ships, together with the fleet index kept for the same
  // reason (docs/roadmap.md).
  beforeId: bigint | null;
}

// `<ISO instant>|<id>`. Opaque to callers by contract, readable on purpose when a support question
// is "which page was it on": a cursor nobody can read is one nobody can check.
const CURSOR_SEP = "|";

// The instant half, as `toISOString` spells it for a four-digit year that is not `0000`.
//
// THE SHAPE IS THE RANGE CHECK, and it is exhaustive rather than a list of bad spellings. Beyond
// four digits that method switches to the EXPANDED form (`-100000-…`, `+275760-…`), which is
// canonical JavaScript and reaches years no `timestamptz` holds; `0000` is a four-digit year the
// calendar Postgres uses does not have at all. Both are refused at bind time, which turns a
// malformed cursor into a 500 where this endpoint promises a 400.
//
// Swept rather than guessed: every one of the 10,000 four-digit years was built, round-tripped and
// bound against Postgres, and `0000` is the only one it refuses. So four digits minus that year IS
// the set the column accepts, and the canonical round trip below already rules out dates that do not
// exist inside it -- there is no third case for a later reader to discover.
const CURSOR_INSTANT = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeAuditCursor(
  at: AuditKeyset,
  beforeId: bigint | null = null,
): string {
  const head = `${at.createdAt.toISOString()}${CURSOR_SEP}${at.id}`;
  return beforeId === null ? head : `${head}${CURSOR_SEP}${beforeId}`;
}

// Returns null for anything that is not one of ours.
//
// A BARE ID IS READ AS A BOUND, NOT AS A POSITION, which is the distinction round 1 of this PR's
// review was about and round 9 sharpened: reading the number as the new key answers from a different
// place in the trail under a pager that goes on saying "Page 2", and so does translating it into
// that row's instant. As the old query's own `id <` bound it answers from the same place, and it is
// the only reading of the three that does. See `AuditCursor.beforeId`.
//
// No lookup, so no scope and no database: the bound is a number the trail filter then applies on
// top of. An id naming no row, or another tenant's, is a bound that simply matches nothing -- which
// is what the previous release did with it too, and it leaves no way to ask this endpoint whether
// some id exists.
export function parseAuditCursor(raw: string): AuditCursor | null {
  const parts = raw.split(CURSOR_SEP);
  if (parts.length === 1) {
    const bound = parseDbId(parts[0] ?? "");
    return bound !== null && bound > 0n ? { at: null, beforeId: bound } : null;
  }
  if (parts.length > 3) return null;
  const head = parts[0] as string;
  const when = new Date(head);
  // CANONICAL OR NOTHING, checked by round trip against the exact spelling this codec emits.
  // `new Date` is not a validator: it ROLLS FORWARD a date that does not exist (`2026-02-30` becomes
  // March 2nd, so the walk resumes at an instant nobody asked for and skips whatever lies between),
  // and it accepts forms with no offset -- `Sep 4 2026`, `2026-09-04T12:00` -- by reading them in the
  // SERVER'S OWN ZONE, which measured three hours off here and would make one cursor name different
  // instants on two deployments. Six of seven such spellings were accepted before this line.
  if (!CURSOR_INSTANT.test(head)) return null;
  if (Number.isNaN(when.getTime()) || when.toISOString() !== head) return null;
  // `parseDbId` and not a `BigInt` cast: it is the one bounded parse in the tree, so the id half of
  // a cursor is held to the same range as an id arriving anywhere else. A cast would take a
  // 40-digit string and hand Postgres a value it answers with a 500 at bind time.
  const id = parseDbId(parts[1] ?? "");
  if (id === null || id <= 0n) return null;
  let beforeId: bigint | null = null;
  if (parts.length === 3) {
    beforeId = parseDbId(parts[2] as string);
    if (beforeId === null || beforeId <= 0n) return null;
  }
  return { at: { createdAt: when, id }, beforeId };
}

function nextAuditCursor(
  last: AuditKeyset | undefined,
  beforeId: bigint | null,
): string | null {
  return last ? encodeAuditCursor(last, beforeId) : null;
}
