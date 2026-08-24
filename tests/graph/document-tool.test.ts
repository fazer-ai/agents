import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { rm } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import type { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  buildDocumentTools,
  documentToolSchema,
  screenableValues,
} from "@/graph/tools/documents";
import { queuedImages, type TurnState } from "@/graph/tools/native";
import type { TenantContext } from "@/lib/tenancy";
import type { DocumentField } from "@/modules/documents/blocks";
import { documentStarter } from "@/modules/documents/starters";
import { createDocumentTemplate } from "@/modules/documents/templates";

// The tool an agent actually gets for a granted template: its arguments come from the template's own
// declared fields, and it issues + queues in one call.

const FIELDS: DocumentField[] = [
  { name: "cliente", label: "Cliente", type: "text", required: true },
  { name: "itens", label: "Itens", type: "lineItems", required: true },
  { name: "desconto", label: "Desconto", type: "currency" },
  { name: "validade", label: "Validade", type: "date" },
];

function newTurnState(): TurnState {
  return {
    resolveRequested: false,
    pendingAttachments: [],
    imagesInFlight: 0,
    documentsInFlight: 0,
    attachmentsSeq: 0,
  };
}

describe("screenableValues", () => {
  // What the OUTPUT guardrail gets to see. The reply and the captions already ride along because
  // they are model-written text the customer reads; a quote's field values and line-item
  // descriptions are that same text, and they reach the customer as a numbered PDF they keep.
  test("collects the model's strings, including line-item descriptions", () => {
    const text = screenableValues({
      cliente: "Ana Ribeiro",
      observacao: "texto que o modelo escreveu",
      desconto: 100,
      validade: "2026-09-05",
      itens: [
        { description: "Consultoria", quantity: 2, unitPrice: 450 },
        { description: "Treinamento", quantity: 1, unitPrice: 100 },
      ],
    });
    expect(text).toContain("Ana Ribeiro");
    expect(text).toContain("texto que o modelo escreveu");
    expect(text).toContain("Consultoria");
    expect(text).toContain("Treinamento");
    // Numbers carry no policy and cost tokens in a moderation pass.
    expect(text).not.toContain("450");
  });

  test("is empty when the model supplied no text at all", () => {
    expect(screenableValues({ desconto: 10, itens: [] })).toBe("");
  });
});

describe("documentToolSchema", () => {
  // The declared fields ARE the tool's argument list. That is what "custom fields the agent fills"
  // buys: the operator writes the contract once and the model sees exactly it, with no free-form
  // JSON and no field the renderer would drop.
  test("derives one argument per declared field, with required mirrored", () => {
    const shape = (documentToolSchema(FIELDS) as z.ZodObject<z.ZodRawShape>)
      .shape;
    expect(Object.keys(shape).sort()).toEqual([
      "cliente",
      "desconto",
      "itens",
      "validade",
    ]);
    const parsed = documentToolSchema(FIELDS).safeParse({
      cliente: "Ana",
      itens: [{ description: "x", quantity: 1, unitPrice: 2 }],
    });
    expect(parsed.success).toBe(true);
    const missing = documentToolSchema(FIELDS).safeParse({ cliente: "Ana" });
    expect(missing.success).toBe(false);
  });

  test("types currency and number as numbers, so a model cannot send a formatted price", () => {
    const schema = documentToolSchema(FIELDS);
    expect(
      schema.safeParse({
        cliente: "Ana",
        itens: [],
        desconto: "R$ 100,00",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ cliente: "Ana", itens: [], desconto: 100 }).success,
    ).toBe(true);
  });

  // Zod strips by default, so a misspelled optional argument would be removed before the service
  // ever saw it: the document issues without the discount the model believed it sent, and every
  // gate reports success. `parseDocumentValues` refuses undeclared keys — it just never gets the
  // chance. The model can fix a typo it is told about.
  test("refuses an argument the template never declared", () => {
    const parsed = documentToolSchema(FIELDS).safeParse({
      cliente: "Ana",
      itens: [],
      descontoo: 10,
    });
    expect(parsed.success).toBe(false);
  });

  // The outer object's strictness cannot see a NESTED key: a discount tucked inside a line item was
  // stripped before the tool body ran, and the document issued without it.
  test("refuses an undeclared key inside a line item", () => {
    const parsed = documentToolSchema(FIELDS).safeParse({
      cliente: "Ana",
      itens: [{ description: "x", quantity: 1, unitPrice: 2, desconto: 10 }],
    });
    expect(parsed.success).toBe(false);
  });

  test("a template with no fields yields a tool that takes no arguments", () => {
    const shape = (documentToolSchema([]) as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape)).toEqual([]);
  });
});

// ── DB-gated: the tool end to end ──

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

const DIR = `/tmp/fazerai-doctool-${process.pid}`;
let tenantId = 0n;
let templateId = 0n;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const ARGS = {
  cliente: "Ana Ribeiro",
  itens: [{ description: "Consultoria", quantity: 2, unitPrice: 450 }],
  // The quote starter PRINTS its validity in the terms, so the field is required — a document that
  // says "valid until" and then nothing is the shape that made it so.
  validade: "2026-09-05",
};

function tool(turnState?: TurnState) {
  const [built] = buildDocumentTools(
    [
      {
        templateId,
        name: "Orçamento",
        slug: "orcamento",
        description: "Orçamento com itens.",
        fields: FIELDS,
      },
    ],
    {
      tenantId,
      turnState,
      threadId: `${tenantId}:1:42`,
      base: appDb,
      storageDir: DIR,
    },
  );
  if (!built) throw new Error("no tool built");
  return built;
}

describe.skipIf(!dbUp)("buildDocumentTools", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DocTool", slug: `doctool-${process.pid}` },
    });
    tenantId = t.id;
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    const tpl = await createDocumentTemplate(
      ctx(tenantId),
      {
        name: "Orçamento",
        blocks: starter.blocks,
        fields: starter.fields,
        style: starter.style,
        numberPrefix: "ORC-",
      },
      appDb,
    );
    templateId = BigInt(tpl.id);
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["issued_documents", "document_templates"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
    await rm(DIR, { recursive: true, force: true });
  });

  test("names the tool after the template and describes what it sends", () => {
    const built = tool(newTurnState());
    expect(built.name).toBe("send_orcamento");
    expect(built.description).toContain("Orçamento");
    expect(built.description).toContain("PDF");
  });

  test("issues the document and queues it as an attachment", async () => {
    const turnState = newTurnState();
    const out = await tool(turnState).invoke(ARGS);
    expect(String(out)).toContain("ORC-");
    expect(turnState.pendingAttachments).toHaveLength(1);
    const [file] = turnState.pendingAttachments;
    expect(file?.mime).toBe("application/pdf");
    expect(file?.kind).toBe("document");
    expect(file?.tool).toBe("send_orcamento");
    // Carried so the output guardrail screens what the model put ON the document, not just around it.
    expect(file?.screenText).toContain("Ana Ribeiro");
    expect(
      Buffer.from(file?.bytes as ArrayBuffer)
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    // The row is bound to the conversation by its THREAD key, which is what a conversation id alone
    // cannot do inside a tenant with more than one Chatwoot account.
    const row = await suDb.issuedDocument.findFirst({
      where: { tenantId, threadId: `${tenantId}:1:42` },
      select: { id: true, status: true },
    });
    expect(row?.status).toBe("READY");
  });

  // The output is stored VERBATIM in ExecutionLog.detail, a column that carries no customer data.
  test("its output names the document, never the customer or the values", async () => {
    const turnState = newTurnState();
    const out = String(await tool(turnState).invoke(ARGS));
    expect(out).not.toContain("Ana");
    expect(out).not.toContain("Consultoria");
    expect(out).not.toContain("450");
  });

  // Two priced documents in one message is the actual failure mode; the byte budget send_image
  // carries buys nothing for a file we rendered ourselves.
  //
  // The ROW count is the half that makes the first of the two guards load-bearing. Without the check
  // that runs before the await, the second call issues a document — a real numbered row and a real
  // PDF — and then drops it, leaving an orphan on the tenant's list that nobody sent and nobody can
  // explain. Asserting only the queue length reports that as clean.
  test("sends at most one document per turn, and issues at most one", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    const turnState = newTurnState();
    const built = tool(turnState);
    // Values unique to this test: the key is derived from them, so reusing another test's arguments
    // would reuse its row and the count below would be measuring idempotency instead of the guard.
    await built.invoke({ ...ARGS, cliente: "Primeiro do turno" });
    const second = String(
      await built.invoke({ ...ARGS, cliente: "Segundo do turno" }),
    );
    expect(second).toMatch(/já vai junto/);
    expect(turnState.pendingAttachments).toHaveLength(1);
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before + 1,
    );
  });

  // The check has to hold under Promise.all, which is how LangGraph's ToolNode runs one response's
  // tool calls. A guard that only reads the QUEUE is read by every call in the batch while the queue
  // is still empty, so all three pass it, all three issue, and two of the numbered documents are
  // then thrown away — invisible here if the queue length is all that is asserted, and visible to
  // the operator as unsent documents on the tenant's list that nobody can account for. The slot has
  // to be taken before the await, which is what the ROW count measures.
  test("holds the one-per-turn rule under concurrent calls, and issues one", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    const turnState = newTurnState();
    const built = tool(turnState);
    await Promise.all([
      built.invoke({ ...ARGS, cliente: "A" }),
      built.invoke({ ...ARGS, cliente: "B" }),
      built.invoke({ ...ARGS, cliente: "C" }),
    ]);
    expect(turnState.pendingAttachments).toHaveLength(1);
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before + 1,
    );
  });

  // A refusal must not burn the turn's only slot: the model is told what to fix, and its corrected
  // call arrives in the SAME turn (a new response, the same TurnState). A reservation that is not
  // released on failure would answer that retry with "a document already goes with your reply" while
  // no document was ever issued, and the customer would get the reply with nothing attached.
  test("a refused call leaves the turn's slot open for the corrected one", async () => {
    const turnState = newTurnState();
    const built = tool(turnState);
    const refused = String(
      await built.invoke({ ...ARGS, cliente: "Retry", validade: "05/09/2026" }),
    );
    expect(refused).toMatch(/ISO date/);
    const ok = String(
      await built.invoke({ ...ARGS, cliente: "Retry", validade: "2026-09-05" }),
    );
    expect(ok).toMatch(/Documento/);
    expect(turnState.pendingAttachments).toHaveLength(1);
  });

  // The image ceiling counts IMAGES, and the queue is shared. Letting a document take an image slot
  // would make a limit the operator reads as "images per message" mean something else depending on
  // whether a document went out with them — and it is the reason an entry carries `kind` as well as
  // the tool that queued it.
  test("a queued document does not spend an image slot", async () => {
    const turnState = newTurnState();
    await tool(turnState).invoke(ARGS);
    expect(turnState.pendingAttachments).toHaveLength(1);
    expect(queuedImages(turnState)).toHaveLength(0);
  });

  // The KEY is about the values, not about the order they arrive in. Zod rebuilds the parsed object
  // in the SCHEMA's order, and the schema's order is the template's declared fields — so an operator
  // reordering those between a call and its retry would otherwise change the key and put a second
  // numbered document in front of one customer.
  test("the same values under a reordered field list are the same document", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    const values = { ...ARGS, cliente: "Ordem", desconto: 10 };
    // Reordering the INPUT proves nothing: Zod rebuilds the parsed object in the SCHEMA's order, so
    // both calls stringify identically anyway. What changes the key is the schema order itself —
    // the template's declared fields, which an operator can reorder between a call and its retry.
    const [first] = buildDocumentTools(
      [
        {
          templateId,
          name: "Orçamento",
          slug: "orcamento",
          description: null,
          fields: FIELDS,
        },
      ],
      {
        tenantId,
        turnState: newTurnState(),
        threadId: `${tenantId}:1:42`,
        base: appDb,
        storageDir: DIR,
      },
    );
    const [reordered] = buildDocumentTools(
      [
        {
          templateId,
          name: "Orçamento",
          slug: "orcamento",
          description: null,
          fields: [...FIELDS].reverse(),
        },
      ],
      {
        tenantId,
        turnState: newTurnState(),
        threadId: `${tenantId}:1:42`,
        base: appDb,
        storageDir: DIR,
      },
    );
    await first?.invoke(values);
    await reordered?.invoke(values);
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before + 1,
    );
  });

  // Same values, same document: a retried turn reuses the row instead of putting a second numbered
  // document in front of one customer.
  test("the same values on the same thread issue one document", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    await tool(newTurnState()).invoke({ ...ARGS, cliente: "Repetido" });
    const mid = await suDb.issuedDocument.count({ where: { tenantId } });
    await tool(newTurnState()).invoke({ ...ARGS, cliente: "Repetido" });
    const after = await suDb.issuedDocument.count({ where: { tenantId } });
    expect(mid).toBe(before + 1);
    expect(after).toBe(mid);
  });

  // The dedupe window is a RETRY's, not a conversation's. Nothing in the key was time-bound, so it
  // never expired: the same values asked for again weeks later — a customer coming back for the same
  // service, or a document the agent produced for a turn that was then discarded — answered with the
  // FROZEN document. Its old number, its old date, and a validity that may already have run out. A
  // document a customer receives today has to be dated today.
  test("the same values on another day are another document", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    const args = { ...ARGS, cliente: "Outro dia" };
    await tool(newTurnState()).invoke(args);
    setSystemTime(new Date(Date.now() + 26 * 60 * 60 * 1000));
    try {
      await tool(newTurnState()).invoke(args);
    } finally {
      setSystemTime();
    }
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before + 2,
    );
  });

  // The playground has no conversation to attach a file to, so a document tool is simulated there
  // the way handoff and resolve are. Run for real it refused every call with the message written for
  // proactive nudges — the operator would see behaviour production never produces, on the screen
  // whose whole job is showing what the agent does.
  test("is simulated in the playground: chosen, described, and never issued", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    const [built] = buildDocumentTools(
      [
        {
          templateId,
          name: "Orçamento",
          slug: "orcamento",
          description: null,
          fields: FIELDS,
        },
      ],
      { tenantId, base: appDb, storageDir: DIR, simulate: true },
    );
    const out = String(await built?.invoke(ARGS));
    expect(out).toMatch(/simulado/);
    expect(out).toContain("Orçamento");
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before,
    );
  });

  // A proactive nudge has no turn to queue into, and its own gate (the 24h service window) decides
  // whether anything may be sent at all. Declining is the only safe answer there.
  test("declines when there is no turn to queue into", async () => {
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    const out = String(await tool(undefined).invoke(ARGS));
    expect(out).toMatch(/proativa/);
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before,
    );
  });

  // Two fences, and they catch different things. The derived schema rejects a missing required
  // field before the tool body runs at all (LangChain validates first), so nothing is issued and
  // nothing is queued. What reaches the service is a value the schema cannot judge — a date is a
  // string to zod and an ISO date to the renderer — and there the refusal comes back as a message
  // the model can act on: normal operation, not an integration failure the alert channels fire on.
  test("the derived schema rejects a missing required field before anything is issued", async () => {
    const turnState = newTurnState();
    const before = await suDb.issuedDocument.count({ where: { tenantId } });
    await expect(
      tool(turnState).invoke({ itens: [] } as never),
    ).rejects.toThrow();
    expect(turnState.pendingAttachments).toHaveLength(0);
    expect(await suDb.issuedDocument.count({ where: { tenantId } })).toBe(
      before,
    );
  });

  // The key is derived from the values, so "send it again" lands on the row the operator voided.
  // The model has to be told, and told something other than "correct the data and try again" —
  // there is no correction that does not lead back to the same document.
  test("declines to resend a document the operator revoked", async () => {
    const first = newTurnState();
    await tool(first).invoke({ ...ARGS, cliente: "Revogado" });
    const row = await suDb.issuedDocument.findFirst({
      where: { tenantId },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    await suDb.issuedDocument.update({
      where: { id: row?.id as bigint },
      data: { revoked: true },
    });
    const turnState = newTurnState();
    const out = String(
      await tool(turnState).invoke({ ...ARGS, cliente: "Revogado" }),
    );
    expect(out).toMatch(/Não é possível enviar esse documento/);
    expect(turnState.pendingAttachments).toHaveLength(0);
  });

  // The operator can disable or delete a template between this turn loading its tools and the model
  // calling one. Both are decisions, not faults in the call: "correct the data and try again" is
  // futile for the first, and the second used to escape the catch entirely and fail the turn as an
  // integration error — an alert about somebody deleting their own template.
  test("declines terminally when the template is disabled or deleted mid-turn", async () => {
    await suDb.documentTemplate.update({
      where: { id: templateId },
      data: { enabled: false },
    });
    try {
      // Values unique to this test: the idempotency key is derived from them, so reusing another
      // test's arguments would return that document before the template is ever loaded — and the
      // check under test would never run.
      const disabled = String(
        await tool(newTurnState()).invoke({ ...ARGS, cliente: "Desativado" }),
      );
      expect(disabled).toMatch(/Não é possível enviar/);
    } finally {
      // In a finally so a failure here cannot leave the template disabled for every test after it.
      await suDb.documentTemplate.update({
        where: { id: templateId },
        data: { enabled: true },
      });
    }

    // Deleted: the tool was built for a template that no longer exists.
    const [gone] = buildDocumentTools(
      [
        {
          templateId: 999_999_999n,
          name: "Sumiu",
          slug: "sumiu",
          description: null,
          fields: FIELDS,
        },
      ],
      {
        tenantId,
        turnState: newTurnState(),
        threadId: `${tenantId}:1:42`,
        base: appDb,
        storageDir: DIR,
      },
    );
    const missing = String(await gone?.invoke(ARGS));
    expect(missing).toMatch(/Não é possível enviar/);
  });

  test("returns a fixable message when the service refuses a value", async () => {
    const turnState = newTurnState();
    const out = String(
      await tool(turnState).invoke({ ...ARGS, validade: "05/09/2026" }),
    );
    expect(out).toMatch(/Não consegui emitir/);
    expect(out).toMatch(/ISO date/);
    expect(turnState.pendingAttachments).toHaveLength(0);
  });
});
