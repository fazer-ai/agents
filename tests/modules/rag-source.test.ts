import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { passageWithSource } from "@/graph/tools/rag";
import { ConflictError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import type { TenantContext } from "@/lib/tenancy";
import { runScopedOn } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  knowledgeDocumentDelete,
  knowledgeDocumentUpdate,
  knowledgeSourceRemove,
  knowledgeSourceSet,
  knowledgeSourceSync,
} from "@/modules/mcp/write-knowledge";
import { deleteDocument, updateDocument } from "@/modules/rag/documents";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import {
  deleteSource,
  getSource,
  parseSourceInput,
  requestSync,
  setSource,
  syncKnowledgeSource,
} from "@/modules/rag/source";
import { insertChunks, searchChunks } from "@/modules/rag/sql";

// Issue #794: a knowledge base mirrors a Chatwoot help center portal, keyed by article id, with the
// link owned by the platform. The portal here is a fake `fetch` that answers the public listing the
// way the real controller does (`per_page` capped at 100, `meta.articles_count`, published only).

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const PORTAL = "https://ajuda.loja-exemplo.com.br";
const allowAll = async () => undefined;

interface Art {
  id: number;
  title: string;
  content: string;
  slug?: string;
  status?: string;
}

// The public listing, as `Public::Api::V1::Portals::ArticlesController#index` serves it.
function portal(opts: {
  articles: () => Art[];
  failPage?: (page: number) => number | null;
  ignorePage?: boolean;
  pageCap?: number;
  requests?: string[];
  // A portal that one day serves drafts in the public listing, and one that declares no count.
  leakDrafts?: boolean;
  noCount?: boolean;
  // A portal whose listing runs dry (or repeats page 1) before the count it declares.
  truncateAt?: number;
  redirects?: (RequestRedirect | undefined)[];
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    opts.requests?.push(url.pathname + url.search);
    opts.redirects?.push(init?.redirect);
    const page = Number(url.searchParams.get("page") ?? "1");
    const failed = opts.failPage?.(page) ?? null;
    if (failed) return new Response("boom", { status: failed });
    const published = opts
      .articles()
      .filter(
        (a) => opts.leakDrafts || (a.status ?? "published") === "published",
      );
    const per = Math.min(
      Number(url.searchParams.get("per_page") ?? "25"),
      opts.pageCap ?? 100,
    );
    const served =
      opts.truncateAt !== undefined
        ? published.slice(0, opts.truncateAt)
        : published;
    const slice = opts.ignorePage
      ? served
      : served.slice((page - 1) * per, page * per);
    const payload = slice.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      status: a.status ?? "published",
      slug: a.slug ?? `${a.id}-artigo`,
      link: `hc/ajuda/articles/${a.slug ?? `${a.id}-artigo`}`,
    }));
    return Response.json({
      payload,
      meta: opts.noCount ? {} : { articles_count: published.length },
    });
  }) as unknown as typeof fetch;
}

const BASIC: Art[] = [
  {
    id: 101,
    title: "Como trocar o endereço de entrega",
    content: "MARCADOR-101-v1",
  },
  { id: 102, title: "Prazo de reembolso", content: "MARCADOR-102-v1" },
  { id: 103, title: "Horário de atendimento", content: "MARCADOR-103-v1" },
];

let tenantId = 0n;
let kb = 0n;
let curated = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const principal = (): VerifiedToken => ({
  userId: 1n,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
});

async function synced() {
  const rows = await suDb.knowledgeDocument.findMany({
    where: { knowledgeBaseId: kb, externalId: { not: null } },
    orderBy: { externalId: "asc" },
  });
  return rows;
}

async function configure(extra: { excludeIds?: number[] } = {}) {
  await setSource(
    ctx(),
    kb,
    {
      kind: "chatwoot_portal",
      baseUrl: PORTAL,
      slug: "ajuda",
      locale: "pt-BR",
      ...extra,
    },
    appDb,
    allowAll,
  );
}

const sync = (fetchImpl: typeof fetch) =>
  syncKnowledgeSource(tenantId, kb, {
    base: appDb,
    fetchImpl,
    assertSafe: allowAll,
  });

// What an ingest would have left: the synced documents indexed, so a sync that re-embeds shows up
// as a document back on PENDING.
const markIndexed = () =>
  suDb.knowledgeDocument.updateMany({
    where: { knowledgeBaseId: kb },
    data: { status: "READY" },
  });

describe.skipIf(!dbUp)("knowledge base source (issue #794)", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "KS794", slug: `ks-794-${process.pid}` },
      })
    ).id;
  });

  beforeEach(async () => {
    await suDb.knowledgeBase.deleteMany({ where: { tenantId } });
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    kb = (
      await suDb.knowledgeBase.create({
        data: { tenantId, name: "ajuda-portal" },
      })
    ).id;
    curated = (
      await suDb.knowledgeDocument.create({
        data: {
          tenantId,
          knowledgeBaseId: kb,
          title: "Nota interna de frete",
          sourceType: "text",
          content: "CURADO-1",
          status: "READY",
        },
      })
    ).id;
  });

  afterAll(async () => {
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a first sync creates one document per article, keyed and linked, and leaves the curated one", async () => {
    await configure();
    const r = await sync(portal({ articles: () => BASIC }));
    expect(r).toMatchObject({ created: 3, updated: 0, deleted: 0 });
    const docs = await synced();
    expect(
      docs.map((d) => [d.externalId, d.title, d.content, d.sourceType]),
    ).toEqual([
      [
        "101",
        "Como trocar o endereço de entrega",
        "MARCADOR-101-v1",
        "chatwoot_portal",
      ],
      ["102", "Prazo de reembolso", "MARCADOR-102-v1", "chatwoot_portal"],
      ["103", "Horário de atendimento", "MARCADOR-103-v1", "chatwoot_portal"],
    ]);
    expect(docs[0]?.sourceUrl).toBe(`${PORTAL}/hc/ajuda/articles/101-artigo`);
    const c = await suDb.knowledgeDocument.findUnique({
      where: { id: curated },
    });
    expect(c).toMatchObject({
      content: "CURADO-1",
      externalId: null,
      status: "READY",
    });
    const state = await getSource(ctx(), kb, appDb);
    expect(state).toMatchObject({ kind: "chatwoot_portal", lastStatus: "ok" });
  });

  test("a changed body updates the same document and re-embeds it; the others are untouched", async () => {
    await configure();
    let arts = BASIC;
    await sync(portal({ articles: () => arts }));
    await markIndexed();
    const before = await synced();
    arts = BASIC.map((a) =>
      a.id === 101 ? { ...a, content: "MARCADOR-101-v2" } : a,
    );
    const r = await sync(portal({ articles: () => arts }));
    expect(r).toMatchObject({
      created: 0,
      updated: 1,
      deleted: 0,
      unchanged: 2,
    });
    const after = await synced();
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(after[0]).toMatchObject({
      content: "MARCADOR-101-v2",
      status: "PENDING",
    });
    expect(after[1]).toMatchObject({ status: "READY" });
    expect(after[2]).toMatchObject({ status: "READY" });
  });

  test("a changed title alone updates the title without re-embedding", async () => {
    await configure();
    let arts = BASIC;
    await sync(portal({ articles: () => arts }));
    await markIndexed();
    arts = BASIC.map((a) =>
      a.id === 103 ? { ...a, title: "Horário de atendimento no feriado" } : a,
    );
    const r = await sync(portal({ articles: () => arts }));
    expect(r).toMatchObject({ updated: 1 });
    const d = (await synced())[2];
    expect(d).toMatchObject({
      title: "Horário de atendimento no feriado",
      content: "MARCADOR-103-v1",
      status: "READY",
    });
  });

  test("an article off the portal deletes its document and only it", async () => {
    await configure();
    let arts = BASIC;
    await sync(portal({ articles: () => arts }));
    const [d101, , d103] = await synced();
    arts = BASIC.filter((a) => a.id !== 102);
    const r = await sync(portal({ articles: () => arts }));
    expect(r).toMatchObject({ deleted: 1 });
    const left = await synced();
    expect(left.map((d) => d.id)).toEqual([
      d101?.id as bigint,
      d103?.id as bigint,
    ]);
    expect(
      await suDb.knowledgeDocument.findUnique({ where: { id: curated } }),
    ).not.toBeNull();
  });

  test("a curated document with an article's title is never adopted nor touched", async () => {
    await suDb.knowledgeDocument.update({
      where: { id: curated },
      data: { title: "Prazo de reembolso", content: "CURADO-2" },
    });
    await configure();
    let arts = BASIC;
    await sync(portal({ articles: () => arts }));
    const titled = await suDb.knowledgeDocument.findMany({
      where: { knowledgeBaseId: kb, title: "Prazo de reembolso" },
      orderBy: { id: "asc" },
    });
    expect(titled.map((d) => [d.id, d.externalId, d.content])).toEqual([
      [curated, null, "CURADO-2"],
      [titled[1]?.id as bigint, "102", "MARCADOR-102-v1"],
    ]);
    arts = BASIC.filter((a) => a.id !== 102);
    await sync(portal({ articles: () => arts }));
    const c = await suDb.knowledgeDocument.findUnique({
      where: { id: curated },
    });
    expect(c).toMatchObject({
      title: "Prazo de reembolso",
      content: "CURADO-2",
    });
  });

  test("two articles with the same title are two documents, and a second sync adds none", async () => {
    await configure();
    const arts = [
      ...BASIC,
      { id: 201, title: "Política de troca", content: "MARCADOR-201" },
      { id: 202, title: "Política de troca", content: "MARCADOR-202" },
    ];
    await sync(portal({ articles: () => arts }));
    const first = await synced();
    const r = await sync(portal({ articles: () => arts }));
    expect(r).toMatchObject({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 5,
    });
    const second = await synced();
    expect(second.map((d) => d.id)).toEqual(first.map((d) => d.id));
    expect(
      second
        .filter((d) => d.title === "Política de troca")
        .map((d) => d.content),
    ).toEqual(["MARCADOR-201", "MARCADOR-202"]);
  });

  test("the exclusion list leaves articles out, and changing it is reconciled", async () => {
    await configure({ excludeIds: [102] });
    await sync(portal({ articles: () => BASIC }));
    expect((await synced()).map((d) => d.externalId)).toEqual(["101", "103"]);
    const d101 = (await synced())[0]?.id;
    await configure({ excludeIds: [103] });
    await sync(portal({ articles: () => BASIC }));
    const docs = await synced();
    expect(docs.map((d) => d.externalId)).toEqual(["101", "102"]);
    expect(docs[0]?.id).toBe(d101 as bigint);
    expect((await getSource(ctx(), kb, appDb))?.excludeIds).toEqual([103]);
  });

  test("an empty listing deletes nothing and leaves a warning on the source", async () => {
    await configure();
    let arts: Art[] = BASIC;
    await sync(portal({ articles: () => arts }));
    const before = (await synced()).map((d) => d.id);
    arts = [];
    const r = await sync(portal({ articles: () => arts }));
    expect(r).toMatchObject({ deleted: 0, emptyListing: true });
    expect((await synced()).map((d) => d.id)).toEqual(before);
    expect(await getSource(ctx(), kb, appDb)).toMatchObject({
      lastStatus: "warning",
    });
    arts = BASIC;
    await sync(portal({ articles: () => arts }));
    expect((await synced()).map((d) => d.id)).toEqual(before);
  });

  test("a failed fetch changes nothing and records the error", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    const before = await synced();
    const changed = BASIC.map((a) => ({ ...a, content: `${a.content}-novo` }));
    expect(
      await sync(portal({ articles: () => changed, failPage: () => 500 })),
    ).toBeNull();
    expect(await getSource(ctx(), kb, appDb)).toMatchObject({
      lastStatus: "error",
    });
    const down = (async () => {
      throw new TypeError("fetch failed: connection refused");
    }) as unknown as typeof fetch;
    expect(await sync(down)).toBeNull();
    const after = await synced();
    expect(after.map((d) => [d.id, d.title, d.content])).toEqual(
      before.map((d) => [d.id, d.title, d.content]),
    );
  });

  test("a failure on a later page deletes nothing that was on it", async () => {
    await configure();
    const many: Art[] = Array.from({ length: 130 }, (_, i) => ({
      id: 301 + i,
      title: `Artigo ${301 + i}`,
      content: `MARCADOR-${301 + i}`,
    }));
    await sync(portal({ articles: () => many }));
    expect(await synced()).toHaveLength(130);
    const r = await sync(
      portal({ articles: () => many, failPage: (p) => (p >= 2 ? 500 : null) }),
    );
    expect(r).toBeNull();
    expect(await synced()).toHaveLength(130);
  });

  test("the listing is read past its first page, however the portal pages it", async () => {
    await configure();
    const many: Art[] = Array.from({ length: 130 }, (_, i) => ({
      id: 301 + i,
      title: `Artigo ${301 + i}`,
      content: `MARCADOR-${301 + i}`,
    }));
    const requests: string[] = [];
    await sync(portal({ articles: () => many, requests }));
    // Two pages of 100 for 130 articles, and not a third: the declared count ends the listing.
    expect(requests).toHaveLength(2);
    const docs = await synced();
    expect(new Set(docs.map((d) => d.externalId)).size).toBe(130);
    expect(docs.find((d) => d.externalId === "430")?.content).toBe(
      "MARCADOR-430",
    );
    // A portal whose page is smaller than asked (a cap below 100) is still read to the end.
    await suDb.knowledgeDocument.deleteMany({
      where: { knowledgeBaseId: kb, externalId: { not: null } },
    });
    await sync(portal({ articles: () => many, pageCap: 25 }));
    expect(await synced()).toHaveLength(130);
    // And one that ignores `page` and returns everything every time ends instead of looping.
    await sync(portal({ articles: () => many, ignorePage: true }));
    expect(await synced()).toHaveLength(130);
  });

  test("a renamed article slug moves the document's URL without re-embedding it", async () => {
    await configure();
    let arts = BASIC;
    await sync(portal({ articles: () => arts }));
    await markIndexed();
    arts = BASIC.map((a) =>
      a.id === 101 ? { ...a, slug: "101-endereco-de-entrega" } : a,
    );
    const r = await sync(portal({ articles: () => arts }));
    expect(r).toMatchObject({ updated: 1, unchanged: 2 });
    expect((await synced())[0]).toMatchObject({
      sourceUrl: `${PORTAL}/hc/ajuda/articles/101-endereco-de-entrega`,
      content: "MARCADOR-101-v1",
      status: "READY",
    });
  });

  test("a draft the portal serves is not synced", async () => {
    await configure();
    const arts = [
      ...BASIC,
      { id: 150, title: "Rascunho", content: "RASCUNHO", status: "draft" },
    ];
    await sync(portal({ articles: () => arts, leakDrafts: true }));
    expect((await synced()).map((d) => d.externalId)).toEqual([
      "101",
      "102",
      "103",
    ]);
  });

  test("the fetch never follows a redirect, and the SSRF check is asked again on every run", async () => {
    await configure();
    const redirects: (RequestRedirect | undefined)[] = [];
    await sync(portal({ articles: () => BASIC, redirects }));
    expect(redirects.length).toBeGreaterThan(0);
    expect(new Set(redirects)).toEqual(new Set(["manual"]));
    // The name that resolved publicly when the source was saved now resolves privately.
    const refused = await syncKnowledgeSource(tenantId, kb, {
      base: appDb,
      fetchImpl: portal({
        articles: () => BASIC.filter((a) => a.id !== 101),
      }),
      assertSafe: async () => {
        throw new Error("resolves to a private address");
      },
    });
    expect(refused).toBeNull();
    expect(await getSource(ctx(), kb, appDb)).toMatchObject({
      lastStatus: "error",
    });
    expect(await synced()).toHaveLength(3);
  });

  test("a portal with no count that ignores the page is read once, not until the page limit", async () => {
    await configure();
    // A full first page (so a short page does not end the listing) and no declared count: only the
    // absence of new ids on page 2 can end it.
    const many: Art[] = Array.from({ length: 130 }, (_, i) => ({
      id: 301 + i,
      title: `Artigo ${301 + i}`,
      content: `MARCADOR-${301 + i}`,
    }));
    const requests: string[] = [];
    const r = await sync(
      portal({
        articles: () => many,
        ignorePage: true,
        noCount: true,
        requests,
      }),
    );
    expect(r).toMatchObject({ created: 130 });
    expect(requests).toHaveLength(2);
  });

  test("a listing that runs dry before its declared count deletes nothing", async () => {
    await configure();
    const many: Art[] = Array.from({ length: 130 }, (_, i) => ({
      id: 301 + i,
      title: `Artigo ${301 + i}`,
      content: `MARCADOR-${301 + i}`,
    }));
    await sync(portal({ articles: () => many }));
    expect(await synced()).toHaveLength(130);
    // Page 2 comes back empty, then a portal that repeats page 1: 100 of the 130 it declares.
    for (const extra of [{}, { ignorePage: true }]) {
      const r = await sync(
        portal({ articles: () => many, truncateAt: 100, ...extra }),
      );
      expect(r).toBeNull();
      expect(await synced()).toHaveLength(130);
      expect(await getSource(ctx(), kb, appDb)).toMatchObject({
        lastStatus: "error",
      });
    }
  });

  test("a portal that stalls its body is cut by the timeout, not waited on", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    const stalled = (async (_u: string, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"payload":['));
            init?.signal?.addEventListener("abort", () =>
              c.error(new Error("aborted")),
            );
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await syncKnowledgeSource(tenantId, kb, {
      base: appDb,
      fetchImpl: stalled,
      assertSafe: allowAll,
      timeoutMs: 200,
    });
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await synced()).toHaveLength(3);
  });

  test("a run whose source is removed or replaced while it fetches writes nothing", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    await markIndexed();
    const before = await synced();
    const changed = [
      { ...BASIC[0], content: "MARCADOR-101-v2" } as Art,
      { id: 104, title: "Troca de tamanho", content: "MARCADOR-104" },
    ];
    const meanwhile = (act: () => Promise<unknown>) => {
      const inner = portal({ articles: () => changed });
      return (async (u: string, init?: RequestInit) => {
        await act();
        return inner(u, init);
      }) as unknown as typeof fetch;
    };
    // Removed: the run finds the source gone at its first write and stops.
    expect(
      await sync(meanwhile(() => deleteSource(ctx(), kb, appDb))),
    ).toBeNull();
    const afterRemoval = await synced();
    expect(afterRemoval.map((d) => [d.id, d.content, d.status])).toEqual(
      before.map((d) => [d.id, d.content, d.status]),
    );
    // Replaced with another config: the stale run's listing no longer answers for the base.
    await configure();
    expect(
      await sync(meanwhile(() => configure({ excludeIds: [103] }))),
    ).toBeNull();
    expect((await synced()).map((d) => [d.id, d.content])).toEqual(
      before.map((d) => [d.id, d.content]),
    );
  });

  test("two syncs at once create each document once", async () => {
    await configure();
    const f = portal({ articles: () => BASIC });
    await Promise.all([sync(f), sync(f)]);
    const docs = await synced();
    expect(docs.map((d) => d.externalId)).toEqual(["101", "102", "103"]);
  });

  test("a synced document refuses edits and deletion while the base has a source; the curated one does not", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    const d = (await synced())[0] as { id: bigint };
    await expect(
      updateDocument(ctx(), d.id, { title: "editado" }, appDb),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateDocument(ctx(), d.id, { text: "texto editado" }, appDb),
    ).rejects.toThrow(/fix the article in the portal/);
    await expect(deleteDocument(ctx(), d.id, appDb)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await updateDocument(
      ctx(),
      curated,
      { title: "Nota interna de frete revisada" },
      appDb,
    );
    expect(
      (await suDb.knowledgeDocument.findUnique({ where: { id: curated } }))
        ?.title,
    ).toBe("Nota interna de frete revisada");
    expect((await synced())[0]).toMatchObject({
      title: "Como trocar o endereço de entrega",
      content: "MARCADOR-101-v1",
    });
  });

  test("the MCP document tools refuse a synced document, in the preview too", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    const id = String((await synced())[1]?.id);
    for (const dry of [undefined, false]) {
      const upd = (await knowledgeDocumentUpdate(
        principal(),
        { document_id: id, text: "texto editado", dry_run: dry },
        { base: appDb },
      )) as { ok: boolean; error?: string };
      expect(upd.ok).toBe(false);
      expect(upd.error).toMatch(/fix the article in the portal/);
      const del = (await knowledgeDocumentDelete(
        principal(),
        { document_id: id, dry_run: dry },
        { base: appDb },
      )) as { ok: boolean };
      expect(del.ok).toBe(false);
    }
    expect((await synced())[1]?.content).toBe("MARCADOR-102-v1");
  });

  test("removing the source keeps the documents with their ids, stops the sync, and a source put back readopts them", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    const before = await synced();
    await deleteSource(ctx(), kb, appDb);
    expect(await getSource(ctx(), kb, appDb)).toBeNull();
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "KNOWLEDGE_SOURCE_SYNC" },
    });
    expect(job?.status).not.toBe("PENDING");
    // No source: a run finds nothing to do and touches nothing.
    expect(await sync(portal({ articles: () => [] }))).toBeNull();
    expect((await synced()).map((d) => d.id)).toEqual(before.map((d) => d.id));
    // Without a source they are ordinary documents again.
    await updateDocument(
      ctx(),
      before[0]?.id as bigint,
      { title: "agora editável" },
      appDb,
    );
    await configure();
    const arts = [
      ...BASIC.filter((a) => a.id !== 102),
      { id: 104, title: "Troca de tamanho", content: "MARCADOR-104" },
    ];
    await sync(portal({ articles: () => arts }));
    const after = await synced();
    expect(after.map((d) => d.externalId)).toEqual(["101", "103", "104"]);
    expect(after[0]?.id).toBe(before[0]?.id as bigint);
    expect(after[0]?.title).toBe("Como trocar o endereço de entrega");
    expect(after[1]?.id).toBe(before[2]?.id as bigint);
  });

  test("setting a source and asking for a sync arm the job for now; a base without a source refuses", async () => {
    await expect(requestSync(ctx(), kb, appDb)).rejects.toMatchObject({
      statusCode: 409,
    });
    await configure();
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "KNOWLEDGE_SOURCE_SYNC" },
    });
    expect(job).toMatchObject({ status: "PENDING", dedupeKey: `source:${kb}` });
    expect(
      job?.runAt.getTime() ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(Date.now());
    await suDb.schedulerJob.update({
      where: { id: job?.id as bigint },
      data: { runAt: new Date(Date.now() + 3_600_000) },
    });
    await requestSync(ctx(), kb, appDb);
    const again = await suDb.schedulerJob.findUnique({
      where: { id: job?.id as bigint },
    });
    expect(
      again?.runAt.getTime() ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(Date.now());
  });

  test("a search over a synced article carries its URL into the passage the model reads", async () => {
    await configure();
    await sync(portal({ articles: () => BASIC }));
    const doc = (await synced())[1] as { id: bigint };
    const unit = (i: number) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      v[i] = 1;
      return v;
    };
    await runScopedOn(appDb, ctx(), (db) =>
      insertChunks(db, [
        {
          tenantId,
          knowledgeBaseId: kb,
          documentId: doc.id,
          content: "MARCADOR-102-v1",
          embedding: unit(0),
        },
        {
          tenantId,
          knowledgeBaseId: kb,
          documentId: curated,
          content: "CURADO-1",
          embedding: unit(1),
        },
      ]),
    );
    const hits = await runScopedOn(appDb, ctx(), (db) =>
      searchChunks(db, {
        knowledgeBaseIds: [kb],
        queryEmbedding: unit(0),
        limit: 2,
      }),
    );
    const article = hits.find((h) => h.documentId === doc.id);
    const note = hits.find((h) => h.documentId === curated);
    expect(article?.documentUrl).toBe(`${PORTAL}/hc/ajuda/articles/102-artigo`);
    expect(note?.documentUrl).toBeNull();
    expect(passageWithSource(article as NonNullable<typeof article>)).toBe(
      `(source: ajuda-portal, ${PORTAL}/hc/ajuda/articles/102-artigo) MARCADOR-102-v1`,
    );
    expect(passageWithSource(note as NonNullable<typeof note>)).toBe(
      "(source: ajuda-portal) CURADO-1",
    );
  });

  test("the MCP source tools preview without writing and apply with dry_run false", async () => {
    const args = {
      knowledge_base_id: String(kb),
      kind: "chatwoot_portal",
      base_url: "https://1.1.1.1",
      slug: "ajuda",
      locale: "pt-BR",
    };
    const preview = (await knowledgeSourceSet(principal(), args, {
      base: appDb,
    })) as {
      ok: boolean;
    };
    // The preview asks what the apply asks: a slug the apply refuses is refused here too.
    const badPreview = (await knowledgeSourceSet(
      principal(),
      { ...args, slug: "a/b" },
      { base: appDb },
    )) as { ok: boolean; error?: string };
    expect(badPreview.ok).toBe(false);
    expect(badPreview.error).toMatch(/slug/);
    expect(preview.ok).toBe(true);
    expect(await getSource(ctx(), kb, appDb)).toBeNull();
    const applied = (await knowledgeSourceSet(
      principal(),
      { ...args, dry_run: false },
      { base: appDb },
    )) as { ok: boolean };
    expect(applied.ok).toBe(true);
    expect(await getSource(ctx(), kb, appDb)).not.toBeNull();
    const syncPreview = (await knowledgeSourceSync(
      principal(),
      { knowledge_base_id: String(kb) },
      { base: appDb },
    )) as { ok: boolean };
    expect(syncPreview.ok).toBe(true);
    const removePreview = (await knowledgeSourceRemove(
      principal(),
      { knowledge_base_id: String(kb) },
      { base: appDb },
    )) as { ok: boolean };
    expect(removePreview.ok).toBe(true);
    expect(await getSource(ctx(), kb, appDb)).not.toBeNull();
    const removed = (await knowledgeSourceRemove(
      principal(),
      { knowledge_base_id: String(kb), dry_run: false },
      { base: appDb },
    )) as { ok: boolean };
    expect(removed.ok).toBe(true);
    expect(await getSource(ctx(), kb, appDb)).toBeNull();
  });
});

describe("knowledge source input (issue #794)", () => {
  const good = {
    kind: "chatwoot_portal",
    baseUrl: `${PORTAL}/`,
    slug: "ajuda",
    locale: "pt-BR",
  };

  test("a valid input is normalized", async () => {
    const p = await parseSourceInput(
      { ...good, excludeIds: [7, 3, 7] },
      allowAll,
    );
    expect(p).toEqual({
      kind: "chatwoot_portal",
      config: {
        baseUrl: PORTAL,
        slug: "ajuda",
        locale: "pt-BR",
        excludeIds: [3, 7],
      },
      intervalMinutes: 10,
    });
  });

  test.each([
    [{ ...good, kind: "url_crawl" }, "kind"],
    [{ ...good, slug: undefined }, "slug"],
    [{ ...good, slug: "a/b" }, "slug"],
    [{ ...good, locale: "" }, "locale"],
    [{ ...good, excludeIds: ["abc"] }, "excludeIds"],
    [{ ...good, excludeIds: [0] }, "excludeIds"],
    [{ ...good, intervalMinutes: 1 }, "intervalMinutes"],
    [{ ...good, baseUrl: "" }, "baseUrl"],
  ])("refuses %p on %s", async (input, field) => {
    await expect(parseSourceInput(input, allowAll)).rejects.toMatchObject({
      statusCode: 400,
      field,
    });
  });

  test.each([
    "http://example.com",
    "https://10.0.0.5",
    "https://169.254.169.254",
    "https://127.0.0.1",
  ])("the SSRF guard refuses %s", async (baseUrl) => {
    await expect(
      parseSourceInput({ ...good, baseUrl }, (u) =>
        assertSafeOutboundUrl(u, { allowPrivate: false }),
      ),
    ).rejects.toMatchObject({ statusCode: 400, field: "baseUrl" });
  });
});
