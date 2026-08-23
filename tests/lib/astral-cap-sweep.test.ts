import { describe, expect, test } from "bun:test";

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
  "src/client/pages/agents/AgentEditorPage.tsx": [1, "array"],
  "src/client/pages/agents/CapabilityMap.tsx": [1, "array"],
  "src/client/pages/agents/PlaygroundChat.tsx": [1, "array"],
  "src/client/pages/agents/PromptPanel.tsx": [1, "index"],
  "src/client/pages/resources/ToolEditModal.tsx": [1, "index"],
  "src/graph/tools/mcp.ts": [4, "ascii"],
  "src/graph/tools/native.ts": [4, "array"],
  "src/graph/tools/toolName.ts": [1, "ascii"],
  "src/graph/trace.ts": [2, "array + index"],
  "src/lib/redact.ts": [1, "array"],
  "src/lib/ssrf.ts": [1, "index"],
  "src/lib/text.ts": [3, "the-cut"],
  "src/modules/agents/credential-paths.ts": [2, "array"],
  "src/modules/agents/text-caps.ts": [1, "array"],
  "src/modules/analytics/langfuse-costs.ts": [2, "fixed-format"],
  "src/modules/api-keys/verify.ts": [1, "ascii"],
  "src/modules/appointments/settings.ts": [1, "array"],
  "src/modules/business-hours/announce.ts": [2, "fixed-format"],
  "src/modules/business-hours/hours.ts": [1, "fixed-format"],
  "src/modules/chatwoot/attributes.ts": [1, "array"],
  "src/modules/conversations/service.ts": [1, "array"],
  "src/modules/debounce/handler.ts": [1, "array"],
  "src/modules/flowlog/export.ts": [2, "fixed-format + array"],
  "src/modules/flowlog/read.ts": [1, "array"],
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
