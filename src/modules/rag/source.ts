import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, NotFoundError } from "@/lib/errors";
import { sanitizeErrorMessage } from "@/lib/redact";
import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import {
  markUndisclosed,
  redactEndpoint,
  undisclosedMoved,
} from "@/modules/audit/projection";
import { auditMutation } from "@/modules/audit/service";
import {
  type ClaimedJob,
  enqueueJob,
  upsertJobRow,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  createDocument,
  deleteDocument,
  refuseUnstorable,
  SourceChangedError,
  type SourceFence,
  updateDocument,
} from "./documents";

// A knowledge base that mirrors a Chatwoot help center portal (issue #794).
//
// The platform owns the link between an article and its document: `KnowledgeDocument.externalId`
// is the article id, unique per base. Nothing outside keeps a map, so nothing can lose it, and a
// reconcile is a set comparison by id — never by title, which is what produced duplicates when two
// articles shared one, and copies of the whole base when an outside map went missing.
//
// Only documents that carry an external id are the sync's. Everything else in the base (a curated
// note, an approved suggestion) is never read, compared, or touched by it.

export const SOURCE_KINDS = ["chatwoot_portal"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface PortalConfig {
  baseUrl: string;
  slug: string;
  locale: string;
  excludeIds: number[];
}

export interface SourceInput {
  kind: string;
  baseUrl?: unknown;
  slug?: unknown;
  locale?: unknown;
  excludeIds?: unknown;
  intervalMinutes?: unknown;
}

export interface SourceState {
  kind: SourceKind;
  baseUrl: string;
  slug: string;
  locale: string;
  excludeIds: number[];
  intervalMinutes: number;
  lastSyncAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
  // The last run stopped at its write budget and the next one, a few seconds away, continues it
  // (issue #798). A reader watching a sync land needs this to know the landed run is not the end;
  // the scheduled row is the only place it is written, so it is read from there.
  continuing: boolean;
}

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;

// A portal with more articles than this is not a help center the agent should be reading whole, and
// the listing arrives in one body, so its size is bounded too.
const MAX_ARTICLES = 5_000;
const MAX_LISTING_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
// The whole run's wait on the portal, the name resolution included: a run is awaited by the scheduler
// tick every shared-lane job waits on (reminders, follow-ups, every tenant's).
const LISTING_DEADLINE_MS = 60_000;
// And the writes, for the same tick: a first sync of a portal with thousands of articles is thousands
// of transactions. A run writes at most this many documents and says there is more; the handler then
// comes back in seconds instead of an interval, and the reconcile, being by id, resumes where the last
// run stopped without remembering anything.
const WRITES_PER_RUN = 100;
const CONTINUE_AFTER_MS = 15_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const LOCALE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/;

const sysCtx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Validates and normalizes what an operator sends, and answers the SSRF question once here so a
// refused URL never reaches the database. The run asks it again before every fetch, because a name
// that resolved publicly when the source was saved can resolve privately later.
// The SSRF check, injectable like the Chatwoot client's (tests exercise a fake portal on a name that
// does not resolve); production always gets `assertSafeOutboundUrl`.
export type AssertSafe = (url: string) => Promise<unknown>;

export async function parseSourceInput(
  input: SourceInput,
  assertSafe: AssertSafe = assertSafeOutboundUrl,
): Promise<{
  kind: SourceKind;
  config: PortalConfig;
  intervalMinutes: number;
}> {
  if (!SOURCE_KINDS.includes(input.kind as SourceKind)) {
    throw new AppError(
      `unknown source kind: ${String(input.kind)}`,
      400,
      "errors.sourceKindUnknown",
      { kind: String(input.kind) },
      "kind",
    );
  }
  if (typeof input.baseUrl !== "string" || input.baseUrl.trim() === "") {
    throw new AppError(
      "baseUrl is required",
      400,
      "errors.sourceUrlRequired",
      undefined,
      "baseUrl",
    );
  }
  // The string that is KEPT, held to what the column stores: the URL parser below drops a trailing
  // control character before it validates, so a NUL would pass it and then fail at the database,
  // after a preview had already said yes.
  refuseUnstorable([["baseUrl", input.baseUrl]]);
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  // A portal's listing is public, so a URL that carries a credential is a credential pasted by
  // mistake: refused rather than stored, shown back on every read, and fetched with.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new AppError(
      "baseUrl is not a URL",
      400,
      "errors.sourceUrlInvalid",
      undefined,
      "baseUrl",
    );
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new AppError(
      "baseUrl must not carry credentials",
      400,
      "errors.sourceUrlCredentials",
      undefined,
      "baseUrl",
    );
  }
  // Static, so it holds where the address is not resolved (an import): the SSRF check below is the
  // one that knows the scheme rules, but it is also the one that needs DNS.
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new AppError(
      "baseUrl must be an http(s) URL",
      400,
      "errors.sourceUrlNotHttp",
      undefined,
      "baseUrl",
    );
  }
  // The listing path is appended to this string, and after a `?` or a `#` it would land inside the
  // query or the fragment: the source would save and every run would fetch the wrong page.
  if (
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    /[?#]/.test(baseUrl)
  ) {
    throw new AppError(
      "baseUrl must not carry a query or a fragment",
      400,
      "errors.sourceUrlQuery",
      undefined,
      "baseUrl",
    );
  }
  try {
    await assertSafe(baseUrl);
  } catch (err) {
    // Only a REFUSAL is the caller's input being wrong. A resolver that failed to answer
    // (`EAI_AGAIN`) is the infrastructure's, and reporting it as an invalid field would tell the
    // operator to change a URL that is fine.
    if (err instanceof SsrfError) {
      throw new AppError(
        `baseUrl is not allowed: ${err.message}`,
        400,
        "errors.sourceUrlNotAllowed",
        { reason: err.message },
        "baseUrl",
      );
    }
    throw err;
  }
  if (typeof input.slug !== "string" || !SLUG.test(input.slug)) {
    throw new AppError(
      "slug is required and must be a portal slug",
      400,
      "errors.sourceSlugInvalid",
      undefined,
      "slug",
    );
  }
  if (typeof input.locale !== "string" || !LOCALE.test(input.locale)) {
    throw new AppError(
      "locale is required and must be a locale code",
      400,
      "errors.sourceLocaleInvalid",
      undefined,
      "locale",
    );
  }
  const rawExclude = input.excludeIds ?? [];
  if (
    !Array.isArray(rawExclude) ||
    !rawExclude.every((v) => Number.isSafeInteger(v) && (v as number) > 0)
  ) {
    throw new AppError(
      "excludeIds must be a list of article ids",
      400,
      "errors.sourceExcludeIdsInvalid",
      undefined,
      "excludeIds",
    );
  }
  const interval = input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (
    !Number.isSafeInteger(interval) ||
    (interval as number) < MIN_INTERVAL_MINUTES ||
    (interval as number) > MAX_INTERVAL_MINUTES
  ) {
    throw new AppError(
      `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
      400,
      "errors.sourceIntervalInvalid",
      { min: MIN_INTERVAL_MINUTES, max: MAX_INTERVAL_MINUTES },
      "intervalMinutes",
    );
  }
  return {
    kind: input.kind as SourceKind,
    config: {
      baseUrl,
      slug: input.slug,
      locale: input.locale,
      excludeIds: [...new Set(rawExclude as number[])].sort((a, b) => a - b),
    },
    intervalMinutes: interval as number,
  };
}

function stateOf(row: {
  kind: string;
  config: Prisma.JsonValue;
  intervalMinutes: number;
  lastSyncAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
}): SourceState {
  const c = row.config as unknown as PortalConfig;
  return {
    kind: row.kind as SourceKind,
    baseUrl: c.baseUrl,
    slug: c.slug,
    locale: c.locale,
    excludeIds: c.excludeIds ?? [],
    intervalMinutes: row.intervalMinutes,
    lastSyncAt: row.lastSyncAt,
    lastStatus: row.lastStatus,
    lastMessage: row.lastMessage,
    continuing: false,
  };
}

// A continuation is armed CONTINUE_AFTER_MS after the run that asked for it; an ordinary next run is
// at least MIN_INTERVAL_MINUTES away. Anything under a minute from the last run is the former.
const CONTINUATION_WINDOW_MS = 60_000;

const syncKey = (knowledgeBaseId: bigint) => `source:${knowledgeBaseId}`;

// Arms the base's sync for now, INSIDE the caller's transaction: a source that committed without its
// row would be configured and never synced, with nothing but a restart to notice. The perpetual row
// re-arms itself from then on, and the boot re-arm (`ensureAllKnowledgeSourceSyncs`) is the net.
export async function armSourceSync(
  db: ScopedDb,
  tenantId: bigint,
  knowledgeBaseId: bigint,
): Promise<void> {
  await upsertJobRow(db, {
    tenantId,
    kind: "KNOWLEDGE_SOURCE_SYNC",
    dedupeKey: syncKey(knowledgeBaseId),
    runAt: new Date(),
    // NOTE: an operator's act (a source saved, a sync asked for, an agent imported): the portal may
    // have changed since the run in flight read it, so that run is superseded.
    rearm: "new-work",
    payload: { knowledgeBaseId: String(knowledgeBaseId) },
  });
}

export async function getSource(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<SourceState | null> {
  const found = await runScopedOn(base, ctx, async (db) => {
    const row = await db.knowledgeSource.findUnique({
      where: { knowledgeBaseId },
    });
    if (!row) return null;
    const job = row.lastSyncAt
      ? await db.schedulerJob.findFirst({
          where: {
            kind: "KNOWLEDGE_SOURCE_SYNC",
            dedupeKey: syncKey(knowledgeBaseId),
          },
          select: { runAt: true },
        })
      : null;
    return { row, job };
  });
  if (!found) return null;
  const state = stateOf(found.row);
  const last = found.row.lastSyncAt;
  state.continuing =
    last !== null &&
    found.job !== null &&
    found.job.runAt.getTime() - last.getTime() < CONTINUATION_WINDOW_MS;
  return state;
}

// Creates or replaces the base's source and arms a sync for now. Replacing keeps the documents: a
// changed exclusion list or locale is reconciled by the run, by id, like any other change.
export async function setSource(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  input: SourceInput,
  base: PrismaClient = basePrisma,
  assertSafe: AssertSafe = assertSafeOutboundUrl,
): Promise<SourceState> {
  const tenantId = ctx.tenantId as bigint;
  const parsed = await parseSourceInput(input, assertSafe);
  const row = await runScopedOn(base, ctx, async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: knowledgeBaseId },
      select: { id: true },
    });
    if (!kb)
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    const before = await db.knowledgeSource.findUnique({
      where: { knowledgeBaseId },
    });
    const config = parsed.config as unknown as Prisma.InputJsonValue;
    const saved = await db.knowledgeSource.upsert({
      where: { knowledgeBaseId },
      create: {
        tenantId,
        knowledgeBaseId,
        kind: parsed.kind,
        config,
        intervalMinutes: parsed.intervalMinutes,
      },
      update: {
        kind: parsed.kind,
        config,
        intervalMinutes: parsed.intervalMinutes,
      },
    });
    // The URL goes on the row as its origin (`redactEndpoint`, the rule for every URL an operator
    // types); a change the origin does not show is marked on both sides instead of carried.
    const hidden =
      before !== null &&
      undisclosedMoved(
        { baseUrl: urlOf(before.config) },
        { baseUrl: urlOf(saved.config) },
        ["baseUrl"],
      );
    const mark = <T extends object>(p: T) => (hidden ? markUndisclosed(p) : p);
    await auditMutation(db, ctx, {
      action: "knowledge_source.set",
      target: `knowledge_base:${knowledgeBaseId}`,
      before: before ? mark(projection(before)) : undefined,
      after: mark(projection(saved)),
    });
    await armSourceSync(db, tenantId, knowledgeBaseId);
    return saved;
  });
  return stateOf(row);
}

function projection(row: {
  kind: string;
  config: Prisma.JsonValue;
  intervalMinutes: number;
}) {
  const c = row.config as unknown as PortalConfig;
  return {
    kind: row.kind,
    baseUrl: redactEndpoint(c.baseUrl),
    slug: c.slug,
    locale: c.locale,
    excludeIds: c.excludeIds ?? [],
    intervalMinutes: row.intervalMinutes,
  };
}

const urlOf = (config: Prisma.JsonValue) =>
  (config as unknown as PortalConfig).baseUrl;

// Removes the source and stops the sync. The synced documents STAY, with their external ids: the
// agent keeps answering from what it has, and a source put back readopts them by id instead of
// creating copies. Deleting them is the operator's separate, visible act.
export async function deleteSource(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const existing = await db.knowledgeSource.findUnique({
      where: { knowledgeBaseId },
    });
    if (!existing)
      throw new NotFoundError(
        "knowledge base has no source",
        "errors.sourceMissing",
      );
    await db.knowledgeSource.delete({ where: { knowledgeBaseId } });
    // The pending run is cancelled IN this transaction, not after it: a source set again right after
    // this commits arms a row under the same key, and a cancel running later would mark that one
    // DONE and leave the new source configured and never synced. A run already claimed finds no
    // source at its first write and stops.
    await db.schedulerJob.updateMany({
      where: {
        kind: "KNOWLEDGE_SOURCE_SYNC",
        dedupeKey: syncKey(knowledgeBaseId),
        status: "PENDING",
      },
      data: { status: "DONE" },
    });
    await auditMutation(db, ctx, {
      action: "knowledge_source.delete",
      target: `knowledge_base:${knowledgeBaseId}`,
      before: projection(existing),
    });
  });
}

// Asks for a sync now. The run is the scheduler's, so two requests at once are one row re-armed,
// and a run already in flight is superseded by a fresh one that reads the portal again.
export async function requestSync(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = ctx.tenantId as bigint;
  await runScopedOn(base, ctx, async (db) => {
    const source = await db.knowledgeSource.findUnique({
      where: { knowledgeBaseId },
      select: { id: true },
    });
    if (!source) {
      const kb = await db.knowledgeBase.findUnique({
        where: { id: knowledgeBaseId },
        select: { id: true },
      });
      if (!kb)
        throw new NotFoundError(
          "knowledge base not found",
          "errors.knowledgeBaseNotFound",
        );
      throw new AppError(
        "knowledge base has no source to sync",
        409,
        "errors.sourceMissingToSync",
      );
    }
    await auditMutation(db, ctx, {
      action: "knowledge_source.sync",
      target: `knowledge_base:${knowledgeBaseId}`,
    });
    await armSourceSync(db, tenantId, knowledgeBaseId);
  });
}

// ── fetching ────────────────────────────────────────────────────────────────────────────────────

export interface PortalArticle {
  id: number;
  title: string;
  content: string;
  url: string;
}

interface RawArticle {
  id?: unknown;
  title?: unknown;
  content?: unknown;
  status?: unknown;
  slug?: unknown;
  link?: unknown;
}

// Every published article of the portal, in ONE request, or a throw.
//
// Without `per_page` the public listing is not paginated at all: `limit_results` only pages when the
// parameter is present, and the answer is every published article of the locale. That is the only
// complete answer it has. Paging it is not: the listing orders by `position` alone, which each
// category numbers on its own, so ties across categories straddle page boundaries and an offset page
// repeats one article and skips another with nothing changing on the portal. A missing article reads
// as deleted, so the listing is taken whole, checked against the count the portal declares, and a
// mismatch is an error that deletes nothing.
export async function fetchPortalArticles(
  config: PortalConfig,
  fetchImpl: typeof fetch = fetch,
  assertSafe: AssertSafe = assertSafeOutboundUrl,
  timeoutMs: number = FETCH_TIMEOUT_MS,
  deadlineMs: number = LISTING_DEADLINE_MS,
): Promise<PortalArticle[]> {
  const deadline = Date.now() + deadlineMs;
  const url = `${config.baseUrl}/hc/${encodeURIComponent(config.slug)}/${encodeURIComponent(config.locale)}/articles.json`;
  const expired = () =>
    new Error(`portal listing did not finish within ${deadlineMs / 1000}s`);
  // The check resolves the name, and a resolver that hangs is inside the deadline like the fetch is:
  // the listing is fetched only after the check PASSES, and the wait for it ends with the deadline.
  await beforeDeadline(assertSafe(url), deadline, expired);
  const left = deadline - Date.now();
  if (left <= 0) throw expired();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, left));
  let body: { payload?: unknown; meta?: { articles_count?: unknown } };
  let read = false;
  // The timer covers the body too: a portal that sends its headers and then stalls would otherwise
  // hold the run, and with it the scheduler tick every other shared-lane job waits on.
  try {
    // `manual`: a redirect is not followed, because the SSRF check above vouched for this host and
    // nothing else.
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`portal listing answered HTTP ${res.status}`);
    }
    body = JSON.parse(await readCapped(res, MAX_LISTING_BYTES)) as typeof body;
    read = true;
  } finally {
    clearTimeout(timer);
    // A listing refused before it was read (an error status, a body over the cap) is still coming
    // down the wire; clearing the timer alone would let it finish downloading after the run gave up.
    if (!read) ctrl.abort();
  }
  if (!Array.isArray(body.payload)) {
    throw new Error("portal listing has no payload array");
  }
  if (body.payload.length > MAX_ARTICLES) {
    throw new Error(
      `portal listing has ${body.payload.length} articles, above the ${MAX_ARTICLES} a source mirrors`,
    );
  }
  const articles = new Map<number, PortalArticle>();
  // Every id the portal listed, kept or not (a draft, an untitled one): what its count counts.
  const listed = new Set<unknown>();
  for (const raw of body.payload as RawArticle[]) {
    if (listed.has(raw.id)) continue;
    listed.add(raw.id);
    const a = toArticle(raw, config);
    if (a) articles.set(a.id, a);
  }
  const expected = body.meta?.articles_count;
  if (typeof expected === "number" && listed.size < expected) {
    // A listing short of the count it declares (a Chatwoot that pages by default, a proxy that cut
    // the body) is a partial one, and a partial listing reads the missing articles as deleted.
    throw new Error(
      `portal listing has ${listed.size} of the ${expected} articles it declares`,
    );
  }
  return [...articles.values()];
}

// The body, refused past `max` bytes instead of buffered whole: the size of the answer is the
// portal's to choose, and the process holding it is shared.
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    throw new Error(`portal listing is ${declared} bytes, above ${max}`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`portal listing is above ${max} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function beforeDeadline<T>(
  p: Promise<T>,
  deadline: number,
  expired: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(expired()),
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([p, cut]);
  } finally {
    clearTimeout(timer);
  }
}

function toArticle(
  raw: RawArticle,
  config: PortalConfig,
): PortalArticle | null {
  // The public listing only serves published articles; the status is asked anyway, so a portal
  // that one day serves drafts there does not put them in front of the agent.
  if (raw.status !== undefined && raw.status !== "published") return null;
  if (!Number.isSafeInteger(raw.id) || typeof raw.title !== "string")
    return null;
  const title = raw.title.trim();
  if (title === "") return null;
  const link =
    typeof raw.link === "string" && raw.link !== ""
      ? raw.link.replace(/^\/+/, "")
      : typeof raw.slug === "string" && raw.slug !== ""
        ? `hc/${config.slug}/articles/${raw.slug}`
        : null;
  return {
    id: raw.id as number,
    title,
    content: typeof raw.content === "string" ? raw.content : "",
    url: link ? `${config.baseUrl}/${link}` : config.baseUrl,
  };
}

// ── reconciling ─────────────────────────────────────────────────────────────────────────────────

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  // Unchanged documents whose lost ingest this run re-armed.
  requeued: number;
  // The run stopped at its write budget with work left; the next one continues it.
  more: boolean;
  // A listing with zero articles deletes nothing that round (see runSync).
  emptyListing: boolean;
}

interface SyncedRow {
  id: bigint;
  externalId: string;
  title: string;
  sourceUrl: string | null;
  contentMd5: string;
  // Indexing was asked for and nothing will do it: see the unchanged branch of `reconcile`.
  ingestStranded: boolean;
}

const md5 = (text: string) =>
  new Bun.CryptoHasher("md5").update(text).digest("hex");

// One reconcile of a base against its portal. Writes go through the document functions, so every
// change is audited and re-embedded exactly as an operator's would be, and only when something moved:
// an unchanged article costs a comparison, not a write, and never an embedding.
export async function syncKnowledgeSource(
  tenantId: bigint,
  knowledgeBaseId: bigint,
  deps: {
    base?: PrismaClient;
    fetchImpl?: typeof fetch;
    assertSafe?: AssertSafe;
    timeoutMs?: number;
    deadlineMs?: number;
    writesPerRun?: number;
  } = {},
): Promise<SyncResult | null> {
  const base = deps.base ?? basePrisma;
  const ctx = sysCtx(tenantId);
  // The config as TEXT, the way every write of this run checks it (see `SourceFence`).
  const rows = await runScopedOn(
    base,
    ctx,
    (db) =>
      db.$queryRaw<{ config: string }[]>`
      SELECT config::text AS config FROM knowledge_sources
       WHERE knowledge_base_id = ${knowledgeBaseId}`,
  );
  const configText = rows[0]?.config;
  if (configText === undefined) return null;
  const config = JSON.parse(configText) as PortalConfig;
  const fence: SourceFence = { knowledgeBaseId, config: configText };

  let articles: PortalArticle[];
  try {
    articles = await fetchPortalArticles(
      config,
      deps.fetchImpl,
      deps.assertSafe,
      deps.timeoutMs,
      deps.deadlineMs,
    );
  } catch (err) {
    await recordRun(base, ctx, fence, "error", sanitizeErrorMessage(err));
    return null;
  }

  const excluded = new Set(config.excludeIds ?? []);
  const wanted = new Map(
    articles.filter((a) => !excluded.has(a.id)).map((a) => [String(a.id), a]),
  );
  const existing = await runScopedOn(
    base,
    ctx,
    (db) =>
      db.$queryRaw<SyncedRow[]>`
      SELECT d.id, d.external_id AS "externalId", d.title, d.source_url AS "sourceUrl",
             md5(d.content) AS "contentMd5",
             (d.status = 'PENDING' AND NOT EXISTS (
               SELECT 1 FROM scheduler_jobs j
                WHERE j.kind = 'RAG_INGEST' AND j.dedupe_key = 'doc:' || d.id
                  AND j.status IN ('PENDING', 'CLAIMED', 'FAILED')
             )) AS "ingestStranded"
        FROM knowledge_documents d
       WHERE d.knowledge_base_id = ${knowledgeBaseId} AND d.external_id IS NOT NULL`,
  );
  const have = new Map(existing.map((r) => [r.externalId, r]));
  const result: SyncResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    requeued: 0,
    more: false,
    emptyListing: articles.length === 0,
  };

  try {
    await reconcile(
      ctx,
      knowledgeBaseId,
      wanted,
      have,
      result,
      fence,
      base,
      deps.writesPerRun ?? WRITES_PER_RUN,
    );
  } catch (err) {
    // Removed or replaced while this run was out: its listing no longer answers for the base. A
    // replacement armed a run of its own; a removal wants nothing more written.
    if (err instanceof SourceChangedError) {
      logger.info(
        {
          tenantId: String(tenantId),
          knowledgeBaseId: String(knowledgeBaseId),
        },
        "knowledge source sync: the source changed during the run; stopped",
      );
      return null;
    }
    // A write that failed (the database, the ingest enqueue) is the source's outcome too: without
    // it the source keeps showing its previous `ok` while the scheduler retries and gives up.
    await recordRun(base, ctx, fence, "error", sanitizeErrorMessage(err));
    throw err;
  }

  await recordRun(
    base,
    ctx,
    fence,
    result.emptyListing ? "warning" : "ok",
    result.emptyListing
      ? "the portal listed no published articles; nothing was deleted this round"
      : `created ${result.created}, updated ${result.updated}, deleted ${result.deleted}, unchanged ${result.unchanged}${result.requeued ? ` (${result.requeued} re-queued for indexing)` : ""}${result.more ? "; more to do, continuing shortly" : ""}`,
  );
  return result;
}

async function reconcile(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  wanted: Map<string, PortalArticle>,
  have: Map<string, SyncedRow>,
  result: SyncResult,
  fence: SourceFence,
  base: PrismaClient,
  writesPerRun: number,
): Promise<void> {
  let writes = 0;
  // Asked before every write: false once the budget is spent, and then the run says there is more.
  const budget = () => {
    if (writes >= writesPerRun) {
      result.more = true;
      return false;
    }
    writes++;
    return true;
  };
  for (const [externalId, a] of wanted) {
    const row = have.get(externalId);
    if (!row) {
      if (!budget()) return;
      try {
        await createDocument({
          ctx,
          knowledgeBaseId,
          title: a.title,
          text: a.content,
          sourceType: "chatwoot_portal",
          externalId,
          sourceUrl: a.url,
          bySource: fence,
          base,
        });
        result.created++;
      } catch (err) {
        // Another run created it between our read and this write (two syncs at once). The unique
        // index is what makes that a no-op instead of a second copy.
        if (isUniqueViolation(err)) continue;
        throw err;
      }
      continue;
    }
    const titleMoved = row.title !== a.title;
    const textMoved = row.contentMd5 !== md5(a.content);
    const urlMoved = row.sourceUrl !== a.url;
    if (!titleMoved && !textMoved && !urlMoved) {
      // A write commits the document and enqueues its ingest AFTER the commit (the document paths
      // all do), so an enqueue that failed leaves it PENDING with no job. An operator's retry refuses
      // a PENDING document, and this branch would otherwise see the article unchanged forever: the
      // sync is the one caller that comes back, so it re-arms what was lost.
      if (row.ingestStranded) {
        if (!budget()) return;
        await enqueueJob({
          tenantId: ctx.tenantId as bigint,
          kind: "RAG_INGEST",
          dedupeKey: `doc:${row.id}`,
          runAt: new Date(),
          // NOTE: the same text the lost enqueue was for, so the same unit of work.
          rearm: "same-work",
          payload: { documentId: String(row.id) },
          base,
        });
        result.requeued++;
      }
      result.unchanged++;
      continue;
    }
    if (!budget()) return;
    await ignoreGone(
      updateDocument(
        ctx,
        row.id,
        {
          ...(titleMoved ? { title: a.title } : {}),
          ...(textMoved ? { text: a.content } : {}),
          ...(urlMoved ? { sourceUrl: a.url } : {}),
          bySource: fence,
        },
        base,
      ),
    );
    result.updated++;
  }

  // THE EMPTY-LISTING FENCE. A deletion is inferred from absence, so a round that sees zero
  // articles would empty the base. A portal unpublishing every article at once is far less likely
  // than one returning an empty page during maintenance, and the cost of being wrong is not
  // symmetric: this round deletes nothing, says so on the source, and the next round deletes what
  // is still missing once the listing is back.
  if (!result.emptyListing) {
    for (const [externalId, row] of have) {
      if (wanted.has(externalId)) continue;
      if (!budget()) return;
      await ignoreGone(deleteDocument(ctx, row.id, base, { bySource: fence }));
      result.deleted++;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

// A document another run already deleted is the outcome this one wanted.
async function ignoreGone(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NotFoundError) return;
    throw err;
  }
}

async function recordRun(
  base: PrismaClient,
  ctx: TenantContext,
  fence: SourceFence,
  status: "ok" | "warning" | "error",
  message: string,
): Promise<void> {
  const { knowledgeBaseId } = fence;
  // Written only onto the source this run read: one removed while the run was out matches nothing,
  // and one REPLACED meanwhile has a run of its own whose outcome this one must not overwrite.
  await runScopedOn(
    base,
    ctx,
    (db) =>
      db.$executeRaw`
      UPDATE knowledge_sources
         SET last_sync_at = now(), last_status = ${status},
             last_message = ${clipText(message, 500)}, updated_at = now()
       WHERE knowledge_base_id = ${knowledgeBaseId} AND config::text = ${fence.config}`,
  );
  if (status !== "ok") {
    logger.warn(
      {
        tenantId: String(ctx.tenantId),
        knowledgeBaseId: String(knowledgeBaseId),
        status,
      },
      `knowledge source sync: ${message}`,
    );
  }
}

// ── scheduling ──────────────────────────────────────────────────────────────────────────────────

async function sourceSyncHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const raw = (job.payload as { knowledgeBaseId?: unknown } | null)
    ?.knowledgeBaseId;
  const knowledgeBaseId = parseDbId(typeof raw === "string" ? raw : null);
  if (knowledgeBaseId === null) return { outcome: "done" };
  const source = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
    db.knowledgeSource.findUnique({
      where: { knowledgeBaseId },
      select: { intervalMinutes: true },
    }),
  );
  // Removed while the row waited: the sync ends with it.
  if (!source) return { outcome: "done" };
  const result = await syncKnowledgeSource(job.tenantId, knowledgeBaseId, {
    base,
  });
  return {
    outcome: "reschedule",
    runAt: nextSyncAt(result, source.intervalMinutes, Date.now()),
  };
}

// A run that stopped at its write budget continues in seconds; any other comes back at the interval.
export function nextSyncAt(
  result: SyncResult | null,
  intervalMinutes: number,
  now: number,
): Date {
  return new Date(
    now + (result?.more ? CONTINUE_AFTER_MS : intervalMinutes * 60_000),
  );
}

let registered = false;
export function registerKnowledgeSourceHandler(): void {
  if (registered) return;
  registerJobHandler("KNOWLEDGE_SOURCE_SYNC", sourceSyncHandler);
  registered = true;
}

// Boot: every source gets its perpetual row back, due when its interval since the last run ends (a
// restart is not a reason to hit every portal at once). Never later than a row already pending: a
// boot that pushed the run one interval out would starve the periodic sync on an app restarted more
// often than its interval, and would postpone a sync someone just asked for. Best-effort per source,
// like the other boot re-arms.
export async function ensureAllKnowledgeSourceSyncs(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const [sources, pending] = await asSuperAdminOn(base, (db) =>
    Promise.all([
      db.knowledgeSource.findMany({
        select: {
          tenantId: true,
          knowledgeBaseId: true,
          intervalMinutes: true,
          lastSyncAt: true,
        },
      }),
      db.schedulerJob.findMany({
        where: { kind: "KNOWLEDGE_SOURCE_SYNC", status: "PENDING" },
        select: { tenantId: true, dedupeKey: true, runAt: true },
      }),
    ]),
  );
  const pendingAt = new Map(
    pending.map((j) => [`${j.tenantId}:${j.dedupeKey}`, j.runAt.getTime()]),
  );
  const now = Date.now();
  for (const s of sources) {
    try {
      await enqueueJob({
        tenantId: s.tenantId,
        kind: "KNOWLEDGE_SOURCE_SYNC",
        dedupeKey: syncKey(s.knowledgeBaseId),
        runAt: bootRunAt(
          s,
          pendingAt.get(`${s.tenantId}:${syncKey(s.knowledgeBaseId)}`),
          now,
        ),
        rearm: "same-work",
        payload: { knowledgeBaseId: String(s.knowledgeBaseId) },
        base,
      });
    } catch (err) {
      logger.warn(
        {
          err: sanitizeErrorMessage(err),
          knowledgeBaseId: String(s.knowledgeBaseId),
        },
        "knowledge source sync: boot re-arm failed",
      );
    }
  }
}

// When a source's row is due after a boot: one interval after its last run (now, if that has passed;
// one interval out if it never ran), or the pending row's time when that is sooner.
export function bootRunAt(
  source: { intervalMinutes: number; lastSyncAt: Date | null },
  pendingAt: number | undefined,
  now: number,
): Date {
  const interval = source.intervalMinutes * 60_000;
  const due = source.lastSyncAt
    ? Math.max(now, source.lastSyncAt.getTime() + interval)
    : now + interval;
  return new Date(pendingAt === undefined ? due : Math.min(due, pendingAt));
}
