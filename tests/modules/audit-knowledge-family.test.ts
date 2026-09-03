import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createDocument,
  deleteDocument,
  reindexKnowledgeBase,
  retryDocument,
  updateDocument,
} from "@/modules/rag/documents";
import {
  approveApprovalItem,
  claimApprovalForStorage,
  createKnowledgeBase,
  createSuggestion,
  deleteKnowledgeBase,
  editApprovalItem,
  rejectApprovalItem,
  updateKnowledgeBase,
} from "@/modules/rag/service";

// THE KNOWLEDGE FAMILY (issue #396), where ten actions had a name over MCP and twelve REST routes
// wrote nothing at all: the console is the door an operator actually uses, and everything they did
// to a knowledge base through it was invisible.
//
// `PATCH /v1/knowledge/documents/:id` had no MCP twin either, so `knowledge_document.update` is a
// name this issue invents.
//
// The rule that shapes every projection here is the one the family makes unavoidable: a document's
// CONTENT is the payload most likely to carry a customer's data, the row is append-only and readable
// by every tenant admin, and it outlives the document. So `chars` is what a row says about a body,
// on both ends, and the fence at the bottom greps every row this file produced for the texts
// themselves.

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

let tenantId = 0n;
let kbId = 0n;

const USER = 9396n;
// The two texts that must never reach a row: a document's body, and what an agent proposed about a
// customer before anyone approved it.
const BODY = "corpo-do-documento-9396-confidencial";
const PROPOSAL = "proposta-do-agente-9396-confidencial";

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

async function rows(action?: string) {
  return (
    (await su?.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: { id: "asc" },
    })) ?? []
  );
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

// Every row this file wrote, kept for the fence at the end. Over the whole run rather than per test,
// because a body leaking into one row of twenty is exactly the shape a per-test assertion misses.
const everyRow: unknown[] = [];
async function collect() {
  everyRow.push(...(await rows()));
}

// A client that lets a CONCURRENT request land between the listing `reindexKnowledgeBase` takes of
// what needs indexing and the write it derives from it. That window is real (the reads and the
// update are separate statements under read-committed) and this makes the interleaving
// deterministic. It fires on the targets read and on nothing else: it is the only
// `knowledgeDocument.findMany` on that path.
function afterTargets(
  client: PrismaClient,
  hook: () => Promise<unknown>,
): PrismaClient {
  let fired = false;
  // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "$extends") {
          return (...a: unknown[]) => wrap(t.$extends(...a));
        }
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
            t.$transaction((tx: unknown) => fn(wrap(tx)), ...rest);
        }
        if (prop !== "knowledgeDocument") return Reflect.get(t, prop, recv);
        const delegate = Reflect.get(t, prop, recv);
        return new Proxy(delegate, {
          get(d, k, r) {
            const inner = Reflect.get(d, k, r);
            if (k !== "findMany") return inner;
            return async (args: unknown) => {
              const res = await (
                inner as (a: unknown) => Promise<unknown>
              ).call(d, args);
              if (!fired) {
                fired = true;
                await hook();
              }
              return res;
            };
          },
        });
      },
    });
  return wrap(client);
}

const uniq = () => `${process.pid}${Math.floor(Math.random() * 1e6)}`;

// The rows carry BigInt columns, which `JSON.stringify` refuses outright.
const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));

async function makeDoc(text = BODY, title = `Doc ${uniq()}`) {
  const doc = await createDocument({
    ctx: ctx(),
    knowledgeBaseId: kbId,
    title,
    text,
    sourceType: "text",
    base: appDb,
  });
  return doc;
}

async function makeSuggestion(content = PROPOSAL) {
  return createSuggestion({
    ctx: ctx(),
    knowledgeBaseId: kbId,
    proposedTitle: `Sugestão ${uniq()}`,
    proposedContent: content,
    rationale: "porque sim",
    base: appDb,
  });
}

describe.skipIf(!dbUp)("the knowledge family records its own changes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AUD396", slug: `aud396-${process.pid}` },
    });
    tenantId = t.id;
    // The embedding prerequisite, written straight to the columns: `reindexKnowledgeBase` refuses to
    // queue anything without a usable credential, and configuring one through its own service would
    // put that family's rows in the middle of this one's assertions.
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: `emb-${process.pid}`,
        kind: "openai",
        status: "active",
        secret: encryptJson("sk-embedding-9396"),
      },
      select: { id: true },
    });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: { embedding: { credentialRef: `vault:${entry.id}` } } },
    });
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("creating a knowledge base records its identity and its indexing policy", async () => {
    await clearAudit();
    const name = `KB ${uniq()}`;
    const created = await createKnowledgeBase({
      ctx: ctx(),
      name,
      description: "base de testes",
      base: appDb,
    });
    kbId = created.id;
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge.create");
    expect(row?.target).toBe(`knowledge_base:${kbId}`);
    expect(row?.actorId).toBe(USER);
    expect(row?.actorType).toBe("user");
    // The chunk parameters are in the row because they decide what a search returns: two bases with
    // the same documents and different chunking answer differently.
    expect(row?.after).toMatchObject({
      id: String(kbId),
      name,
      description: "base de testes",
      chunkSize: expect.any(Number),
      chunkOverlap: expect.any(Number),
    });
    await collect();
  });

  test("editing a base records both sides of what moved", async () => {
    await clearAudit();
    const renamed = `KB ${uniq()} revisada`;
    await updateKnowledgeBase({
      ctx: ctx(),
      id: kbId,
      name: renamed,
      chunkSize: 1200,
      chunkOverlap: 120,
      base: appDb,
    });
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge.update");
    expect(row?.before).toMatchObject({ chunkSize: expect.any(Number) });
    expect(row?.after).toMatchObject({
      name: renamed,
      chunkSize: 1200,
      chunkOverlap: 120,
    });
    await collect();
  });

  // The console PATCHes the whole form on every save, so the chunk parameters are re-submitted
  // unchanged by an operator who only fixed a typo in the name — and by one who fixed nothing.
  test("a save that moves nothing records nothing", async () => {
    const before = await suDb.knowledgeBase.findUniqueOrThrow({
      where: { id: kbId },
      select: { name: true, chunkSize: true, chunkOverlap: true },
    });
    await clearAudit();
    await updateKnowledgeBase({
      ctx: ctx(),
      id: kbId,
      name: before.name,
      chunkSize: before.chunkSize,
      chunkOverlap: before.chunkOverlap,
      base: appDb,
    });
    expect(await rows()).toEqual([]);
  });

  test("adding a document records its shape and its size, never its body", async () => {
    await clearAudit();
    const title = `Doc ${uniq()}`;
    const doc = await makeDoc(BODY, title);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge_document.create");
    expect(row?.target).toBe(`knowledge_document:${doc.id}`);
    expect(row?.after).toEqual({
      id: String(doc.id),
      knowledgeBaseId: String(kbId),
      title,
      sourceType: "text",
      fileName: null,
      mimeType: null,
      status: "PENDING",
      chars: BODY.length,
    });
    expect(dump(row?.after)).not.toContain(BODY);
    await collect();
  });

  // The count comes from the DATABASE, not from the string in hand, and an astral character is what
  // separates the two: Postgres counts it as one character and `String.length` as two. The reason it
  // is asked of the column is size — an uploaded document holds up to 2,000,000 characters, and
  // reading the body across the wire to count it would put that transfer inside a transaction with
  // five seconds to finish.
  test("a document's size is counted where the document is", async () => {
    await clearAudit();
    const withEmoji = `${BODY} 🎉`;
    const doc = await makeDoc(withEmoji);
    const [row] = await rows();
    expect(row?.after).toMatchObject({ chars: [...withEmoji].length });
    expect(withEmoji.length).not.toBe([...withEmoji].length);
    await collect();
    await deleteDocument(ctx(), doc.id, appDb);
  });

  // The action with no name on any transport before this issue.
  test("editing a document records that the text moved, by its length", async () => {
    const doc = await makeDoc();
    await clearAudit();
    const longer = `${BODY} com um parágrafo a mais`;
    await updateDocument(ctx(), doc.id, { text: longer }, appDb);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge_document.update");
    expect(row?.before).toMatchObject({ chars: BODY.length });
    // `reindexed` is the consequence a reader needs and cannot derive: a body that moved sends the
    // document back through the whole ingest, and until it lands the search still answers from the
    // previous text.
    expect(row?.after).toMatchObject({
      chars: longer.length,
      status: "PENDING",
      reindexed: true,
    });
    expect(dump(row)).not.toContain(BODY);
    await collect();
  });

  // A title-only edit is metadata: the chunks are the content, so nothing is re-embedded and the
  // document does not leave the state it was in.
  test("renaming a document records the rename and does not re-index it", async () => {
    const doc = await makeDoc();
    await suDb.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "READY", chunkCount: 3 },
    });
    await clearAudit();
    await updateDocument(ctx(), doc.id, { title: "Outro título" }, appDb);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge_document.update");
    expect(row?.before).toMatchObject({ status: "READY" });
    expect(row?.after).toMatchObject({
      title: "Outro título",
      status: "READY",
      chars: BODY.length,
      reindexed: false,
    });
    // And the document really did not go back to the queue: it is still the indexed one.
    expect(
      await suDb.knowledgeDocument.findUniqueOrThrow({
        where: { id: doc.id },
        select: { status: true, chunkCount: true },
      }),
    ).toEqual({ status: "READY", chunkCount: 3 });
    await collect();
    await deleteDocument(ctx(), doc.id, appDb);
  });

  // A body re-submitted byte for byte is not a change, and the console sends the whole form.
  test("an edit that moves nothing records nothing", async () => {
    const doc = await makeDoc();
    const stored = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc.id },
      select: { title: true },
    });
    await clearAudit();
    await updateDocument(
      ctx(),
      doc.id,
      { title: stored.title, text: BODY },
      appDb,
    );
    expect(await rows()).toEqual([]);
  });

  test("re-indexing a failed document records the transition it made", async () => {
    const doc = await makeDoc();
    await suDb.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "FAILED", error: "boom" },
    });
    await clearAudit();
    await retryDocument(ctx(), doc.id, appDb);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge_document.retry");
    expect(row?.before).toEqual({ id: String(doc.id), status: "FAILED" });
    expect(row?.after).toEqual({ id: String(doc.id), status: "PENDING" });
    await collect();
  });

  // The 409 is what a second press hits, and it is refused before any write: no row, because nothing
  // happened.
  test("re-indexing a document that is not failed records nothing", async () => {
    const doc = await makeDoc();
    await clearAudit();
    expect(retryDocument(ctx(), doc.id, appDb)).rejects.toThrow(AppError);
    expect(await rows()).toEqual([]);
  });

  test("re-indexing a base records how many documents the write moved", async () => {
    const a = await makeDoc();
    const b = await makeDoc();
    await suDb.knowledgeDocument.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { status: "UNINDEXED" },
    });
    await clearAudit();
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "RAG_INGEST" },
    });
    const res = await reindexKnowledgeBase(ctx(), kbId, appDb);
    expect(res.queued).toBe(2);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge.reindex");
    expect(row?.target).toBe(`knowledge_base:${kbId}`);
    expect(row?.after).toEqual({ queued: 2, includeFailed: false });
    // The jobs, committed with the transition and with the row that counts them. Enqueuing after
    // the commit is what leaves documents in PENDING with no job: they are no longer UNINDEXED, so
    // the next bulk re-index does not select them either.
    expect(
      await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "RAG_INGEST",
          dedupeKey: { in: [`doc:${a.id}`, `doc:${b.id}`] },
        },
      }),
    ).toBe(2);
    await collect();
  });

  test("a re-index whose documents were already queued records nothing", async () => {
    const a = await makeDoc();
    const b = await makeDoc();
    await suDb.knowledgeDocument.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { status: "UNINDEXED" },
    });
    await clearAudit();
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "RAG_INGEST" },
    });
    // Another operator presses re-index first and moves both documents.
    const res = await reindexKnowledgeBase(
      ctx(),
      kbId,
      afterTargets(appDb, () =>
        suDb.knowledgeDocument.updateMany({
          where: { id: { in: [a.id, b.id] } },
          data: { status: "PENDING" },
        }),
      ),
    );
    // Nothing moved, so nothing was queued and nothing is on the trail. Both halves matter: a row
    // built from the LISTING would have claimed two, and a job re-armed from it would have
    // re-queued documents this request never touched.
    expect(res.queued).toBe(0);
    expect(await rows()).toEqual([]);
    expect(
      await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "RAG_INGEST",
          dedupeKey: { in: [`doc:${a.id}`, `doc:${b.id}`] },
        },
      }),
    ).toBe(0);
  });

  // A preview is a read: it counts what WOULD be queued and touches nothing.
  test("previewing a re-index records nothing", async () => {
    const doc = await makeDoc();
    await suDb.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "UNINDEXED" },
    });
    await clearAudit();
    await reindexKnowledgeBase(ctx(), kbId, appDb, { dryRun: true });
    expect(await rows()).toEqual([]);
    await suDb.knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "READY" },
    });
  });

  test("deleting a document records what it was", async () => {
    const doc = await makeDoc();
    await clearAudit();
    await deleteDocument(ctx(), doc.id, appDb);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge_document.delete");
    expect(row?.target).toBe(`knowledge_document:${doc.id}`);
    expect(row?.before).toMatchObject({
      id: String(doc.id),
      chars: BODY.length,
    });
    expect(dump(row)).not.toContain(BODY);
    expect(await suDb.knowledgeDocument.count({ where: { id: doc.id } })).toBe(
      0,
    );
    await collect();
  });

  // THE DECISION THIS ISSUE MAKES. A suggestion is a proposal and changes nothing an operator can
  // observe: the queue item IS the record, it sits on the Approvals page with its text until
  // somebody decides, and the three decisions on it are each recorded below. The other road here is
  // the agent's own tool during a turn, so a row would also mean a `system` entry per suggestion,
  // carrying customer-derived text, for a change nobody made yet.
  test("proposing an entry records nothing until somebody decides on it", async () => {
    await clearAudit();
    await makeSuggestion();
    expect(await rows()).toEqual([]);
  });

  test("editing a proposal records WHICH fields moved, never what they say", async () => {
    const item = await makeSuggestion();
    await clearAudit();
    const outcome = await editApprovalItem({
      ctx: ctx(),
      id: item.id,
      proposedTitle: "Título revisado",
      proposedContent: `${PROPOSAL} revisado`,
      base: appDb,
    });
    expect(outcome).toBe("updated");
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge.edit");
    expect(row?.target).toBe(`approval:${item.id}`);
    expect(row?.after).toEqual({
      id: String(item.id),
      status: "EDITED",
      fields: ["proposedContent", "proposedTitle"],
    });
    expect(dump(row)).not.toContain(PROPOSAL);
    await collect();
  });

  test("an edit that names no field is refused before anything is written", async () => {
    const item = await makeSuggestion();
    await clearAudit();
    expect(
      editApprovalItem({ ctx: ctx(), id: item.id, base: appDb }),
    ).rejects.toThrow(AppError);
    expect(await rows()).toEqual([]);
  });

  test("re-submitting a proposal unchanged records nothing, and does not mark it edited", async () => {
    const item = await makeSuggestion();
    const stored = await suDb.approvalQueueItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { proposedTitle: true, proposedContent: true, status: true },
    });
    expect(stored.status).toBe("PENDING");
    await clearAudit();
    const outcome = await editApprovalItem({
      ctx: ctx(),
      id: item.id,
      proposedTitle: stored.proposedTitle ?? undefined,
      proposedContent: stored.proposedContent,
      base: appDb,
    });
    expect(outcome).toBe("updated");
    expect(await rows()).toEqual([]);
    // An item marked EDITED because somebody opened it and saved it back says a human rewrote a
    // proposal they did not touch, which is what the Approvals page shows the next reviewer.
    expect(
      (
        await suDb.approvalQueueItem.findUniqueOrThrow({
          where: { id: item.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PENDING");
  });

  test("approving a proposal records the decision and the document it becomes", async () => {
    const item = await makeSuggestion();
    await clearAudit();
    const res = await approveApprovalItem({
      ctx: ctx(),
      id: item.id,
      demoMode: true,
      base: appDb,
    });
    expect(res.outcome).toBe("approved");
    const all = await rows();
    // Two rows, and neither covers the other: the first is the decision, taken in the claim's own
    // transaction so a second reviewer racing it records nothing; the second is the document that
    // decision created, which is where the text actually went.
    expect(all.map((r) => r.action)).toEqual([
      "knowledge.approve",
      "knowledge_document.create",
    ]);
    expect(all[0]?.target).toBe(`approval:${item.id}`);
    expect(all[0]?.after).toMatchObject({
      knowledgeBaseId: String(kbId),
      status: "APPROVED",
    });
    expect(all[1]?.after).toMatchObject({
      sourceType: "approval",
      chars: PROPOSAL.length,
    });
    expect(dump(all)).not.toContain(PROPOSAL);
    await collect();
  });

  test("approving a proposal somebody already decided records nothing", async () => {
    const item = await makeSuggestion();
    await rejectApprovalItem({ ctx: ctx(), id: item.id, base: appDb });
    await clearAudit();
    const res = await approveApprovalItem({
      ctx: ctx(),
      id: item.id,
      demoMode: true,
      base: appDb,
    });
    expect(res.outcome).toBe("not-pending");
    expect(await rows()).toEqual([]);
  });

  // The claim is what makes an approval exclusive, and the row rides in ITS transaction. This is
  // the loser of that race, reached directly because the outcome is the point: phase 1 lets two
  // reviewers through, and only the statement itself can say which of them took the item.
  test("claiming an approval somebody already took records nothing", async () => {
    const item = await makeSuggestion();
    const first = await claimApprovalForStorage(ctx(), item.id, appDb);
    expect(first).not.toBeNull();
    await clearAudit();
    const second = await claimApprovalForStorage(ctx(), item.id, appDb);
    expect(second).toBeNull();
    expect(await rows()).toEqual([]);
  });

  test("editing a proposal somebody already decided records nothing", async () => {
    const item = await makeSuggestion();
    await rejectApprovalItem({ ctx: ctx(), id: item.id, base: appDb });
    await clearAudit();
    const outcome = await editApprovalItem({
      ctx: ctx(),
      id: item.id,
      proposedTitle: "tarde demais",
      base: appDb,
    });
    expect(outcome).toBe("not-pending");
    expect(await rows()).toEqual([]);
  });

  test("rejecting a proposal records the decision, never the proposal", async () => {
    const item = await makeSuggestion();
    await clearAudit();
    const outcome = await rejectApprovalItem({
      ctx: ctx(),
      id: item.id,
      base: appDb,
    });
    expect(outcome).toBe("rejected");
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge.reject");
    expect(row?.target).toBe(`approval:${item.id}`);
    expect(row?.after).toEqual({ id: String(item.id), status: "REJECTED" });
    expect(dump(row)).not.toContain(PROPOSAL);
    await collect();
  });

  test("rejecting a proposal somebody already decided records nothing", async () => {
    const item = await makeSuggestion();
    await rejectApprovalItem({ ctx: ctx(), id: item.id, base: appDb });
    await clearAudit();
    const outcome = await rejectApprovalItem({
      ctx: ctx(),
      id: item.id,
      base: appDb,
    });
    expect(outcome).toBe("not-pending");
    expect(await rows()).toEqual([]);
  });

  // LAST, because it takes the base and everything hanging off it.
  test("deleting a base records what it was and counts what went with it", async () => {
    const documents = await suDb.knowledgeDocument.count({
      where: { knowledgeBaseId: kbId },
    });
    expect(documents).toBeGreaterThan(0);
    await clearAudit();
    await deleteKnowledgeBase({ ctx: ctx(), id: kbId, base: appDb });
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("knowledge.delete");
    expect(row?.target).toBe(`knowledge_base:${kbId}`);
    // The count is taken at the moment of the delete because afterwards there is nothing left to
    // count: the documents and their chunks cascade, and this row is all that survives them.
    expect(row?.before).toMatchObject({ documents });
    expect(await suDb.knowledgeBase.count({ where: { id: kbId } })).toBe(0);
    await collect();
  });

  test("no row anywhere in this family carries a document body or a proposal", () => {
    expect(everyRow.length).toBeGreaterThan(8);
    const dumped = dump(everyRow);
    expect(dumped).not.toContain(BODY);
    expect(dumped).not.toContain(PROPOSAL);
  });
});
