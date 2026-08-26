import { describe, expect, test } from "bun:test";
import { DEBUG_MAX_STRING } from "@/modules/flowlog/service";

// THE GUARD AGAINST THE NEXT CAP THAT CUTS A CHARACTER IN HALF.
//
// `clipText` was written for ONE field (#122) and its comment already spelled out the whole cost:
// a `slice` that lands between the two halves of an astral character leaves an unpaired surrogate,
// Postgres refuses one inside a `jsonb` write, and anywhere it survives it renders as a replacement
// character in the middle of somebody's name. Every OTHER cap in the tree kept using a bare `slice`
// anyway — the rule was written next to its one call site, which is the one place a person writing
// the next cap never looks.
//
// So the rule lives with the function now (`src/lib/text.ts`) and this file is the check: every cap
// that bounds text is listed below with the entry point that reaches it, and each is fed a value
// whose astral character straddles the cut. A new cap that forgets is a failure here.
//
// NOT in scope, and the distinction is the whole reason a regex sweep would be useless: an
// index-based slice at a position the code computed (a delimiter, a trailing separator, an array
// bound) is a different operation. `slug.slice(0, 28)` after the string was already reduced to
// `[a-z0-9_-]` cannot split anything.

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

// Each entry names a cap, and runs the REAL function that applies it. The padding is swept a few
// units either side of the cap so an entry stays honest when the cut is not exactly at `cap` (an
// ellipsis suffix, a `max - 1`, an inner cap one unit wider than the outer one).
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
    // The SAME function under the log debug mode (#58), which raises the ceiling rather than
    // removing it. It is a second cap through one code path, which is precisely the shape this file
    // exists to catch: the entry above would keep passing while the raised one cut a character in
    // half, because nothing about a higher number makes a slice safe.
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
      // Read back the way the far end reads it. An orphan half survives `JSON.stringify` as a
      // `\udXXX` escape — six ASCII characters — so measuring the raw body would find nothing
      // wrong with a payload whose parser is about to produce the orphan.
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
      const { truncForAudit } = await import("@/modules/mcp/write");
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
    // is `jsonb` — so this one FAILS the issuance rather than degrading the PDF.
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
    // is a computed index (the offending braces), but the 40 that follows is a cap on the author's
    // own text, and the refusal travels through the API and to the model.
    // 38, not 40: the two braces the window opens on are themselves inside it, so the emoji has to
    // start two units earlier than the cap to straddle the cut. Measured, not reasoned — at 40 the
    // probe swept right past the boundary and the entry passed with the cut left bare.
    name: "documents: malformed-token window",
    cap: 38,
    run: async (s) => {
      const { malformedTokenIn } = await import("@/modules/documents/tokens");
      return malformedTokenIn(`{{${s}`) ?? "";
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
// that lands between an emoji's halves leaves the result BEGINNING with a lone low surrogate. Found
// in review, after a first sweep that looked only for `.slice(0, …)` and so could not see them.
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

// EVERY REMAINING TEXT-CAP-SHAPED `.slice(…)` IN `src/`, AND WHY IT IS NOT ONE.
//
// The behavioural table above proves the caps it can reach. It cannot prove the ABSENCE of a cap it
// forgot, and forgetting is the documented failure mode here: #216 named four, the first sweep found
// seventeen, and review found an eighteenth in `truncForAudit` — a walker with the same shape as
// `redactSecretsDeep`, writing to the same kind of column, missed because its file was counted and
// not read.
//
// A regex cannot tell a string cut from an array bound, so it cannot decide this on its own. What it
// can do is refuse to let anyone decide it silently: every remaining occurrence is counted here with
// a judgement attached, and a routed cap leaves no occurrence at all. A new bare cut — text or not —
// fails this test until somebody writes down which it is.
//
// TWO shapes are counted, and the second was added after review found a cap the first could not see:
// `.slice(0, n)` keeps the head, `.slice(-n)` / `.slice(x.length - n)` keeps the tail. Both bound a
// value to a maximum length; every other `.slice(…)` in the tree names a position the code computed
// (a delimiter, a marker's length, a caret, a tokenizer's window) and cannot be a cap at all.
//
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

const BARE_SLICES: Record<
  string,
  [number, NotACap | `${NotACap} + ${NotACap}`]
> = {
  "src/api/features/auth/auth.service.ts": [1, "ascii"],
  "src/api/middlewares/rateLimit.ts": [1, "index"],
  "src/client/components/Modal.tsx": [1, "array"],
  "src/client/contexts/ThemeContext.tsx": [1, "index"],
  "src/client/lib/breadcrumbs.ts": [1, "array"],
  "src/client/pages/LogsPage.tsx": [1, "array"],
  "src/client/pages/agents/CapabilityMap.tsx": [1, "array"],
  "src/client/pages/agents/PlaygroundChat.tsx": [1, "array"],
  "src/client/pages/agents/PromptPanel.tsx": [1, "index"],
  "src/client/pages/agents/followUpFormState.ts": [1, "array"],
  "src/client/pages/resources/ToolEditModal.tsx": [1, "index"],
  // The idempotency key's tail is a hex digest.
  "src/graph/tools/documents.ts": [1, "ascii"],
  "src/graph/tools/mcp.ts": [4, "ascii"],
  "src/graph/tools/native.ts": [4, "array"],
  "src/graph/tools/toolName.ts": [1, "ascii"],
  "src/graph/trace.ts": [2, "array + index"],
  "src/lib/redact.ts": [1, "array"],
  "src/lib/ssrf.ts": [1, "index"],
  "src/lib/text.ts": [3, "the-cut"],
  "src/modules/agents/credential-paths.ts": [2, "array"],
  "src/modules/agents/text-caps.ts": [1, "array"],
  // `countNotStoredAsWritten`: the bundled entries a schedule cap lets through, so the ones past it
  // count as loss rather than being tested. An array of JSON entries, never a string.
  "src/modules/agents/transfer.ts": [1, "array"],
  "src/modules/analytics/langfuse-costs.ts": [2, "fixed-format"],
  "src/modules/api-keys/verify.ts": [1, "ascii"],
  "src/modules/appointments/settings.ts": [1, "array"],
  "src/modules/business-hours/announce.ts": [2, "fixed-format"],
  "src/modules/business-hours/hours.ts": [1, "fixed-format"],
  "src/modules/chatwoot/attributes.ts": [1, "array"],
  "src/modules/conversations/service.ts": [1, "array"],
  "src/modules/debounce/handler.ts": [2, "array"],
  // The logo's one-shot download token is hex from randomUUID.
  "src/modules/documents/company.ts": [1, "ascii"],
  // The legacy date fallback reads a fixed ISO prefix; the file name was already reduced to
  // [a-zA-Z0-9-] before it is bounded, because it travels through a Content-Disposition header.
  "src/modules/documents/issue.ts": [2, "fixed-format + ascii"],
  "src/modules/documents/sample.ts": [1, "fixed-format"],
  // The tool name a template derives to, after the name was reduced to [a-z0-9_]. The two cuts moved
  // here from templates.ts when the slug rules were split out for the console to import; this ledger
  // is keyed by PATH, so a move reads exactly like an unaccounted cut appearing from nowhere.
  "src/modules/documents/slug.ts": [2, "ascii"],
  "src/modules/flowlog/export.ts": [2, "fixed-format + array"],
  "src/modules/flowlog/read.ts": [1, "array"],
  // `parseIsoInstant`: the date half of an ISO instant, to check a calendar `Date.parse` would
  // silently normalise instead (February 30 → March 2). Position 10 is the format's own boundary,
  // and the string was already matched against an ASCII-only pattern, so there is no character
  // there for a cut to land inside of.
  "src/modules/flowlog/settings.ts": [1, "fixed-format"],
  "src/modules/followups/settings.ts": [1, "array"],
  "src/modules/images/fetch.ts": [1, "array"],
  // The five response-body caps below all feed `JSON.parse` and nothing else. When one of them
  // fires the document is truncated mid-structure and the parse fails either way, so routing the
  // cut would change nothing about what anyone sees.
  "src/modules/integrations/google-calendar.service.ts": [1, "parse-only"],
  "src/modules/integrations/google-drive.service.ts": [1, "parse-only"],
  "src/modules/integrations/toolpacks/asaas.ts": [
    2,
    "parse-only + fixed-format",
  ],
  // The refusal a calendar write answers with lists the nearest bookable slots; the cut bounds that
  // LIST, and each entry is a slot object this code built, never received text.
  "src/modules/integrations/toolpacks/calendar-slots.ts": [1, "array"],
  "src/modules/integrations/toolpacks/google-calendar.ts": [1, "parse-only"],
  "src/modules/integrations/toolpacks/google-drive.ts": [1, "parse-only"],
  // Zod issue PATHS, which name our own schema's keys, never the received values.
  "src/modules/integrations/mappers.ts": [1, "ascii"],
  "src/modules/mcp/write-agents.ts": [1, "array"],
  "src/modules/memory/cut.ts": [2, "index + array"],
  "src/modules/playground/service.ts": [1, "array"],
  "src/modules/split/service.ts": [1, "array"],
  "src/modules/tool-definitions/body-shape.ts": [1, "array"],
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
    const { Glob } = await import("bun");
    const found: Record<string, number> = {};
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
      const src = await Bun.file(`src/${rel}`).text();
      const n = (
        src.match(/\.slice\(\s*(?:0\s*,|-|[A-Za-z_$][\w$.]*\.length\s*-)/g) ??
        []
      ).length;
      if (n > 0) found[`src/${rel}`] = n;
    }
    const expected = Object.fromEntries(
      Object.entries(BARE_SLICES).map(([f, [n]]) => [f, n]),
    );
    expect(found).toEqual(expected);
  });
});
