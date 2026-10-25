import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { PROVIDERS_HONORING_BASE_URL } from "@/graph/model-config";
import { parseDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { clipText, unstorableCodePoints } from "@/lib/text";
import { redactEndpoint } from "@/modules/audit/projection";
import { auditMutation } from "@/modules/audit/service";
import { retireJobsByDedupeKeyOn } from "@/modules/scheduler/service";
import {
  requireVaultRefFor,
  tryResolveApiKeyEntry,
} from "@/modules/vault/service";
import {
  monitorRoundDedupeKey,
  monitorSweepDedupeKey,
  syncMonitorRound,
} from "./arm";
import { runFlagsStep } from "./flags";
import {
  mergeOccurrences,
  OCCURRENCES_DEFAULTS,
  type OccurrencesConfig,
  type OccurrencesPatch,
  occurrencesSettingsSchema,
  readMonitorConfig,
} from "./settings";

// THE ACCOUNT'S OCCURRENCE MONITORS (docs/occurrences.md, "Monitors"). Each monitor is a row with a
// name and the configuration an admin chooses; its readings, themes, canonicals and rounds are rows
// of their own, keyed on the monitor, so two monitors never share one. Every write takes the
// account's monitor lock first, so the cap on monitors and the rule on Chatwoot attributes, which
// both read the account's other monitors, are checked against what is there when the write commits.

export const MONITORS_MAX = 10;
export const MONITOR_NAME_MAX = 80;
// The name the account's first monitor gets: the one it had before there were several, and the one a
// path that names no monitor creates on its first save.
export const FIRST_MONITOR_NAME = "Ocorrências";

// A monitor as its rows hold it. `config` is the lenient read, so a damaged block is OFF.
export interface Monitor {
  id: bigint;
  tenantId: bigint;
  name: string;
  position: number;
  config: OccurrencesConfig;
}

// What every read path and every step is keyed on.
export interface MonitorKey {
  tenantId: bigint;
  monitorId: bigint;
}

export const keyOf = (m: Monitor): MonitorKey => ({
  tenantId: m.tenantId,
  monitorId: m.id,
});

export interface MonitorView {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  inboxIds: string[];
  // The newest round, and what deleting the monitor takes with it.
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
  } | null;
  openThemes: number;
  runs: number;
}

function tenantOf(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return ctx.tenantId;
}

const lockKey = (tenantId: bigint) => `occurrence-monitors:${tenantId}`;

type MonitorRow = {
  id: bigint;
  tenantId: bigint;
  name: string;
  position: number;
  config: unknown;
};

const monitorOf = (r: MonitorRow): Monitor => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  position: r.position,
  config: readMonitorConfig(r.config),
});

const SELECT = {
  id: true,
  tenantId: true,
  name: true,
  position: true,
  config: true,
} as const;

const notFound = () =>
  new AppError("monitor not found", 404, "errors.occurrenceMonitorNotFound");

// The account's monitors, first first.
export async function monitorsOn(
  db: ScopedDb,
  tenantId: bigint,
): Promise<Monitor[]> {
  const rows = await db.occurrenceMonitor.findMany({
    where: { tenantId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: SELECT,
  });
  return rows.map(monitorOf);
}

export async function monitorOn(
  db: ScopedDb,
  tenantId: bigint,
  monitorId: bigint,
): Promise<Monitor | null> {
  const row = await db.occurrenceMonitor.findFirst({
    where: { id: monitorId, tenantId },
    select: SELECT,
  });
  return row ? monitorOf(row) : null;
}

// The account's first monitor, the one a path that names none answers for; null when it has none.
export async function firstMonitorOn(
  db: ScopedDb,
  tenantId: bigint,
): Promise<Monitor | null> {
  const row = await db.occurrenceMonitor.findFirst({
    where: { tenantId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: SELECT,
  });
  return row ? monitorOf(row) : null;
}

// The monitor a request names, or the account's first when it names none. A named id of no monitor
// of this account is a 404, whatever account it belongs to. `null` when none is named and the account
// has none yet: the caller answers with the defaults.
export async function resolveMonitor(
  ctx: TenantContext,
  monitorId: bigint | undefined,
  base: PrismaClient = basePrisma,
): Promise<Monitor | null> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, async (db) => {
    if (monitorId === undefined) return firstMonitorOn(db, tenantId);
    const m = await monitorOn(db, tenantId, monitorId);
    if (!m) throw notFound();
    return m;
  });
}

export async function requireMonitor(
  ctx: TenantContext,
  monitorId: bigint,
  base: PrismaClient = basePrisma,
): Promise<Monitor> {
  const m = await resolveMonitor(ctx, monitorId, base);
  if (!m) throw notFound();
  return m;
}

// A request's monitor id: a row id, or a 404 like an id of no monitor.
export function monitorIdOf(raw: string): bigint {
  const id = parseDbId(raw);
  if (id === null) throw notFound();
  return id;
}

export async function listMonitors(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<MonitorView[]> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, async (db) => {
    const monitors = await monitorsOn(db, tenantId);
    return viewsOn(db, monitors);
  });
}

async function viewsOn(
  db: ScopedDb,
  monitors: Monitor[],
): Promise<MonitorView[]> {
  if (monitors.length === 0) return [];
  const ids = monitors.map((m) => m.id);
  const [themes, runs, last] = await Promise.all([
    db.occurrenceTheme.groupBy({
      by: ["monitorId"],
      where: { monitorId: { in: ids }, status: "open" },
      _count: { _all: true },
    }),
    db.occurrenceRun.groupBy({
      by: ["monitorId"],
      where: { monitorId: { in: ids } },
      _count: { _all: true },
    }),
    // Each monitor's newest round only, in the database: on the (monitor_id, started_at) index.
    db.$queryRaw<
      Array<{
        monitor_id: bigint;
        started_at: Date;
        finished_at: Date | null;
        status: string;
      }>
    >`
      SELECT DISTINCT ON (monitor_id) monitor_id, started_at, finished_at, status
        FROM occurrence_runs
       WHERE monitor_id = ANY(${ids}::bigint[])
       ORDER BY monitor_id, started_at DESC, id DESC`,
  ]);
  const themesOf = new Map(themes.map((t) => [t.monitorId, t._count._all]));
  const runsOf = new Map(runs.map((r) => [r.monitorId, r._count._all]));
  const lastOf = new Map(last.map((r) => [r.monitor_id, r]));
  return monitors.map((m) => {
    const r = lastOf.get(m.id);
    return {
      id: String(m.id),
      name: m.name,
      position: m.position,
      enabled: m.config.enabled,
      inboxIds: m.config.inboxIds,
      lastRun: r
        ? {
            startedAt: r.started_at.toISOString(),
            finishedAt: r.finished_at?.toISOString() ?? null,
            status: r.status,
          }
        : null,
      openThemes: themesOf.get(m.id) ?? 0,
      runs: runsOf.get(m.id) ?? 0,
    };
  });
}

export async function getMonitorView(
  ctx: TenantContext,
  monitorId: bigint,
  base: PrismaClient = basePrisma,
): Promise<MonitorView> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, async (db) => {
    const m = await monitorOn(db, tenantId, monitorId);
    if (!m) throw notFound();
    const [view] = await viewsOn(db, [m]);
    return view as MonitorView;
  });
}

// A monitor's name: trimmed, 1 to MONITOR_NAME_MAX characters, storable, unique in the account.
function checkedName(raw: unknown): string {
  if (typeof raw !== "string")
    throw new AppError(
      "occurrences: a monitor needs a name",
      422,
      "errors.occurrenceMonitorNameRequired",
      undefined,
      "name",
    );
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0)
    throw new AppError(
      "occurrences: a monitor needs a name",
      422,
      "errors.occurrenceMonitorNameRequired",
      undefined,
      "name",
    );
  if (name.length > MONITOR_NAME_MAX)
    throw new AppError(
      `occurrences: a monitor's name is at most ${MONITOR_NAME_MAX} characters`,
      422,
      "errors.occurrenceMonitorNameTooLong",
      { max: MONITOR_NAME_MAX },
      "name",
    );
  if (unstorableCodePoints(name) !== null)
    throw new AppError(
      "occurrences: the monitor's name contains characters the database cannot store",
      422,
      "errors.occurrenceMonitorNameUnstorable",
      undefined,
      "name",
    );
  return name;
}

async function assertNameFree(
  db: ScopedDb,
  tenantId: bigint,
  name: string,
  except?: bigint,
): Promise<void> {
  const taken = await db.occurrenceMonitor.findFirst({
    where: {
      tenantId,
      name,
      ...(except === undefined ? {} : { NOT: { id: except } }),
    },
    select: { id: true },
  });
  if (taken)
    throw new AppError(
      `occurrences: a monitor named "${name}" already exists`,
      409,
      "errors.occurrenceMonitorNameTaken",
      { name },
      "name",
    );
}

// The first free name from `base`: itself, then "base (2)", "base (3)".
async function freeName(
  db: ScopedDb,
  tenantId: bigint,
  base: string,
): Promise<string> {
  const names = new Set(
    (
      await db.occurrenceMonitor.findMany({
        where: { tenantId },
        select: { name: true },
      })
    ).map((r) => r.name),
  );
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const name = `${clipText(base, MONITOR_NAME_MAX - suffix.length)}${suffix}`;
    if (!names.has(name)) return name;
  }
}

async function assertRoom(db: ScopedDb, tenantId: bigint): Promise<void> {
  const count = await db.occurrenceMonitor.count({ where: { tenantId } });
  if (count >= MONITORS_MAX)
    throw new AppError(
      `occurrences: an account has at most ${MONITORS_MAX} monitors; delete one to create another`,
      422,
      "errors.occurrenceMonitorLimit",
      { max: MONITORS_MAX },
    );
}

async function nextPosition(db: ScopedDb, tenantId: bigint): Promise<number> {
  const last = await db.occurrenceMonitor.aggregate({
    where: { tenantId },
    _max: { position: true },
  });
  return (last._max.position ?? -1) + 1;
}

// The block as the audit trail keeps it, forever: the model's endpoint as its scheme and host only
// (docs/api-and-fleet.md, the audit URL rule), since a URL can carry a key in its userinfo, path or
// query.
function configForAudit(cfg: OccurrencesConfig) {
  return {
    ...cfg,
    model:
      cfg.model === null
        ? null
        : {
            ...cfg.model,
            baseURL:
              cfg.model.baseURL === null
                ? null
                : redactEndpoint(cfg.model.baseURL),
          },
  };
}

const auditOf = (m: {
  id: bigint;
  name: string;
  config: OccurrencesConfig;
}) => ({
  id: String(m.id),
  name: m.name,
  config: configForAudit(m.config),
});

async function createOn(
  db: ScopedDb,
  ctx: TenantContext,
  tenantId: bigint,
  name: string,
  config: OccurrencesConfig,
): Promise<Monitor> {
  await assertRoom(db, tenantId);
  await assertNameFree(db, tenantId, name);
  const row = await db.occurrenceMonitor.create({
    data: {
      tenantId,
      name,
      config: config as unknown as Prisma.InputJsonValue,
      position: await nextPosition(db, tenantId),
    },
    select: SELECT,
  });
  const m = monitorOf(row);
  await auditMutation(db, ctx, {
    action: "occurrence_monitor.created",
    target: `occurrence_monitor:${m.id}`,
    after: auditOf(m),
  });
  return m;
}

// A new monitor, OFF, with the default configuration.
export async function createMonitor(
  ctx: TenantContext,
  input: { name: unknown },
  base: PrismaClient = basePrisma,
): Promise<MonitorView> {
  const tenantId = tenantOf(ctx);
  const name = checkedName(input.name);
  return runScopedOn(base, ctx, async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenantId)})::bigint)`;
    const m = await createOn(
      db,
      ctx,
      tenantId,
      name,
      structuredClone(OCCURRENCES_DEFAULTS),
    );
    const [view] = await viewsOn(db, [m]);
    return view as MonitorView;
  });
}

// A copy of the configuration only: OFF and with no inboxes, so it never reads a conversation twice
// by accident; its themes, canonicals and rounds start empty.
export async function duplicateMonitor(
  ctx: TenantContext,
  monitorId: bigint,
  input: { name?: unknown } = {},
  base: PrismaClient = basePrisma,
): Promise<MonitorView> {
  const tenantId = tenantOf(ctx);
  const named = input.name === undefined ? null : checkedName(input.name);
  return runScopedOn(base, ctx, async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenantId)})::bigint)`;
    const source = await monitorOn(db, tenantId, monitorId);
    if (!source) throw notFound();
    const name = named ?? (await freeName(db, tenantId, source.name));
    const m = await createOn(db, ctx, tenantId, name, {
      ...structuredClone(source.config),
      enabled: false,
      inboxIds: [],
    });
    const [view] = await viewsOn(db, [m]);
    return view as MonitorView;
  });
}

export async function renameMonitor(
  ctx: TenantContext,
  monitorId: bigint,
  input: { name: unknown },
  base: PrismaClient = basePrisma,
): Promise<MonitorView> {
  const tenantId = tenantOf(ctx);
  const name = checkedName(input.name);
  return runScopedOn(base, ctx, async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenantId)})::bigint)`;
    const m = await monitorOn(db, tenantId, monitorId);
    if (!m) throw notFound();
    await assertNameFree(db, tenantId, name, m.id);
    if (name !== m.name) {
      await db.occurrenceMonitor.update({
        where: { id: m.id },
        data: { name },
      });
      await auditMutation(db, ctx, {
        action: "occurrence_monitor.updated",
        target: `occurrence_monitor:${m.id}`,
        before: { name: m.name },
        after: { name },
      });
    }
    const [view] = await viewsOn(db, [{ ...m, name }]);
    return view as MonitorView;
  });
}

// Deletes the monitor and everything it read, and stops its rounds.
export async function deleteMonitor(
  ctx: TenantContext,
  monitorId: bigint,
  base: PrismaClient = basePrisma,
): Promise<{ deleted: true; openThemes: number; runs: number }> {
  const tenantId = tenantOf(ctx);
  return runScopedOn(base, ctx, async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenantId)})::bigint)`;
    // The round's own lock, so a reconcile in flight cannot arm the job again after it is cancelled.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`occurrence-round:${monitorId}`})::bigint)`;
    const m = await monitorOn(db, tenantId, monitorId);
    if (!m) throw notFound();
    const [view] = await viewsOn(db, [m]);
    // The round claimed right now too: its claim is bumped, so its reschedule is not written, and the
    // reading's copy to Chatwoot asks whether the monitor still exists before it writes (reading.ts).
    await retireJobsByDedupeKeyOn(
      db,
      tenantId,
      "OCCURRENCE_ROUND",
      monitorRoundDedupeKey(m.id),
    );
    await retireJobsByDedupeKeyOn(
      db,
      tenantId,
      "OCCURRENCE_SWEEP",
      monitorSweepDedupeKey(m.id),
    );
    await db.occurrenceMonitor.delete({ where: { id: m.id } });
    await auditMutation(db, ctx, {
      action: "occurrence_monitor.deleted",
      target: `occurrence_monitor:${m.id}`,
      before: auditOf(m),
    });
    return {
      deleted: true as const,
      openThemes: view?.openThemes ?? 0,
      runs: view?.runs ?? 0,
    };
  });
}

// The inboxes a write ADDS to the monitor exist in this account. One no agent receives is accepted:
// the reading sweeps it from Chatwoot every round (./sweep.ts). Asked by the write under its lock and
// by the MCP preview, so the two refuse the same block.
export async function assertOccurrencesInboxes(
  db: Pick<PrismaClient, "inbox">,
  tenantId: bigint,
  current: Pick<OccurrencesConfig, "inboxIds">,
  value: Pick<OccurrencesConfig, "inboxIds">,
): Promise<void> {
  const added = value.inboxIds.filter((id) => !current.inboxIds.includes(id));
  if (added.length === 0) return;
  const ids = added
    .map((id) => parseDbId(id))
    .filter((id): id is bigint => id !== null);
  const rows = await db.inbox.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true },
  });
  const byId = new Set(rows.map((r) => String(r.id)));
  for (const id of added) {
    if (!byId.has(id))
      throw new AppError(
        `occurrences: inboxIds names no inbox of this account (${id})`,
        422,
      );
  }
}

// Two monitors never write the same Chatwoot custom attribute on the same inbox: each would overwrite
// the other's value on every conversation they both read. Refused naming the monitor that already
// writes it. Asked under the account's monitor lock by the write, and by the MCP preview.
export async function assertAttributesFree(
  db: ScopedDb,
  tenantId: bigint,
  monitorId: bigint | null,
  value: Pick<OccurrencesConfig, "inboxIds" | "fields">,
): Promise<void> {
  const mine = value.fields.filter((f) => f.attribute).map((f) => f.key);
  if (mine.length === 0 || value.inboxIds.length === 0) return;
  for (const other of await monitorsOn(db, tenantId)) {
    if (other.id === monitorId) continue;
    const shared = value.inboxIds.filter((id) =>
      other.config.inboxIds.includes(id),
    );
    if (shared.length === 0) continue;
    const key = mine.find((k) =>
      other.config.fields.some((f) => f.attribute && f.key === k),
    );
    if (key === undefined) continue;
    const inbox = await db.inbox.findFirst({
      where: { id: parseDbId(shared[0]) ?? 0n, tenantId },
      select: { name: true },
    });
    throw new AppError(
      `occurrences: the monitor "${other.name}" already writes the Chatwoot attribute "${key}" on the inbox "${inbox?.name ?? shared[0]}"; give this field another key, or turn off its copy to Chatwoot`,
      422,
      "errors.occurrenceMonitorAttributeTaken",
      { monitor: other.name, key, inbox: inbox?.name ?? String(shared[0]) },
      "fields",
    );
  }
}

// The monitor's credential, as the write stores it: `vault:<id>` in this account, of a kind that
// holds an API key (the rule the agent's own model key follows). Advisory for the preview,
// authoritative for the write; it reads outside the write's transaction, as the embedding key's check
// does.
export async function canonicalOccurrenceModel(
  ctx: TenantContext,
  patch: OccurrencesPatch,
  base: PrismaClient = basePrisma,
): Promise<OccurrencesPatch> {
  const m: unknown = patch.model;
  if (!m || typeof m !== "object" || Array.isArray(m)) return patch;
  const ref = (m as { credentialRef?: unknown }).credentialRef;
  if (typeof ref !== "string" || !ref.trim()) return patch;
  const canonical = await runScopedOn(base, ctx, (db) =>
    requireVaultRefFor(
      db,
      ref.trim(),
      "occurrences.model.credentialRef",
      "apiKey",
    ),
  );
  // The endpoint a model with none of its own inherits is its credential's (model.ts,
  // resolveMonitorModel): openai-compatible needs one, or the monitor is on and never reads; a
  // provider whose adapter drops it would send the conversations to the vendor instead of that proxy.
  const own = m as { provider?: unknown; baseURL?: unknown };
  if (typeof own.baseURL !== "string" || !own.baseURL.trim()) {
    const key = await runScopedOn(base, ctx, (db) =>
      tryResolveApiKeyEntry(db, canonical),
    );
    const honors = (PROVIDERS_HONORING_BASE_URL as readonly unknown[]).includes(
      own.provider,
    );
    if (
      key.state === "ok" &&
      own.provider === "openai-compatible" &&
      !key.baseUrl
    )
      throw new AppError(
        "occurrences: the model is openai-compatible with no endpoint, and its credential has none (give the model a baseURL, or the credential a base URL)",
        422,
      );
    if (key.state === "ok" && !honors && key.baseUrl)
      throw new AppError(
        `occurrences: the model's credential carries an endpoint a ${String(own.provider)} model does not take (the conversations would go to the vendor, not that endpoint); use a credential without one, or openai-compatible`,
        422,
      );
  }
  return {
    ...patch,
    model: {
      ...(m as object),
      credentialRef: canonical,
    } as OccurrencesPatch["model"],
  };
}

// The configuration a patch would leave, validated as the write validates it.
export function proposedConfig(
  current: OccurrencesConfig,
  patch: OccurrencesPatch,
): OccurrencesConfig {
  const parsed = occurrencesSettingsSchema.safeParse(
    mergeOccurrences(current, patch),
  );
  if (!parsed.success)
    throw new AppError(
      `occurrences: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      422,
    );
  return parsed.data;
}

// What the flags step reads off the block (occurrences/flags.ts).
const FLAG_INPUTS = [
  "inboxIds",
  "reasonField",
  "referenceField",
  "newMinConversations",
  "windowMinutes",
  "previousDays",
  "aboveUsualRatio",
  "concentrationShare",
  "flagHoldMinutes",
  "newWithinMinutes",
] as const satisfies readonly (keyof OccurrencesConfig)[];

function flagInputsChanged(a: OccurrencesConfig, b: OccurrencesConfig) {
  return FLAG_INPUTS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// What decides which conversations a theme counts: a save that changes it drops the held flags at
// once, since they were raised over other conversations; a threshold or the hold moved keeps them.
const COUNTED_SCOPE = [
  "inboxIds",
  "reasonField",
  "referenceField",
] as const satisfies readonly (keyof OccurrencesConfig)[];

function countedScopeChanged(a: OccurrencesConfig, b: OccurrencesConfig) {
  return COUNTED_SCOPE.some(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

// Updates a monitor's configuration (docs/occurrences.md). Validated on the way in, so a cadence of 0,
// or a monitor switched on without its reason field, is a 422 rather than a block read as the default.
// The model's credential is stored as `vault:<id>` of a kind that holds an API key, an inbox the write
// adds must be one of the account's, and a Chatwoot attribute it copies to must not be another
// monitor's on a shared inbox: both checked under the account's monitor lock with the write. Arms or
// cancels the monitor's round after the commit. `"first"` is the account's first monitor, created in
// the same transaction when there is none, so a refused write leaves an account without a monitor as
// it was.
export async function updateMonitorConfig(
  ctx: TenantContext,
  target: bigint | "first",
  rawPatch: OccurrencesPatch,
  base: PrismaClient = basePrisma,
): Promise<OccurrencesConfig> {
  const tenantId = tenantOf(ctx);
  const patch = await canonicalOccurrenceModel(ctx, rawPatch, base);
  const { before, value, monitorId } = await runScopedOn(
    base,
    ctx,
    async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenantId)})::bigint)`;
      const m =
        target === "first"
          ? ((await firstMonitorOn(db, tenantId)) ??
            (await createOn(
              db,
              ctx,
              tenantId,
              await freeName(db, tenantId, FIRST_MONITOR_NAME),
              structuredClone(OCCURRENCES_DEFAULTS),
            )))
          : await monitorOn(db, tenantId, target);
      if (!m) throw notFound();
      // The row too, so the flags step's share lock on it waits for this write (flags.ts).
      await db.$queryRaw`SELECT 1 FROM "occurrence_monitors" WHERE "id" = ${m.id} FOR UPDATE`;
      const value = proposedConfig(m.config, patch);
      await assertOccurrencesInboxes(db, tenantId, m.config, value);
      await assertAttributesFree(db, tenantId, m.id, value);
      await db.occurrenceMonitor.update({
        where: { id: m.id },
        data: { config: value as unknown as Prisma.InputJsonValue },
      });
      // The whole block: field descriptions and the business context are the account's instructions to
      // the monitor, not a customer's words, and the trail is where an admin reads who changed them.
      await auditMutation(db, ctx, {
        action: "occurrence_monitor.updated",
        target: `occurrence_monitor:${m.id}`,
        before: auditOf(m),
        after: auditOf({ ...m, config: value }),
      });
      return { before: m.config, value, monitorId: m.id };
    },
  );
  await syncMonitorRound(tenantId, monitorId, base);
  // The flags and their reference are the round's, but what a theme shows must follow the block as
  // saved now: an inbox taken off the list leaves the counts at once (occurrences/views.ts filters by
  // the saved list), and a reference switched off or changed, or a threshold moved, changes which
  // flags hold. Any change to what the flags step reads counts them again now rather than at the next
  // round, and one to which conversations count releases the held flags. Best-effort: the next round
  // recounts anyway.
  if (flagInputsChanged(before, value))
    await runFlagsStep(base, { tenantId, monitorId }, new Date(), {
      releaseHeld: countedScopeChanged(before, value),
    }).catch((err) =>
      logger.warn(
        { err, tenantId: String(tenantId), monitorId: String(monitorId) },
        "occurrences: the flags could not be recounted after the monitor changed",
      ),
    );
  return value;
}

// The paths that name no monitor (`/v1/occurrences/config`, `occurrences_get`, `occurrences_set`)
// answer for the account's first monitor. An account with none reads the defaults, and its first save
// creates the first monitor, named as the one before there were several.
export async function getOccurrencesSettings(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<OccurrencesConfig> {
  const m = await resolveMonitor(ctx, undefined, base);
  return m ? m.config : structuredClone(OCCURRENCES_DEFAULTS);
}

export async function updateOccurrencesSettings(
  ctx: TenantContext,
  patch: OccurrencesPatch,
  base: PrismaClient = basePrisma,
): Promise<OccurrencesConfig> {
  return updateMonitorConfig(ctx, "first", patch, base);
}
