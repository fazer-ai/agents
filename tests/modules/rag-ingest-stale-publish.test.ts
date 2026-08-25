import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  createDocument,
  registerRagIngestHandler,
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

// Issue #163: editing a document WHILE it is being indexed used to discard the edit, silently.
//
// Chunking and embedding run outside any transaction (they are network I/O), which is minutes of
// window on a large document. An edit landing in that window sets the row back to PENDING — that is
// how a re-index is requested — and the in-flight run then published `READY` with no status guard,
// erasing the marker the re-armed job needed. The re-armed job re-read the row, saw READY, and
// returned; the row kept the new text and search kept the chunks built from the old one, forever.
//
// The guard is the publish itself: a run may only publish while the row is still PROCESSING, i.e.
// while it is still the run that owns the document. It runs FIRST inside the replace-chunks
// transaction, so a stale run also writes no chunks at all and search keeps answering from the last
// consistent index instead of going wrong for a while.
//
// The embed is not the only window, and the last test here covers the other one: the text to index
// and the PROCESSING mark are read in ONE transaction, because an edit landing between a separate
// read and the mark leaves the row PENDING (the value it already had) — so the mark is taken
// successfully, over text the document no longer has.

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
// A SECOND app connection. The edit injected mid-run has to commit while the job's own transaction
// is still open, which one client cannot do with itself.
const editDb = dbUp
  ? new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.TEST_APP_DATABASE_URL as string,
      }),
    })
  : (undefined as unknown as PrismaClient);

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The embedding provider, personified: an OpenAI-compatible /embeddings endpoint. It exists to hold
// the request open, because the window this issue is about IS the duration of that call — a double
// that returned instantly would never let an edit land mid-run.
let embedServer: ReturnType<typeof Bun.serve> | undefined;
let baseURL = "";
// Fires once, while a request is in flight. This is the operator typing.
let duringEmbed: (() => Promise<void>) | null = null;
// 400 is deliberate: the OpenAI SDK retries 5xx, so a 500 would fire the run several times.
let embedMode: "ok" | "reject" = "ok";
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

beforeAll(() => {
  if (!dbUp) return;
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
      if (duringEmbed) {
        const hook = duringEmbed;
        duringEmbed = null;
        await hook();
      }
      if (embedMode === "reject") {
        return json(
          { error: { message: "embedding rejected", type: "invalid_request" } },
          400,
        );
      }
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
  await editDb?.$disconnect();
});

describe.skipIf(!dbUp)(
  "RAG ingest: an edit during indexing is not discarded",
  () => {
    test("baseline: an uncontended ingest indexes the document", async () => {
      const { id, kb } = await seedTenant("rag-base");
      const doc = await createDocument({
        ctx: ctxOf(id),
        knowledgeBaseId: kb,
        title: "policy",
        sourceType: "text",
        text: "ORIGINAL TEXT",
        base: appDb,
      });

      await runIngest(id, doc.id);

      expect(await readChunks(id, doc.id)).toEqual(["ORIGINAL TEXT"]);
      const row = await readDoc(id, doc.id);
      expect(row.status).toBe("READY");
      expect(row.chunkCount).toBe(1);
    });

    // NOTE: The issue's sequence, end to end: the effect it names is that search keeps reading the old text
    // forever, so the assertion is on the chunks after the re-armed job has had its turn.
    test("the edit lands in the index, not just in the row", async () => {
      const { id, kb } = await seedTenant("rag-edit");
      const doc = await createDocument({
        ctx: ctxOf(id),
        knowledgeBaseId: kb,
        title: "policy",
        sourceType: "text",
        text: "ORIGINAL TEXT",
        base: appDb,
      });

      duringEmbed = async () => {
        await updateDocument(ctxOf(id), doc.id, { text: "EDITED TEXT" }, appDb);
      };
      await runIngest(id, doc.id);

      // NOTE: The in-flight run must not have published: the row still carries the operator's re-index
      // marker, which is the only thing that makes the re-armed job do any work.
      const midway = await readDoc(id, doc.id);
      expect(midway.content).toBe("EDITED TEXT");
      expect(midway.status).toBe("PENDING");

      // NOTE: The re-armed job (step 6 of the issue) — the one that used to find READY and return.
      await runIngest(id, doc.id);

      expect(await readChunks(id, doc.id)).toEqual(["EDITED TEXT"]);
      expect((await readDoc(id, doc.id)).status).toBe("READY");
    });

    // NOTE: The same question one branch over: the FAILED write had no status guard either, so a stale run
    // that errored stamped a failure for content the document no longer holds — and FAILED is just as
    // effective at swallowing the re-index marker as READY is.
    test("a stale run that fails does not stamp its failure on the edited document", async () => {
      const { id, kb } = await seedTenant("rag-fail");
      const doc = await createDocument({
        ctx: ctxOf(id),
        knowledgeBaseId: kb,
        title: "policy",
        sourceType: "text",
        text: "ORIGINAL TEXT",
        base: appDb,
      });

      embedMode = "reject";
      duringEmbed = async () => {
        await updateDocument(ctxOf(id), doc.id, { text: "EDITED TEXT" }, appDb);
      };
      await runIngest(id, doc.id);
      embedMode = "ok";

      const midway = await readDoc(id, doc.id);
      expect(midway.content).toBe("EDITED TEXT");
      expect(midway.status).toBe("PENDING");

      await runIngest(id, doc.id);

      expect(await readChunks(id, doc.id)).toEqual(["EDITED TEXT"]);
      expect((await readDoc(id, doc.id)).status).toBe("READY");
    });

    // NOTE: Why the guard runs FIRST in the transaction rather than last: a stale run that publishes nothing
    // must also delete nothing, or every edit would blank the index for as long as the re-index takes.
    test("a stale run leaves the previous index intact while the re-index runs", async () => {
      const { id, kb } = await seedTenant("rag-keep");
      const doc = await createDocument({
        ctx: ctxOf(id),
        knowledgeBaseId: kb,
        title: "policy",
        sourceType: "text",
        text: "FIRST TEXT",
        base: appDb,
      });
      await runIngest(id, doc.id);
      expect(await readChunks(id, doc.id)).toEqual(["FIRST TEXT"]);

      await updateDocument(ctxOf(id), doc.id, { text: "SECOND TEXT" }, appDb);
      duringEmbed = async () => {
        await updateDocument(ctxOf(id), doc.id, { text: "THIRD TEXT" }, appDb);
      };
      await runIngest(id, doc.id);

      // NOTE: Search still answers from the last index that was consistent with a real document version.
      expect(await readChunks(id, doc.id)).toEqual(["FIRST TEXT"]);

      await runIngest(id, doc.id);
      expect(await readChunks(id, doc.id)).toEqual(["THIRD TEXT"]);
    });

    // NOTE: Round 1 review, P2: the embed is not the only window. The run reads the document's text and
    // takes the mark in two separate steps, and an edit landing BETWEEN them leaves the row PENDING
    // (the value it already had), so the claim still succeeds — carrying text the document no
    // longer has. The run then indexes the old text and publishes it legitimately, which is the
    // same permanent divergence through a narrower door.
    test("what gets indexed is the text the claim froze, not the text read before it", async () => {
      const { id, kb } = await seedTenant("rag-claim");
      const doc = await createDocument({
        ctx: ctxOf(id),
        knowledgeBaseId: kb,
        title: "policy",
        sourceType: "text",
        text: "ORIGINAL TEXT",
        base: appDb,
      });

      // NOTE: There is no network in this gap, so it needs a seam rather than the embedding double. The
      // knowledge-base config read sits inside it, right after the document read.
      let fired = false;
      const hooked = appDb.$extends({
        query: {
          knowledgeBase: {
            async findUnique({ args, query }) {
              if (!fired) {
                fired = true;
                await updateDocument(
                  ctxOf(id),
                  doc.id,
                  { text: "EDITED TEXT" },
                  editDb,
                );
              }
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      await runIngestOn(hooked, id, doc.id);
      expect(fired).toBe(true);

      expect(await readChunks(id, doc.id)).toEqual(["EDITED TEXT"]);
      expect((await readDoc(id, doc.id)).status).toBe("READY");
    });
  },
);
