import { describe, expect, test } from "bun:test";
import { DEBUG_MAX_STRING } from "@/modules/flowlog/service";
import { countInSrc } from "@/tests/utils/source-text";

// The guard against the next cap that cuts a character in half. A `slice` landing between the halves
// of an astral character leaves an unpaired surrogate: Postgres refuses one inside a `jsonb` write,
// and anywhere it survives it renders as a replacement character in somebody's name. The rule lives
// with `clipText` (`src/lib/text.ts`); here every cap that bounds text runs through its real entry
// point with an astral character straddling the cut. An index-based slice at a position the code
// computed (a delimiter, an array bound, an already-ASCII slug) is a different operation, which is
// why a regex sweep alone cannot decide this.

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

// Why a remaining bare `.slice(…)` in `src/` is not a text cap:
//   array         bounds how MANY entries are kept, not how long a string is
//   index         slices at a position the code computed (a delimiter, a trailing character, a caret)
//   ascii         the value was already reduced to [a-z0-9_-] (or is ASCII by construction)
//   fixed-format  a date or version string of known ASCII shape (`toISOString().slice(0, 10)`)
//   parse-only    the cut result is handed to a parser and never used as text
//   the-cut       `clipText` itself
type NotACap =
  | "array"
  | "index"
  | "ascii"
  | "fixed-format"
  | "parse-only"
  | "the-cut";

// Every remaining text-cap-shaped `.slice(…)` in `src/`, with its judgement. The table above cannot
// prove the ABSENCE of a cap it forgot, and a regex cannot tell a string cut from an array bound, so
// a new bare cut fails until somebody writes down which it is; a routed cap leaves no occurrence.
// Two shapes are counted: `.slice(0, n)` keeps the head, `.slice(-n)` / `.slice(x.length - n)` the
// tail. Every other `.slice(…)` names a position the code computed and cannot be a cap.
const BARE_SLICES: Record<
  string,
  [number, NotACap | `${NotACap} + ${NotACap}`]
> = {
  "src/api/features/auth/auth.service.ts": [1, "ascii"],
  "src/api/lib/auth.ts": [1, "ascii"],
  "src/api/middlewares/rateLimit.ts": [1, "index"],
  "src/api/v1/document-approvals.controller.ts": [2, "array"],
  "src/client/components/Modal.tsx": [1, "array"],
  "src/client/contexts/ThemeContext.tsx": [1, "index"],
  "src/client/lib/breadcrumbs.ts": [1, "array"],
  // The text BEFORE a parse error, counted and thrown away: the cut result is never shown, stored or
  // sent. The offset comes from the JSON grammar, which reports token boundaries, so it cannot land
  // inside a code point.
  "src/client/lib/sampleJson.ts": [1, "parse-only"],
  // Four cuts into a DATE KEY: `YYYY-MM-DD` and the ten leading characters of an ISO instant. Every
  // character on either side of every one of them is a digit or a hyphen, and `DATE_KEY_RE` refuses
  // anything else before the value is used, so no cut here can land inside a surrogate pair.
  "src/client/lib/auditPeriod.ts": [4, "ascii"],
  // The cursor stack's own pop (Previous), and the page's array of entries. The one cut that lands
  // in TEXT (the preview of a `before`/`after` value, which can be a system prompt) goes through
  // `clipText` like every other cap.
  "src/client/pages/AuditPage.tsx": [1, "array"],
  "src/client/pages/LogsPage.tsx": [1, "array"],
  // The signature's own token insert, which splices at a SELECTION. A caret is a position the browser
  // maintains and it never sits between the two halves of an astral character. The two cuts in that
  // field that DO bound the value go through `clipText`.
  "src/client/pages/agents/BehaviorTab.tsx": [1, "index"],
  "src/client/pages/agents/CapabilityMap.tsx": [1, "array"],
  "src/client/pages/agents/PlaygroundChat.tsx": [1, "array"],
  "src/client/pages/agents/PromptPanel.tsx": [1, "index"],
  "src/client/pages/agents/followUpFormState.ts": [1, "array"],
  "src/client/pages/approvals/ConversationApprovals.tsx": [1, "array"],
  // Two: the token insert splices at a SELECTION, which the browser never puts inside a surrogate
  // pair, and `eachBlockEdit` cuts at the same boundary to ask what sits on either side of it.
  "src/client/pages/resources/ToolEditModal.tsx": [2, "index"],
  // The history without its last message, when that message is a stalled repeat the dangling-call
  // repair leaves to the stall's own removal. An array of messages, never a string.
  "src/graph/graph.ts": [1, "array"],
  // The idempotency key's tail is a hex digest.
  "src/graph/tools/documents.ts": [1, "ascii"],
  "src/graph/tools/mcp.ts": [5, "ascii"],
  // Six: the fifth is the ceiling on what the model is SHOWN of a scope's labels, applied to the
  // write report, and the sixth is the same ceiling over the GUARDED list. Both cut arrays of label
  // titles, so neither cut can land inside one.
  "src/graph/tools/native.ts": [6, "array"],
  // The same ceiling at its source, over the same array of titles (graph/tools/label-view.ts).
  "src/graph/tools/label-view.ts": [1, "array"],
  "src/graph/tools/toolName.ts": [1, "ascii"],
  "src/graph/trace.ts": [2, "array + index"],
  "src/lib/redact.ts": [1, "array"],
  "src/lib/ssrf.ts": [1, "index"],
  "src/lib/text.ts": [3, "the-cut"],
  "src/modules/agents/credential-paths.ts": [2, "array"],
  "src/modules/agents/text-caps.ts": [3, "array"],
  // Three, none bounding prose. `countNotStoredAsWritten` cuts the bundled entries a schedule cap lets
  // through (an array of JSON entries). `renamedToolName` trims the STEM of a tool name, already
  // `[a-z0-9_-]` from `normalizeToolName`, so the `_2` suffix fits the provider's 64. The third clamps
  // an imported protected-label list, an array of titles. The label and description that loop clips
  // go through `clipText`.
  "src/modules/agents/transfer.ts": [3, "array"],
  // The date the reminder says it was sent on, cut from `toISOString()`: a fixed-width ASCII
  // `YYYY-MM-DD` the runtime produces, never operator or customer text.
  "src/modules/appointments/reminders.ts": [1, "ascii"],
  "src/modules/api-keys/verify.ts": [1, "ascii"],
  "src/modules/appointments/settings.ts": [1, "array"],
  // The page's own overshoot row, dropped: the list takes `limit + 1` to learn whether a next page
  // exists, and it cuts an array of rows, never a string.
  // The export's two, and neither touches a string: the page's overshoot row is dropped off an ARRAY
  // of rows (`limit + 1`, to learn whether more matched), and the filename's instant is sliced off an
  // ISO string, which is ASCII by construction. The byte budget cuts BETWEEN rows and never inside
  // one, so the file cannot end on half a character either.
  "src/modules/audit/export.ts": [2, "array + ascii"],
  // The page's overshoot row, dropped off an ARRAY (`limit + 1`, to learn whether more matched). The
  // cursor codec splits on the separator it wrote rather than cutting at an offset.
  "src/modules/audit/service.ts": [1, "array"],
  "src/modules/business-hours/announce.ts": [2, "fixed-format"],
  "src/modules/business-hours/hours.ts": [1, "fixed-format"],
  "src/modules/chatwoot/attributes.ts": [1, "array"],
  // The drain's room for rows that failed here, cut off an ARRAY of row ids.
  "src/modules/chatwoot/delivery-queue.ts": [1, "array"],
  // NOTE: the first few offending account ids for the refusal message. A slice over an array of
  // NUMBERS cannot land inside a surrogate pair; the join that renders it happens after the cut.
  "src/modules/chatwoot/management.ts": [1, "array"],
  "src/modules/conversations/service.ts": [1, "array"],
  // The newest turns' lines kept off an ARRAY of turns, never a string.
  "src/modules/conversations/usage.ts": [1, "array"],
  // Two: the newest `maxFiles` of the candidate files, and the newest entries of the carried record.
  // Both are ARRAYS (of files, of `msg:attachment` entries), never a string.
  "src/modules/cross-inbox-case/carry-attachments.ts": [2, "array"],
  // The operator's case labels capped as an ARRAY of labels, never a string.
  "src/modules/cross-inbox-case/settings.ts": [1, "array"],
  "src/modules/debounce/handler.ts": [2, "array"],
  // The approval page's last messages: an array bound.
  "src/modules/documents/approval-context.ts": [1, "array"],
  // The logo's one-shot download token is hex from randomUUID.
  "src/modules/documents/company.ts": [1, "ascii"],
  // The legacy date fallback reads a fixed ISO prefix; the file name was already reduced to
  // [a-zA-Z0-9-] before it is bounded, because it travels through a Content-Disposition header.
  "src/modules/documents/issue.ts": [2, "fixed-format + ascii"],
  "src/modules/documents/sample.ts": [1, "fixed-format"],
  // The tool name a template derives to, after the name was reduced to [a-z0-9_]. This ledger is
  // keyed by PATH, so moving a cut to another file reads as an unaccounted cut there.
  "src/modules/documents/slug.ts": [2, "ascii"],
  "src/modules/flowlog/export.ts": [2, "fixed-format + array"],
  "src/modules/flowlog/read.ts": [1, "array"],
  // `parseIsoInstant`: the date half of an ISO instant, to check a calendar `Date.parse` would
  // silently normalise (February 30 to March 2). Position 10 is the format's own boundary, and the
  // string already matched an ASCII-only pattern.
  "src/modules/flowlog/settings.ts": [1, "fixed-format"],
  "src/modules/followups/settings.ts": [1, "array"],
  "src/modules/followups/snoozed-settings.ts": [2, "array"],
  "src/modules/images/fetch.ts": [1, "array"],
  // No response-body cap here: `lib/outbound.ts` caps the READ, cutting through `clipText`.
  "src/modules/integrations/toolpacks/asaas.ts": [1, "fixed-format"],
  // The refusal a calendar write answers with lists the nearest bookable slots; the cut bounds that
  // LIST, and each entry is a slot object this code built, never received text.
  "src/modules/integrations/toolpacks/calendar-slots.ts": [1, "array"],
  // Zod issue PATHS, which name our own schema's keys, never the received values.
  "src/modules/integrations/mappers.ts": [1, "ascii"],
  "src/modules/mcp/write-agents.ts": [1, "array"],
  "src/modules/memory/cut.ts": [2, "index + array"],
  // Four: the transcript window, the notes window, the label-change window and the page walk. Every
  // one is a slice of an ARRAY of rows, so none can land inside a surrogate pair.
  "src/modules/observe/job.ts": [4, "array"],
  "src/modules/playground/service.ts": [1, "array"],
  // The page of a document list: `rows.slice(0, take)` keeps the first `take` rows.
  "src/modules/rag/documents.ts": [1, "array"],
  // The balloon's own LINES, cut from the array `split("\n")` returned, to ask whether the run at
  // either end of it is the model's copy of the signature. An array of strings, never a string, so
  // no cut can land inside a code point; and the pieces are compared, never sent.
  "src/modules/signature/service.ts": [2, "array"],
  // Two: the overflow merge carries the separators beside the chunks, and both are slices of an ARRAY
  // of already-split strings, so neither can land inside a surrogate pair.
  "src/modules/split/service.ts": [2, "array"],
  // The audit fingerprint of the over-ceiling sentence: a hex digest, so the cut cannot land inside
  // a surrogate pair.
  "src/modules/tenant-settings/service.ts": [1, "ascii"],
  "src/modules/tool-definitions/body-shape.ts": [1, "array"],
  // Two. How many items the picker samples for a block's fields (entries, never characters; the
  // per-value cut inside an item goes through clipText). And `templateWriteAt` cutting the document at
  // the CARET to read what the operator typed since `{{`: CodeMirror never puts a caret inside a
  // surrogate pair, and the result is parsed, never shown.
  "src/modules/tool-definitions/response-template.ts": [2, "array"],
  "src/modules/updates/semver.ts": [1, "array"],
  // Read only to be substring-matched against the provider's auth-failure shapes, then dropped:
  // never stored, never shown, never sent anywhere.
  "src/modules/vault/secret-test.ts": [1, "parse-only"],
  // The page's own overshoot row, dropped: the list takes `limit + 1` to learn whether a next page
  // exists. Same shape as flowlog/read.ts, and it cuts an array of rows, never a string.
  "src/modules/webhooks/outbound/deliveries.ts": [1, "array"],
};

describe("every bare cut left in src/ is accounted for", () => {
  test("the file list and the per-file counts still match", async () => {
    // Through `countInSrc`, so a comment explaining a cut is not counted as one. Do not answer a
    // phantom entry by adding the file to the ledger: that arms a waiver over a file with no cut in
    // it, which silences the day it grows one.
    const found = await countInSrc(
      /\.slice\(\s*(?:0\s*,|-|[A-Za-z_$][\w$.]*\.length\s*-)/g,
    );
    const expected = Object.fromEntries(
      Object.entries(BARE_SLICES).map(([f, [n]]) => [f, n]),
    );
    expect(found).toEqual(expected);
  });
});
