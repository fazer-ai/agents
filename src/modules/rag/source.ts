import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, NotFoundError } from "@/lib/errors";
import { sanitizeErrorMessage } from "@/lib/redact";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { auditMutation } from "@/modules/audit/service";
import {
  type ClaimedJob,
  cancelPendingJob,
  enqueueJob,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  createDocument,
  deleteDocument,
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
}

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
// The public API caps a page at 100; asking for the cap keeps a 90-article portal to one request.
const PAGE_SIZE = 100;
// A portal with more articles than this is not a help center the agent should be reading whole,
// and a listing that never ends (a portal that ignores `page`) must not loop forever.
const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 15_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const LOCALE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/;

const sysCtx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const invalid = (message: string, field: string) =>
  new AppError(message, 400, undefined, undefined, field);

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
    throw invalid(`unknown source kind: ${String(input.kind)}`, "kind");
  }
  if (typeof input.baseUrl !== "string" || input.baseUrl.trim() === "") {
    throw invalid("baseUrl is required", "baseUrl");
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  try {
    await assertSafe(baseUrl);
  } catch (err) {
    throw invalid(
      `baseUrl is not allowed: ${err instanceof Error ? err.message : String(err)}`,
      "baseUrl",
    );
  }
  if (typeof input.slug !== "string" || !SLUG.test(input.slug)) {
    throw invalid("slug is required and must be a portal slug", "slug");
  }
  if (typeof input.locale !== "string" || !LOCALE.test(input.locale)) {
    throw invalid("locale is required and must be a locale code", "locale");
  }
  const rawExclude = input.excludeIds ?? [];
  if (
    !Array.isArray(rawExclude) ||
    !rawExclude.every((v) => Number.isSafeInteger(v) && (v as number) > 0)
  ) {
    throw invalid("excludeIds must be a list of article ids", "excludeIds");
  }
  const interval = input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (
    !Number.isSafeInteger(interval) ||
    (interval as number) < MIN_INTERVAL_MINUTES ||
    (interval as number) > MAX_INTERVAL_MINUTES
  ) {
    throw invalid(
      `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
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
  };
}

const syncKey = (knowledgeBaseId: bigint) => `source:${knowledgeBaseId}`;

async function armSync(
  tenantId: bigint,
  knowledgeBaseId: bigint,
  runAt: Date,
  rearm: "new-work" | "same-work",
  base: PrismaClient,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "KNOWLEDGE_SOURCE_SYNC",
    dedupeKey: syncKey(knowledgeBaseId),
    runAt,
    // NOTE: "new-work" from an operator (a source saved or a sync asked for: the portal may have
    // changed since the run in flight read it, so that run is superseded), "same-work" from the boot
    // re-arm, which is the clock pushing the same perpetual row again.
    rearm,
    payload: { knowledgeBaseId: String(knowledgeBaseId) },
    base,
  });
}

export async function getSource(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<SourceState | null> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.knowledgeSource.findUnique({ where: { knowledgeBaseId } }),
  );
  return row ? stateOf(row) : null;
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
    if (!kb) throw new NotFoundError("knowledge base not found");
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
    await auditMutation(db, ctx, {
      action: "knowledge_source.set",
      target: `knowledge_base:${knowledgeBaseId}`,
      before: before ? projection(before) : undefined,
      after: projection(saved),
    });
    return saved;
  });
  await armSync(tenantId, knowledgeBaseId, new Date(), "new-work", base);
  return stateOf(row);
}

function projection(row: {
  kind: string;
  config: Prisma.JsonValue;
  intervalMinutes: number;
}) {
  return {
    kind: row.kind,
    config: row.config,
    intervalMinutes: row.intervalMinutes,
  };
}

// Removes the source and stops the sync. The synced documents STAY, with their external ids: the
// agent keeps answering from what it has, and a source put back readopts them by id instead of
// creating copies. Deleting them is the operator's separate, visible act.
export async function deleteSource(
  ctx: TenantContext,
  knowledgeBaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = ctx.tenantId as bigint;
  await runScopedOn(base, ctx, async (db) => {
    const existing = await db.knowledgeSource.findUnique({
      where: { knowledgeBaseId },
    });
    if (!existing) throw new NotFoundError("knowledge base has no source");
    await db.knowledgeSource.delete({ where: { knowledgeBaseId } });
    await auditMutation(db, ctx, {
      action: "knowledge_source.delete",
      target: `knowledge_base:${knowledgeBaseId}`,
      before: projection(existing),
    });
  });
  // A run already claimed finds no source and stops; a pending one is cancelled here.
  await cancelPendingJob(
    tenantId,
    "KNOWLEDGE_SOURCE_SYNC",
    syncKey(knowledgeBaseId),
    base,
  );
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
      if (!kb) throw new NotFoundError("knowledge base not found");
      throw new AppError("knowledge base has no source to sync", 409);
    }
    await auditMutation(db, ctx, {
      action: "knowledge_source.sync",
      target: `knowledge_base:${knowledgeBaseId}`,
    });
  });
  await armSync(tenantId, knowledgeBaseId, new Date(), "new-work", base);
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

// Every published article of the portal, or a throw. ALL pages or nothing: a reconcile over a
// partial listing would read "not listed" as "taken off the portal" and delete what was on the page
// that failed.
export async function fetchPortalArticles(
  config: PortalConfig,
  fetchImpl: typeof fetch = fetch,
  assertSafe: AssertSafe = assertSafeOutboundUrl,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<PortalArticle[]> {
  await assertSafe(config.baseUrl);
  const articles = new Map<number, PortalArticle>();
  // Every id the portal listed, kept or not (a draft, an untitled one): what its count counts.
  const listed = new Set<unknown>();
  let expected: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${config.baseUrl}/hc/${encodeURIComponent(config.slug)}/${encodeURIComponent(config.locale)}/articles.json?per_page=${PAGE_SIZE}&page=${page}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let body: { payload?: unknown; meta?: { articles_count?: unknown } };
    // The timer covers the body too: a portal that sends its headers and then stalls would otherwise
    // hold the run, and with it the scheduler tick every other shared-lane job waits on.
    try {
      // `manual`: a redirect is not followed, because the SSRF check above vouched for this host
      // and nothing else.
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(
          `portal listing page ${page} answered HTTP ${res.status}`,
        );
      }
      body = (await res.json()) as typeof body;
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(body.payload)) {
      throw new Error(`portal listing page ${page} has no payload array`);
    }
    const count = body.meta?.articles_count;
    if (expected === null && typeof count === "number") expected = count;
    let added = 0;
    for (const raw of body.payload as RawArticle[]) {
      if (listed.has(raw.id)) continue;
      listed.add(raw.id);
      added++;
      const a = toArticle(raw, config);
      if (a) articles.set(a.id, a);
    }
    // Done when nothing new arrived (an empty page, or a portal that ignores `page` and returns
    // everything every time) or the count the portal declared is reached. A short page ends the
    // listing only when there is no count: a portal whose cap is below the size asked for serves
    // short pages all the way through.
    const done =
      added === 0 ||
      (expected !== null
        ? listed.size >= expected
        : body.payload.length < PAGE_SIZE);
    if (done) {
      // A listing that ran dry before the count it declared is a partial one (an empty or repeated
      // page mid-way), and a partial listing reads the missing articles as deleted.
      if (expected !== null && listed.size < expected) {
        throw new Error(
          `portal listing ended at ${listed.size} of the ${expected} articles it declared`,
        );
      }
      return [...articles.values()];
    }
  }
  throw new Error(`portal listing did not end within ${MAX_PAGES} pages`);
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
  // A listing with zero articles deletes nothing that round (see runSync).
  emptyListing: boolean;
}

interface SyncedRow {
  id: bigint;
  externalId: string;
  title: string;
  sourceUrl: string | null;
  contentMd5: string;
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
    );
  } catch (err) {
    await recordRun(
      base,
      ctx,
      knowledgeBaseId,
      "error",
      sanitizeErrorMessage(err),
    );
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
      SELECT id, external_id AS "externalId", title, source_url AS "sourceUrl",
             md5(content) AS "contentMd5"
        FROM knowledge_documents
       WHERE knowledge_base_id = ${knowledgeBaseId} AND external_id IS NOT NULL`,
  );
  const have = new Map(existing.map((r) => [r.externalId, r]));
  const result: SyncResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    emptyListing: articles.length === 0,
  };

  try {
    await reconcile(ctx, knowledgeBaseId, wanted, have, result, fence, base);
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
    throw err;
  }

  await recordRun(
    base,
    ctx,
    knowledgeBaseId,
    result.emptyListing ? "warning" : "ok",
    result.emptyListing
      ? "the portal listed no published articles; nothing was deleted this round"
      : `created ${result.created}, updated ${result.updated}, deleted ${result.deleted}, unchanged ${result.unchanged}`,
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
): Promise<void> {
  for (const [externalId, a] of wanted) {
    const row = have.get(externalId);
    if (!row) {
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
      result.unchanged++;
      continue;
    }
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
  knowledgeBaseId: bigint,
  status: "ok" | "warning" | "error",
  message: string,
): Promise<void> {
  // updateMany: the source may have been removed while the run was out fetching.
  await runScopedOn(base, ctx, (db) =>
    db.knowledgeSource.updateMany({
      where: { knowledgeBaseId },
      data: {
        lastSyncAt: new Date(),
        lastStatus: status,
        lastMessage: clipText(message, 500),
      },
    }),
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
  await syncKnowledgeSource(job.tenantId, knowledgeBaseId, { base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + source.intervalMinutes * 60_000),
  };
}

let registered = false;
export function registerKnowledgeSourceHandler(): void {
  if (registered) return;
  registerJobHandler("KNOWLEDGE_SOURCE_SYNC", sourceSyncHandler);
  registered = true;
}

// Boot: every source gets its perpetual row back, due one interval out (a restart is not a reason
// to hit every portal at once). Best-effort per source, like the other boot re-arms.
export async function ensureAllKnowledgeSourceSyncs(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const sources = await asSuperAdminOn(base, (db) =>
    db.knowledgeSource.findMany({
      select: { tenantId: true, knowledgeBaseId: true, intervalMinutes: true },
    }),
  );
  for (const s of sources) {
    try {
      await enqueueJob({
        tenantId: s.tenantId,
        kind: "KNOWLEDGE_SOURCE_SYNC",
        dedupeKey: syncKey(s.knowledgeBaseId),
        runAt: new Date(Date.now() + s.intervalMinutes * 60_000),
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
