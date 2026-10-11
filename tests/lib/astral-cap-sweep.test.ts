import { describe, expect, test } from "bun:test";
import { DEBUG_MAX_STRING } from "@/modules/flowlog/service";

// The guard against the next cap that cuts a character in half. A `slice` landing between the halves
// of an astral character leaves an unpaired surrogate: Postgres refuses one inside a `jsonb` write,
// and anywhere it survives it renders as a replacement character in somebody's name. The rule lives
// with `clipText` (`src/lib/text.ts`); here every cap that bounds text runs through its real entry
// point with an astral character straddling the cut. An index-based slice at a position the code
// computed (a delimiter, an array bound, an already-ASCII slug) is a different operation, which is
// why a regex alone cannot decide this: biome-plugins/pin-bare-slices.grit lists every bare cut left.

// `for...of` yields a well-formed pair as ONE two-unit string, so a single-unit string in the
// surrogate range is by definition an orphan half.
function loneSurrogates(s: string): number {
  let n = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 0xd800 && code <= 0xdfff) n++;
  }
  return n;
}

// A value whose emoji sits exactly ON the cut: its high half is the last unit the cap keeps.
function straddling(cap: number): string {
  return `${"x".repeat(cap - 1)}😀 and then some more text past the cap`;
}

// Each entry names a cap and runs the REAL function that applies it. The padding is swept a few
// units either side of the cap, so an entry stays honest when the cut is not exactly at `cap` (an
// ellipsis suffix, a `max - 1`, an inner cap one unit wider). `KEEP` is the timezone resolver: every
// start here carries an offset, and resolution is tested in tests/graph/tools-http-appointment.test.ts.
const KEEP = (wall: string) => wall;

const CAPS: {
  name: string;
  cap: number;
  run: (input: string) => Promise<string> | string;
}[] = [
  {
    // Every identity variable spliced into the system prompt: {{nome_contato}}, {{email_contato}},
    // {{telefone_contato}}, {{canal}}. Customer-controlled by definition.
    name: "prompt: sanitizePromptValue",
    cap: 120,
    run: async (s) => {
      const { sanitizePromptValue, VALUE_MAX } = await import("@/graph/prompt");
      return sanitizePromptValue(s, VALUE_MAX);
    },
  },
  {
    // The title an operator's own booking system answers with, on its way into the appointment record
    // and from there into EVERY later turn's prompt block. Booking systems often put the patient's
    // own name in the appointment title.
    name: "appointment: extractAppointment summary",
    cap: 200,
    run: async (s) => {
      const { extractAppointment, readAppointmentDeclaration } = await import(
        "@/modules/tool-definitions/appointment"
      );
      const decl = readAppointmentDeclaration({
        action: "book",
        idPath: "id",
        startPath: "start",
        summaryPath: "title",
      });
      const r = extractAppointment(
        decl as never,
        {
          id: "ap_1",
          start: "2026-09-02T14:00:00-03:00",
          title: s,
        },
        KEEP,
      );
      return r.ok ? (r.value.summary ?? "") : "";
    },
  },
  {
    // Every string of every execution_logs.detail. THE one that fails rather than degrades: the
    // column is jsonb, the write is refused outright, and emitFlowEvent swallows it, so the stage
    // line the operator goes looking for simply is not there.
    name: "redact: truncate",
    cap: 2000,
    run: async (s) => {
      const { truncate } = await import("@/lib/redact");
      return truncate(s, 2000);
    },
  },
  {
    name: "redact: redactSecretsDeep (the shape emitFlowEvent writes)",
    cap: 2000,
    run: async (s) => {
      const { redactSecretsDeep } = await import("@/lib/redact");
      return (redactSecretsDeep({ t: s }) as { t: string }).t;
    },
  },
  {
    // The SAME function under the log debug mode, which raises the ceiling rather than removing it:
    // a second cap through one code path, and a higher number does not make a slice safe.
    name: "redact: redactSecretsDeep under the log debug ceiling",
    cap: DEBUG_MAX_STRING,
    run: async (s) => {
      const { redactSecretsDeep } = await import("@/lib/redact");
      return (redactSecretsDeep({ t: s }, 0, DEBUG_MAX_STRING) as { t: string })
        .t;
    },
  },
  {
    // Every Chatwoot attribute value rendered into the context block.
    name: "chatwoot: attribute value",
    cap: 400,
    run: async (s) => {
      const { stringifyAttributeValue } = await import(
        "@/modules/chatwoot/attributes"
      );
      return stringifyAttributeValue(s);
    },
  },
  {
    // The quoted message a reply points at, rendered into the turn the agent reads. A WhatsApp
    // quote is about as likely to hold an emoji as any string in this codebase.
    name: "chatwoot: quoted-message snippet",
    cap: 200,
    run: async (s) => {
      const { renderInboundMessage } = await import(
        "@/modules/chatwoot/render"
      );
      return renderInboundMessage(
        { text: "e a resposta?", attachmentTypes: [], inReplyTo: 9 },
        { resolveQuoted: () => s },
      );
    },
  },
  {
    // The SAME cut, in the sibling renderer for an emoji reaction. Two call sites, and a reaction
    // quoting a long message is if anything the likelier of the two to carry an emoji.
    name: "chatwoot: quoted-message snippet (reaction)",
    cap: 200,
    run: async (s) => {
      const { renderInboundMessage } = await import(
        "@/modules/chatwoot/render"
      );
      return renderInboundMessage(
        { text: "👍", attachmentTypes: [], inReplyTo: 9, isReaction: true },
        { resolveQuoted: () => s },
      );
    },
  },
  {
    // The customer's own text, forwarded to the operator's authorization endpoint as JSON. Whether
    // an escaped orphan half is accepted, replaced or refused is that endpoint's parser's call, and
    // it is not ours to gamble on.
    name: "contact-auth: forwarded message text",
    cap: 4000,
    run: async (s) => {
      const { checkContactAuthorization } = await import(
        "@/modules/contact-auth/check"
      );
      const { CONTACT_AUTH_DEFAULTS } = await import(
        "@/modules/contact-auth/settings"
      );
      let body = "";
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body ?? "");
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch;
      await checkContactAuthorization(
        {
          ...CONTACT_AUTH_DEFAULTS,
          enabled: true,
          url: "https://api.example.com/authorize",
          includeMessageText: true,
        },
        {
          phone: "+5511988887777",
          name: null,
          email: null,
          identifier: null,
          chatwootContactId: 42,
          conversationId: 901,
          inboxId: 7,
          channel: "whatsapp",
          messageText: s,
        },
        null,
        { fetchImpl, assertSafe: async (u: string) => new URL(u) },
      );
      // NOTE: read back the way the far end reads it. An orphan half survives `JSON.stringify` as a
      // six-character ASCII `\udXXX` escape, so measuring the raw body would find nothing wrong.
      return String(
        (JSON.parse(body) as { message?: { text?: string } }).message?.text ??
          "",
      );
    },
  },
  {
    // Operator-authored, stored in the agent's settings bag (a jsonb column) and read into the
    // guardrails prompt.
    name: "guardrails: competitor name",
    cap: 100,
    run: async (s) => {
      const { readGuardrailsConfig } = await import(
        "@/modules/guardrails/settings"
      );
      return readGuardrailsConfig({
        guardrails: { competitors: [s] },
      }).competitors.join("");
    },
  },
  {
    name: "branding: brand name",
    cap: 64,
    run: async (s) => {
      const { sanitizeBrandName } = await import(
        "@/api/features/branding/branding.service"
      );
      return sanitizeBrandName(s) ?? "";
    },
  },
  {
    // The console's own structured log lines.
    name: "logger: sanitized string field",
    cap: 50,
    run: async (s) => {
      const { deepSanitizeObject } = await import("@/api/lib/logger");
      return String(
        (deepSanitizeObject({ v: s }) as Record<string, unknown>).v,
      );
    },
  },
  {
    // The audit projection of an MCP write. `audit_logs.before`/`.after` are jsonb, and this row is
    // written AFTER the change has committed: a refusal here applies the change, reports a failure,
    // and drops the only record of who made it.
    name: "mcp: audit projection",
    cap: 4000,
    run: async (s) => {
      const { truncForAudit } = await import("@/modules/audit/projection");
      return String(
        (truncForAudit({ systemPrompt: s }) as { systemPrompt: string })
          .systemPrompt,
      );
    },
  },
  {
    // The provider's own words, cut down to a detail line on a 502 the operator reads.
    name: "playground: invoke-error detail",
    cap: 300,
    run: async (s) => {
      const { toPlaygroundInvokeError } = await import(
        "@/modules/playground/service"
      );
      return toPlaygroundInvokeError(new Error(s)).message;
    },
  },
  {
    // Every value a document prints: the fields the model fills in on issuance, and the contact and
    // company values the token resolver splices in. It ends up in `issued_documents.snapshot`, which
    // is `jsonb`, so this one FAILS the issuance rather than degrading the PDF.
    name: "documents: sanitizeDocumentValue",
    cap: 2_000,
    run: async (s) => {
      const { sanitizeDocumentValue } = await import(
        "@/modules/documents/tokens"
      );
      return sanitizeDocumentValue(s);
    },
  },
  {
    // The window quoted back at whoever authored a template with an unreadable {{token}}. The start
    // is a computed index (the offending braces), but the 40 that follows caps the author's own
    // text. 38, not 40: the two braces the window opens on are inside it, so the emoji has to start
    // two units earlier to straddle the cut.
    name: "documents: malformed-token window",
    cap: 38,
    run: async (s) => {
      const { malformedTokenIn } = await import("@/modules/documents/tokens");
      return malformedTokenIn(`{{${s}`) ?? "";
    },
  },
  {
    // The operator's closing line, cut on the way OUT of the settings bag. An emoji at the end of a
    // signature is the ordinary case, and an orphan half here repeats on EVERY message the agent sends.
    name: "signature: readSignatureConfig",
    cap: 500,
    run: async (s) => {
      const { readSignatureConfig } = await import(
        "@/modules/signature/service"
      );
      return readSignatureConfig({ signature: { text: s } }).text;
    },
  },
  {
    // The document title prepended to every chunk's embedding input. An emoji in an article title is
    // ordinary, and an orphan half here would reach the embeddings provider on every chunk.
    name: "rag: embeddingInput title",
    cap: 300,
    run: async (s) => {
      const { embeddingInput } = await import("@/modules/rag/documents");
      return embeddingInput(s, "chunk");
    },
  },
];

describe("no text cap ever cuts an astral character in half", () => {
  for (const { name, cap, run } of CAPS) {
    test(name, async () => {
      const offenders: number[] = [];
      for (let pad = Math.max(0, cap - 3); pad <= cap + 3; pad++) {
        const out = await run(`${"x".repeat(pad)}😀 and then some more text`);
        if (loneSurrogates(out) > 0) offenders.push(pad);
      }
      expect(offenders).toEqual([]);
    });
  }

  test("the straddling probe actually straddles (the harness is not vacuous)", () => {
    // If this ever stops holding, every case above passes for the wrong reason.
    const s = straddling(10);
    expect(loneSurrogates(s.slice(0, 10))).toBe(1);
  });
});

// Caps that keep the END of a value rather than the start. Same defect, mirrored: a start index
// between an emoji's halves leaves the result BEGINNING with a lone low surrogate.
describe("no tail cap ever starts on half a character", () => {
  test("memory: the attendance transcript, clipped from the front", async () => {
    const { renderTranscript } = await import("@/modules/memory/summarize");
    const { HumanMessage } = await import("@langchain/core/messages");
    // Two cuts live in clipTranscript: a flat 60k-character ceiling, and a token-budget pass that
    // recomputes its own start index. Sweep the emoji across both, one unit at a time.
    const offenders: string[] = [];
    for (let pad = 59_997; pad <= 60_003; pad++) {
      const body = `😀${"x".repeat(pad)}`;
      const out = renderTranscript([new HumanMessage(body)]);
      if (loneSurrogates(out) > 0) offenders.push(`chars@${pad}`);
    }
    for (let tokens = 40; tokens <= 60; tokens++) {
      // Long enough that the token pass has to cut, with emoji spread through the tail so some
      // start index lands inside one.
      const body = `${"x".repeat(400)}${"😀y".repeat(60)}`;
      const out = renderTranscript([new HumanMessage(body)], tokens);
      if (loneSurrogates(out) > 0) offenders.push(`tokens@${tokens}`);
    }
    expect(offenders).toEqual([]);
  });
});
