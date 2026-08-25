import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { translateWithLocale } from "@/api/lib/i18n";
import { AppError, type ErrorTranslationKey } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  knowledgeCreate,
  knowledgeDocumentCreate,
  knowledgeEdit,
  knowledgeUpdate,
} from "@/modules/mcp/write-knowledge";
import { createDocument, updateDocument } from "@/modules/rag/documents";
import { extractText } from "@/modules/rag/loaders";
import {
  createKnowledgeBase,
  createSuggestion,
  editApprovalItem,
  updateKnowledgeBase,
} from "@/modules/rag/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// A DOCUMENT THE COLUMN CANNOT HOLD IS REFUSED BY NAME, NOT BY A 500.
//
// `extractText` decodes an uploaded .txt/.md/.csv with `TextDecoder("utf-8")`, and its `normalize`
// only folds CRLF and trims. A file carrying a `0x00` byte therefore produces a string holding
// U+0000, which `createDocument` wrote straight into `KnowledgeDocument.content`. That column is
// `text`, Postgres refuses a NUL in one (22021), and nothing caught it between the write and the
// transport: an operator uploading the file got a 500 naming neither the file nor the reason
// (issue #247). A `0x00` in a text export is ordinary: a fixed-width dump, a CSV from a tool that
// pads, a file truncated mid-write.
//
// REFUSED, which is the opposite of what #218 and #243 do with the same two characters, and the
// rule that decides is who can act on the answer. There the writer is a third party's webhook or an
// exception message: nobody reads a rejection and a refusal costs the event, so the value is
// repaired. Here it is a person who chose this file, a client calling an API that answers them, or a
// model reading a tool failure it can act on. Deleting bytes out of a document an agent is about to
// answer from would be worse than saying it cannot be stored.
//
// Asked of every text this module stores, not just the one that was reported: the column refuses the
// ROW, so checking `content` and not `title` only moves which value produces the 500. The knowledge
// bases, the documents and the approval queue are all covered below.
//
// The last block is the MCP half and needs no database, which is the point: `dry_run` defaults to
// true and answers off the arguments alone, so a value the column cannot hold used to preview clean
// and fail on apply. A dry run that cannot predict its own apply is worse than no dry run.

const NUL = String.fromCharCode(0);

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

// What the caller gets back, reduced to the two things that decide whether they can act on it: the
// HTTP status, and whether the text names the field and the character.
async function refusal(run: () => Promise<unknown>): Promise<{
  status: number | null;
  message: string;
}> {
  try {
    await run();
    return { status: null, message: "" };
  } catch (e) {
    return {
      status: e instanceof AppError ? e.statusCode : null,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

describe.skipIf(!dbUp)("a knowledge document the column cannot hold", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DOCSTOR", slug: `docstor-${process.pid}` },
    });
    tenantId = t.id;
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "KB" },
    });
    kbId = kb.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // The reachability the issue rests on: nothing exotic reaches `content`, an ordinary .txt does.
  test("a .txt holding a 0x00 byte decodes to a NUL in the text", async () => {
    const { text } = await extractText({
      name: "policy.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode(`policy${NUL}text`),
    });
    expect(text).toContain(NUL);
  });

  test("createDocument refuses the text, naming the field and the code point", async () => {
    const r = await refusal(() =>
      createDocument({
        ctx: ctxOf(tenantId),
        knowledgeBaseId: kbId,
        title: "policy",
        text: `policy${NUL}text`,
        sourceType: "file",
        fileName: "policy.txt",
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+0000");
    expect(r.message).toContain("text");
  });

  test("createDocument refuses half a character in the title", async () => {
    const r = await refusal(() =>
      createDocument({
        ctx: ctxOf(tenantId),
        knowledgeBaseId: kbId,
        title: "policy\ud800",
        text: "fine",
        sourceType: "text",
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+D800");
  });

  test("createDocument refuses a file name the column cannot hold", async () => {
    const r = await refusal(() =>
      createDocument({
        ctx: ctxOf(tenantId),
        knowledgeBaseId: kbId,
        title: "policy",
        text: "fine",
        sourceType: "file",
        fileName: `policy${NUL}.txt`,
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+0000");
  });

  test("a refused create leaves no row behind", async () => {
    const before = await suDb.knowledgeDocument.count({ where: { tenantId } });
    await refusal(() =>
      createDocument({
        ctx: ctxOf(tenantId),
        knowledgeBaseId: kbId,
        title: "policy",
        text: `a${NUL}b`,
        sourceType: "text",
        base: appDb,
      }),
    );
    expect(await suDb.knowledgeDocument.count({ where: { tenantId } })).toBe(
      before,
    );
  });

  test("updateDocument refuses an edit the column cannot hold", async () => {
    const doc = await createDocument({
      ctx: ctxOf(tenantId),
      knowledgeBaseId: kbId,
      title: "editable",
      text: "ORIGINAL",
      sourceType: "text",
      base: appDb,
    });
    const r = await refusal(() =>
      updateDocument(ctxOf(tenantId), doc.id, { text: `EDITED${NUL}` }, appDb),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+0000");
    // The document keeps the text it had: a refused edit is not a half-applied one.
    const row = await suDb.knowledgeDocument.findUniqueOrThrow({
      where: { id: doc.id },
      select: { content: true, status: true },
    });
    expect(row.content).toBe("ORIGINAL");
  });

  test("createKnowledgeBase refuses a name the column cannot hold", async () => {
    const r = await refusal(() =>
      createKnowledgeBase({
        ctx: ctxOf(tenantId),
        name: `kb${NUL}`,
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+0000");
  });

  test("updateKnowledgeBase refuses a description the column cannot hold", async () => {
    const r = await refusal(() =>
      updateKnowledgeBase({
        ctx: ctxOf(tenantId),
        id: kbId,
        description: "half\ud800",
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+D800");
  });

  test("editApprovalItem refuses an edit the column cannot hold", async () => {
    const r = await refusal(() =>
      editApprovalItem({
        ctx: ctxOf(tenantId),
        id: 1n,
        proposedContent: `edited${NUL}`,
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+0000");
  });

  // The same question one table upstream, where the writer is the AGENT's own tool (graph/tools/rag)
  // rather than a person: `proposedContent` is a `text` column too, and a model can emit half a
  // character. A refusal reaches the model as a tool failure it can act on, so the answer is the
  // same one, not a repair.
  test("createSuggestion refuses content the column cannot hold", async () => {
    const r = await refusal(() =>
      createSuggestion({
        ctx: ctxOf(tenantId),
        knowledgeBaseId: kbId,
        proposedContent: `learned${NUL}fact`,
        proposedTitle: "fact",
        rationale: "the customer said so",
        threadId: `${tenantId}:1:1`,
        interruptKey: "k1",
        base: appDb,
      }),
    );
    expect(r.status).toBe(400);
    expect(r.message).toContain("U+0000");
    // Named by what the CALLER sent, not by the column it lands in. The REST body and the agent's
    // suggestion tool both spell this `content`; `proposedContent` is a field nobody can change
    // because nobody sent it (review round 3).
    expect(r.message).toContain("content ");
    expect(r.message).not.toContain("proposedContent");
  });
});

// What the refusal actually reads like, at the layer that renders it. `translationKey` is translated
// per the request's Accept-Language while `message` is only the untranslated fallback, so a refusal
// that interpolates an ENGLISH SENTENCE answers a pt-BR caller in two languages at once (review
// round 2). Passing the parts instead is what closes it; the field name stays English in both, the
// way a schema path does.
describe("the refusal answers in the caller's language", () => {
  async function render(locale: "en" | "pt-BR"): Promise<string> {
    let caught: unknown = null;
    try {
      await createDocument({
        ctx: ctxOf(0n),
        knowledgeBaseId: 0n,
        title: "t",
        text: `a${NUL}b`,
        sourceType: "text",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    return translateWithLocale(
      locale,
      err.translationKey as ErrorTranslationKey,
      err.message,
      err.translationParams,
    );
  }

  test("pt-BR carries no English prose", async () => {
    const out = await render("pt-BR");
    expect(out).toContain("não podem ser armazenados");
    expect(out).toContain("U+0000");
    // The sentence the old shape interpolated, in the language it was stuck in.
    expect(out).not.toContain("the database cannot store");
    expect(out).not.toContain("PostgreSQL");
  });

  test("en says the same thing", async () => {
    const out = await render("en");
    expect(out).toContain("cannot be stored");
    expect(out).toContain("U+0000");
  });

  test("the field is named, so the caller knows which one to fix", async () => {
    for (const locale of ["en", "pt-BR"] as const) {
      expect(await render(locale)).toContain("text");
    }
  });
});

// The MCP half, which needs no database: the gate is DB-free and so is the dry run, which is
// exactly the problem. `dry_run` defaults to true and answers off the arguments alone, so before
// this check a text the column cannot hold previewed clean and failed on APPLY. A dry run that
// cannot predict its own apply is worse than no dry run.
function principal(over: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("the MCP dry run refuses what the apply would refuse", () => {
  test("knowledge_document_create", async () => {
    const r = await knowledgeDocumentCreate(principal(), {
      knowledge_base_id: "1",
      title: "policy",
      text: `policy${NUL}text`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("U+0000");
  });

  test("knowledge_create", async () => {
    const r = await knowledgeCreate(principal(), {
      name: "kb\ud800",
      description: "d",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("U+D800");
  });

  test("knowledge_update", async () => {
    const r = await knowledgeUpdate(principal(), {
      knowledge_base_id: "1",
      description: `d${NUL}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("U+0000");
  });

  test("knowledge_edit", async () => {
    const r = await knowledgeEdit(principal(), {
      approval_id: "1",
      content: `edited${NUL}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("U+0000");
  });
});
