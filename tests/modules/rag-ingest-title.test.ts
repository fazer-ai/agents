import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { knowledgeReindex } from "@/modules/mcp/write-knowledge";
import {
  createDocument,
  EMBED_TITLE_MAX_CHARS,
  embeddingInput,
  registerRagIngestHandler,
  reindexKnowledgeBase,
  updateDocument,
} from "@/modules/rag/documents";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import { getJobHandler } from "@/modules/scheduler/worker";
import { updateEmbeddingSettings } from "@/modules/tenant-settings/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Issue #857: a document's title is part of what its chunks are embedded from.
//
// A help center article's title is the question the customer asks, and its body often never restates
// it. Embedding the body alone made "the activation e-mail never arrives" miss the article of that
// name. The vector of every chunk is computed over the title and the chunk; the chunk stored and read
// by the agent is still the chunk alone. The double below records every input the ingest sends to the
// embedding endpoint, which is what these tests assert on.

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

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The embedding provider, personified: an OpenAI-compatible /embeddings endpoint that records every
// input it is asked to embed, which is what these tests assert on.
let embedServer: ReturnType<typeof Bun.serve> | undefined;
let baseURL = "";
const embedded: string[][] = [];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// happy-dom replaces the global Response, and Bun's TCP socket layer does not recognize the spec
// one — tests/dom-setup.ts captures the native constructor for exactly this case.
const BunRes = (globalThis as { BunResponse?: typeof Response })
  .BunResponse as typeof Response;

function json(body: unknown, status = 200): Response {
  return new BunRes(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function fakeVector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) =>
    Number((((seed + 1) * (i + 1)) % 97) / 97),
  );
}

// The OpenAI SDK asks for `encoding_format: "base64"` and decodes a Float32Array out of it. A double
// that always answered with a plain number array would be decoded as garbage of the wrong width, so
// the double answers in whichever format was asked for, the way the real endpoint does.
function toBase64(vec: number[]): string {
  const buf = new Float32Array(vec);
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString(
    "base64",
  );
}

let savedAllowPrivate = false;

beforeAll(() => {
  if (!dbUp) return;
  // The fixture below is a loopback embedding endpoint reached through the REAL ingest path, and
  // `embedCompatible` now runs the SSRF guard on the operator-configured URL before fetching — which
  // refuses 127.0.0.1 under NODE_ENV=test, exactly as it would in production. Same save/restore the
  // mcp-oauth suite uses for its own loopback fixture; reaching a private endpoint for real is the
  // operator's explicit SSRF_ALLOW_PRIVATE_TARGETS opt-in, and it is not what this suite is about.
  savedAllowPrivate = config.ssrf.allowPrivateTargets;
  config.ssrf.allowPrivateTargets = true;
  embedServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // NOTE: The suite preloads happy-dom, so the OpenAI SDK takes the browser path and preflights.
      if (req.method === "OPTIONS") {
        return new BunRes(null, { status: 204, headers: cors });
      }
      if (!url.pathname.endsWith("/embeddings")) {
        return new BunRes("not found", { status: 404, headers: cors });
      }
      const body = (await req.json()) as {
        input: string[] | string;
        encoding_format?: string;
      };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      embedded.push(inputs);
      return json({
        object: "list",
        model: "text-embedding-3-small",
        data: inputs.map((_, i) => ({
          object: "embedding",
          index: i,
          embedding:
            body.encoding_format === "base64"
              ? toBase64(fakeVector(i))
              : fakeVector(i),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    },
  });
  baseURL = `http://127.0.0.1:${embedServer.port}/v1`;
});

const tenants: bigint[] = [];

async function seedTenant(slug: string): Promise<{ id: bigint; kb: bigint }> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  tenants.push(t.id);
  // NOTE: the credential carries the baseURL (resolveEmbeddingStatus reads it off the secret), which is
  // what points the ingest at the double above without unlocking the settings block.
  const cred = await suDb.vaultEntry.create({
    data: {
      tenantId: t.id,
      name: `${slug}-embed`,
      kind: "generic",
      status: "active",
      secret: encryptJson({ apiKey: "test-key", baseURL }),
    },
  });
  await updateEmbeddingSettings(
    ctx(t.id),
    { credentialRef: `vault:${cred.id}` },
    appDb,
  );
  const kb = await suDb.knowledgeBase.create({
    data: {
      tenantId: t.id,
      name: `${slug}-kb`,
      embeddingModel: "text-embedding-3-small",
      chunkSize: 1000,
      chunkOverlap: 0,
    },
  });
  return { id: t.id, kb: kb.id };
}

// The REAL job handler, the same entry point the scheduler uses.
async function runIngestOn(
  base: PrismaClient,
  tenantId: bigint,
  documentId: bigint,
) {
  registerRagIngestHandler();
  const handler = getJobHandler("RAG_INGEST");
  if (!handler) throw new Error("RAG_INGEST handler not registered");
  return handler(
    {
      id: 0n,
      tenantId,
      kind: "RAG_INGEST",
      payload: { documentId: String(documentId) },
      attempts: 0,
      claimSeq: 0,
    },
    base,
  );
}

async function runIngest(tenantId: bigint, documentId: bigint) {
  return runIngestOn(appDb, tenantId, documentId);
}

async function readDoc(tenantId: bigint, id: bigint) {
  return runScopedOn(appDb, ctx(tenantId), (db) =>
    db.knowledgeDocument.findUniqueOrThrow({
      where: { id },
      select: { status: true, content: true, chunkCount: true },
    }),
  );
}

// What search actually reads. The document row is not the answer to this issue — the chunks are.
async function readChunks(tenantId: bigint, id: bigint): Promise<string[]> {
  const rows = await suDb.$queryRaw<{ content: string }[]>`
    SELECT content FROM knowledge_chunks
    WHERE tenant_id = ${tenantId} AND document_id = ${id}
    ORDER BY id`;
  return rows.map((r) => r.content);
}

afterAll(async () => {
  config.ssrf.allowPrivateTargets = savedAllowPrivate;
  embedServer?.stop(true);
  if (!dbUp) return;
  for (const id of tenants) {
    await suDb.$executeRaw`DELETE FROM knowledge_chunks WHERE tenant_id = ${id}`;
    await suDb.$executeRaw`DELETE FROM knowledge_documents WHERE tenant_id = ${id}`;
    await suDb.$executeRaw`DELETE FROM knowledge_bases WHERE tenant_id = ${id}`;
    await suDb.$executeRaw`DELETE FROM vault_entries WHERE tenant_id = ${id}`;
    await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${id}`;
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${id}`;
  }
  await su?.$disconnect();
  await app?.$disconnect();
});

const sent = () => embedded.flat();

async function jobFor(tenantId: bigint, documentId: bigint) {
  return suDb.schedulerJob.findFirst({
    where: { tenantId, kind: "RAG_INGEST", dedupeKey: `doc:${documentId}` },
    select: { status: true },
  });
}

describe.skipIf(!dbUp)("RAG ingest: the title is part of the vector", () => {
  test("every chunk is embedded with the title, and stored without it", async () => {
    const { id, kb } = await seedTenant("title-embed");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Erro ao abrir o link de transferência",
      sourceType: "text",
      text: "Atualize o aplicativo e tente de novo pelo navegador.",
      base: appDb,
    });
    embedded.length = 0;
    await runIngest(id, doc.id);

    expect(sent()).toEqual([
      "Erro ao abrir o link de transferência\n\nAtualize o aplicativo e tente de novo pelo navegador.",
    ]);
    expect(await readChunks(id, doc.id)).toEqual([
      "Atualize o aplicativo e tente de novo pelo navegador.",
    ]);
    expect((await readDoc(id, doc.id)).status).toBe("READY");
  });

  test("a document of several chunks carries the title on each one", async () => {
    const { id, kb } = await seedTenant("title-chunks");
    await suDb.knowledgeBase.update({
      where: { id: kb },
      data: { chunkSize: 100, chunkOverlap: 0 },
    });
    const text = Array.from(
      { length: 6 },
      (_, i) =>
        `Parágrafo ${i} com texto suficiente para ocupar espaço no pedaço.`,
    ).join("\n\n");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Reembolso",
      sourceType: "text",
      text,
      base: appDb,
    });
    embedded.length = 0;
    await runIngest(id, doc.id);

    const chunks = await readChunks(id, doc.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(sent()).toEqual(chunks.map((c) => `Reembolso\n\n${c}`));
    for (const c of chunks) expect(c.startsWith("Reembolso")).toBe(false);
  });

  test("a changed title alone re-embeds, and the chunks keep their text", async () => {
    const { id, kb } = await seedTenant("title-edit");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Não recebi o e-mail de ativação",
      sourceType: "text",
      text: "Confira a caixa de spam.",
      base: appDb,
    });
    await runIngest(id, doc.id);

    const r = await updateDocument(
      ctxOf(id),
      doc.id,
      { title: "Código de ativação nunca chega" },
      appDb,
    );
    expect(r.status).toBe("PENDING");
    expect((await jobFor(id, doc.id))?.status).toBe("PENDING");

    embedded.length = 0;
    await runIngest(id, doc.id);
    expect(sent()).toEqual([
      "Código de ativação nunca chega\n\nConfira a caixa de spam.",
    ]);
    expect(await readChunks(id, doc.id)).toEqual(["Confira a caixa de spam."]);
    expect((await readDoc(id, doc.id)).status).toBe("READY");
  });

  test("the same title sent again is not a change and embeds nothing", async () => {
    const { id, kb } = await seedTenant("title-same");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Horário da bilheteria",
      sourceType: "text",
      text: "Das 10h às 18h.",
      base: appDb,
    });
    await runIngest(id, doc.id);
    const r = await updateDocument(
      ctxOf(id),
      doc.id,
      { title: "Horário da bilheteria" },
      appDb,
    );
    expect(r.status).toBe("READY");
  });

  test("a blank title is refused and the document is untouched", async () => {
    const { id, kb } = await seedTenant("title-blank");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Meia-entrada",
      sourceType: "text",
      text: "Estudantes pagam metade.",
      base: appDb,
    });
    await runIngest(id, doc.id);
    for (const title of ["", "   "]) {
      await expect(
        updateDocument(ctxOf(id), doc.id, { title }, appDb),
      ).rejects.toMatchObject({ statusCode: 400, field: "title" });
    }
    const row = await readDoc(id, doc.id);
    expect(row.status).toBe("READY");
  });

  test("an indexed base is re-embedded only when the operator asks, and all of it", async () => {
    const { id, kb } = await seedTenant("title-reindex");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Taxa de serviço",
      sourceType: "text",
      text: "Cobrada por ingresso.",
      base: appDb,
    });
    await runIngest(id, doc.id);

    expect(await reindexKnowledgeBase(ctxOf(id), kb, appDb)).toEqual({
      queued: 0,
    });
    expect((await readDoc(id, doc.id)).status).toBe("READY");

    expect(
      await reindexKnowledgeBase(ctxOf(id), kb, appDb, {
        includeIndexed: true,
      }),
    ).toEqual({ queued: 1 });
    expect((await readDoc(id, doc.id)).status).toBe("PENDING");
    embedded.length = 0;
    await runIngest(id, doc.id);
    expect(sent()).toEqual(["Taxa de serviço\n\nCobrada por ingresso."]);
    expect(await readChunks(id, doc.id)).toEqual(["Cobrada por ingresso."]);
  });
});

describe.skipIf(!dbUp)("MCP knowledge_reindex: include_indexed", () => {
  test("re-queues the READY documents only when asked", async () => {
    const { id, kb } = await seedTenant("title-mcp");
    const doc = await createDocument({
      ctx: ctxOf(id),
      knowledgeBaseId: kb,
      title: "Pontos de venda",
      sourceType: "text",
      text: "Lista no site.",
      base: appDb,
    });
    await runIngest(id, doc.id);
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId: id,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    };
    const args = { knowledge_base_id: String(kb), dry_run: false };
    expect(
      await knowledgeReindex(principal, args, { base: appDb }),
    ).toMatchObject({
      ok: true,
      data: { queued: 0 },
    });
    expect(
      await knowledgeReindex(
        principal,
        { ...args, include_indexed: true },
        { base: appDb },
      ),
    ).toMatchObject({ ok: true, data: { queued: 1 } });
    expect((await readDoc(id, doc.id)).status).toBe("PENDING");
  });
});

describe("embeddingInput", () => {
  test("the title heads the chunk, trimmed, with a blank line between them", () => {
    expect(embeddingInput("  Reembolso \n", "Em até 7 dias.")).toBe(
      "Reembolso\n\nEm até 7 dias.",
    );
  });

  test("a blank title adds nothing", () => {
    expect(embeddingInput("   ", "Em até 7 dias.")).toBe("Em até 7 dias.");
    expect(embeddingInput("", "Em até 7 dias.")).toBe("Em até 7 dias.");
  });

  test("a long title is capped, so it cannot crowd the chunk out of the input", () => {
    const title = "t".repeat(EMBED_TITLE_MAX_CHARS + 200);
    expect(embeddingInput(title, "corpo")).toBe(
      `${"t".repeat(EMBED_TITLE_MAX_CHARS)}\n\ncorpo`,
    );
  });
});
