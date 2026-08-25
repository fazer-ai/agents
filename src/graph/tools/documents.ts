import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { DEFAULT_TIMEZONE } from "@/graph/time";
import { AppError } from "@/lib/errors";
import type { DocumentField } from "@/modules/documents/blocks";
import { calendarDay, issueDocument, sysCtx } from "@/modules/documents/issue";
import { documentToolName } from "@/modules/documents/slug";
import { failableTool, toolFailure } from "./failure";
import type { TurnState } from "./native";

// One tool per document template the agent was granted. The tool ISSUES the document and queues it
// for delivery in the same call, because issuing and sending are one act from the customer's side:
// splitting them would cost a second model round-trip and open a window where a numbered document
// exists and nobody was told about it.
//
// The tool's ARGUMENTS are derived from the template's declared `fields`, which is the whole point of
// declaring them: the operator writes the contract once, in the console or over MCP, and the model
// sees exactly that contract — no free-form JSON, no field the renderer would drop.

export interface DocumentSelection {
  templateId: bigint;
  name: string;
  slug: string;
  description: string | null;
  fields: DocumentField[];
}

export interface DocumentToolDeps {
  tenantId: bigint;
  turnState?: TurnState;
  // The conversation's own thread key (tenant:instance:conversation). Absent off a real conversation
  // (playground, nudge), and the document is then issued unbound rather than guessed onto a
  // conversation id, which only identifies a conversation WITHIN one Chatwoot account.
  threadId?: string;
  chatwootInstanceId?: bigint | null;
  conversationDbId?: bigint | null;
  base?: PrismaClient;
  storageDir?: string;
  // The agent's own IANA zone (from its business hours). It decides the calendar day the document is
  // DATED — a document issued at 22:00 in São Paulo is 01:00 UTC the next day, and the customer must
  // not receive a quote dated tomorrow.
  timezone?: string;
  // The playground SIMULATES conversation tools rather than running them, and a document tool is
  // conversation-scoped in the same way — it needs a turn to attach to. Without this it was listed
  // as a live tool and refused every call with the proactive-message message, so the operator saw
  // behaviour the production path never produces. Simulated, they see the agent CHOOSE it, which is
  // the thing the playground is for, and no number is consumed and no row is written.
  simulate?: boolean;
}

const FIELD_HINT: Record<DocumentField["type"], string> = {
  text: "",
  number: "",
  currency:
    'Amount in the document\'s currency, as a number (1299.90, not "R$ 1.299,90").',
  date: "ISO date, YYYY-MM-DD.",
  lineItems:
    "One entry per line of the table. Never add them up: the document computes its own totals.",
};

function fieldSchema(field: DocumentField): z.ZodTypeAny {
  const described = (schema: z.ZodTypeAny) => {
    const hint = FIELD_HINT[field.type];
    const text = [field.label, field.description, hint]
      .filter(Boolean)
      .join(" — ");
    return schema.describe(text);
  };
  switch (field.type) {
    case "text":
      return described(z.string());
    case "number":
    case "currency":
      return described(z.number());
    case "date":
      return described(z.string());
    case "lineItems":
      return described(
        z.array(
          // Strict INSIDE the item too. The outer object's strictness cannot see a nested key, so a
          // model putting a discount inside a line item had it stripped before the tool body ran and
          // issued a document without data it believed it sent — the exact silent drop the strict
          // schema exists to stop, one level down.
          z
            .object({
              description: z.string(),
              quantity: z.number(),
              unitPrice: z.number(),
            })
            .strict(),
        ),
      );
  }
}

export function documentToolSchema(fields: DocumentField[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const schema = fieldSchema(field);
    shape[field.name] = field.required ? schema : schema.optional();
  }
  // STRICT: an argument the template never declared is returned to the model as an error instead of
  // being dropped. Zod strips by default, so `{cliente: "A", descontoo: 10}` would issue a document
  // silently missing the discount the model believed it sent — and `parseDocumentValues`, which
  // refuses undeclared keys, would never see it because the schema removed it first. The model can
  // fix a typo it is told about; it cannot fix one nobody reports.
  return z.object(shape).strict();
}

// Same values, same day, same document. Derived from the thread and the values rather than taken as
// an argument, so a retried turn — the model repeating itself, the graph resuming — reuses the row
// instead of putting a second numbered document in front of one customer.
//
// The DAY is in the key because a retry is what this covers, and a key with nothing time-bound in it
// never expires: a customer coming back weeks later for the same service, with the same values, was
// answered with the frozen document — its old number, its old date, and a validity that may have run
// out. A conversation is not a window; a day is a generous one for a retry and a short one for
// everything else.
//
// It is also the answer to a document the agent issued for a turn that was then DISCARDED — taken
// over, superseded, blocked. The row stays: it is the record that the agent produced it, and the
// operator can see it and send it by hand. Within the day, the same request reuses it rather than
// burning a second number; after that, it stops being reachable by accident.
//
// Key ORDER is not part of the value. Zod rebuilds the parsed object in the schema's order, and the
// schema's order is the template's declared fields — so reordering those between a call and its
// retry changes `JSON.stringify` and therefore the key, and the retry issues a SECOND numbered
// document instead of recovering the frozen one. The values are the same values either way.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

function idempotencyKey(
  templateId: bigint,
  threadId: string | undefined,
  values: unknown,
  day: string,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(canonical(values ?? {})));
  return `doc:${templateId}:${threadId ?? "unbound"}:${day}:${hasher.digest("hex").slice(0, 32)}`;
}

// Refusals no retry can get past, because they are somebody's decision rather than a fault in the
// call: the document was revoked, or the template was disabled or deleted while this turn was
// running. Matched on the error key rather than the status code — those three arrive as 409, 400 and
// 404 — because the status says how it failed and the key says what happened.
const TERMINAL_ERROR_KEYS = new Set([
  "errors.documentRevoked",
  "errors.documentNotNumbered",
  "errors.documentNotStored",
  "errors.documentTemplateDisabled",
  "errors.documentTemplateNotFound",
]);

// The text a MODEL wrote into the document, for the output guardrail to screen alongside the reply.
// Only strings, because that is where policy-bearing text can be: a price or a date carries none, and
// feeding numbers to a moderation pass costs tokens for nothing. Line-item descriptions are included
// because a line on a quote is a sentence the customer reads.
export function screenableValues(input: Record<string, unknown>): string {
  const out: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const description = (item as { description?: unknown } | null)
        ?.description;
      if (typeof description === "string") out.push(description);
    }
  }
  return out.join("\n");
}

export function buildDocumentTools(
  selections: DocumentSelection[],
  deps: DocumentToolDeps,
): StructuredToolInterface[] {
  return selections.map((selection) => {
    // Through documentToolName, never `send_` spelled again: the console derives the same string to
    // show the operator which tool a template becomes, and a second copy of the rule here is how the
    // two start disagreeing about what the model will actually be offered.
    const name = documentToolName(selection.slug);
    const description =
      `Issue and send the customer a "${selection.name}" as a PDF attached to your reply.` +
      (selection.description ? ` ${selection.description}` : "") +
      " The document is generated from the template the operator authored, numbered, and attached to this turn's answer — so say what you are sending, and do not restate the prices in text unless the customer asked for them there.";

    return failableTool(
      async (input: Record<string, unknown>) => {
        // Queued, not sent, for the same reason as send_image: delivery happens after the turn's
        // gates, so a superseded, taken-over or blocked turn must not have already put a priced
        // document in front of the customer.
        if (deps.simulate) {
          return `[simulado] Documento "${selection.name}" seria emitido e anexado à sua resposta deste turno. Nada foi emitido: no playground não há conversa para receber o arquivo.`;
        }
        const turnState = deps.turnState;
        if (!turnState) {
          return "Não é possível anexar um documento neste momento (mensagem proativa). Diga ao cliente que ele será enviado na conversa.";
        }
        // AT MOST ONE document per turn, across every document tool. The file is ours and small, so
        // the byte budget send_image carries buys nothing here, while two priced documents in one
        // message is the actual failure mode.
        //
        // The slot is taken BEFORE the await, like send_image's, and for a sharper reason: one model
        // response's tool calls run under Promise.all, so a check that only reads the QUEUE is read
        // by every call in the batch while the queue is still empty. All of them would pass, all of
        // them would issue — a numbered row and a rendered PDF each — and all but one would then be
        // thrown away, leaving documents on the tenant's list that were never sent and that nobody
        // can account for.
        //
        // Released in `finally`, so a refusal does not burn the turn. The model is told what to fix
        // and its corrected call arrives in the same turn; on the way out the queue carries the
        // claim instead.
        if (
          turnState.documentsInFlight > 0 ||
          turnState.pendingAttachments.some((a) => a.kind === "document")
        ) {
          return "Um documento já vai junto com a sua resposta deste turno. Envie o próximo em outra mensagem.";
        }
        turnState.documentsInFlight++;
        const order = turnState.attachmentsSeq++;
        // ONE clock read for the whole issuance. The key carries a calendar day and the document
        // prints one, and two `new Date()` calls straddling midnight would disagree: the key would
        // say yesterday while the page says today, so a retry an hour later computes a different key
        // and issues a SECOND numbered document for one request.
        //
        // NOT COVERED BY A TEST: reaching it needs the clock to advance across a day boundary
        // between two adjacent statements, which a frozen test clock cannot do and a real one cannot
        // be asked to. The property is structural instead — there is one read, and both consumers
        // are handed it.
        const at = new Date();
        try {
          const issued = await issueDocument({
            ctx: sysCtx(deps.tenantId),
            templateId: selection.templateId,
            idempotencyKey: idempotencyKey(
              selection.templateId,
              deps.threadId,
              input,
              // The same calendar the document PRINTS, so the window and the date on the page agree:
              // a document reused within the key's life is one dated the day it is being sent.
              calendarDay(at, deps.timezone ?? DEFAULT_TIMEZONE),
            ),
            values: input,
            threadId: deps.threadId ?? null,
            chatwootInstanceId: deps.chatwootInstanceId ?? null,
            conversationId: deps.conversationDbId ?? null,
            withBytes: true,
            base: deps.base,
            storageDir: deps.storageDir,
            timezone: deps.timezone,
            now: at,
          });
          if (!issued.bytes) {
            return toolFailure(
              "Não consegui gerar o documento agora. Ofereça encaminhar para um atendente.",
            );
          }
          turnState.pendingAttachments.push({
            bytes: issued.bytes,
            mime: "application/pdf",
            fileName: issued.fileName,
            order,
            tool: name,
            kind: "document",
            screenText: screenableValues(input),
            documentId: BigInt(issued.id),
          });
          // NOTE: no field values here, and no customer name. This string is the tool's OUTPUT, and
          // ToolFlowLogger stores tool outputs verbatim in `ExecutionLog.detail` — a column that
          // carries no customer data. The number is ours and identifies nobody.
          return `Documento ${issued.number} pronto; ele vai junto com a sua resposta deste turno.`;
        } catch (e) {
          // TERMINAL, whatever the status code: the operator voided the document, turned the
          // template off, or deleted it between this turn loading its tools and the model calling
          // one. No argument the model could change reaches a different answer — the idempotency key
          // comes from the values, so "try again" lands on the same row — and none of it is a
          // failure of ours, so none of it goes to the alert channels. Keyed by the ERROR KEY rather
          // than the status, because a disabled template is a 400 and a deleted one a 404 while both
          // are the same kind of decision.
          if (
            e instanceof AppError &&
            TERMINAL_ERROR_KEYS.has(e.translationKey ?? "")
          ) {
            return "Não é possível enviar esse documento. Siga a conversa sem prometer o envio, ou ofereça encaminhar para um atendente.";
          }
          // A rejected argument is the model's to fix and it has the message to do it with — normal
          // operation, not an integration failure. Anything else (storage gone, render crashed) is
          // the operator's problem and has to reach the alert channels.
          if (e instanceof AppError && e.statusCode === 400) {
            return `Não consegui emitir o documento: ${e.message} Corrija os dados e tente de novo, ou siga a conversa sem prometer o envio.`;
          }
          throw e;
        } finally {
          turnState.documentsInFlight--;
        }
      },
      { name, description, schema: documentToolSchema(selection.fields) },
    );
  });
}
