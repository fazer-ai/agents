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

// The caps whose cut sits inside a module-private function, behind machinery no unit test reaches
// for the price of one assertion (a whole toolset build, a live model call, a Chatwoot round trip).
// For those the rule is checked where it is written: the cut expression that used to be bare must
// not come back. Validated by un-routing one of them and watching this fail.
const ROUTED_IN_SOURCE: { file: string; bare: RegExp; why: string }[] = [
  {
    file: "src/graph/nudge.ts",
    bare: /\.slice\(0, max\)/,
    why: "sanitizeFreeText: the untrusted inbound event text, bounded into the nudge turn",
  },
  {
    file: "src/graph/tools/http.ts",
    bare: /text\.slice\(0, maxChars\)/,
    why: "the HTTP tool's response body, handed to the model and to the flow log",
  },
  {
    file: "src/graph/tools/native.ts",
    bare: /s\.slice\(0, max - 1\)/,
    why: "the kanban card description rendered into the tool's context block",
  },
  {
    file: "src/graph/tools/rag.ts",
    bare: /d\.slice\(0, 140\)/,
    why: "the knowledge-base description rendered into the search tool's block",
  },
  {
    file: "src/modules/channel-redirect/gate.ts",
    bare: /clonedMessage\.slice\(0, MAX_CLONE_CHARS\)/,
    why: "the customer's WhatsApp message, cloned into the widget conversation",
  },
  {
    file: "src/modules/playground/service.ts",
    bare: /params\.context\.trim\(\)\.slice\(0, 500\)/,
    why: "the simulated follow-up context, bounded into the playground's nudge prompt",
  },
  {
    file: "src/modules/memory/summarize.ts",
    bare: /text\.slice\(0, ATTENDANCE_SUMMARY_MAX\)/,
    why: "the model-written attendance summary, stored and shown to the operator",
  },
];

describe("caps whose call site no cheap entry point reaches", () => {
  for (const { file, bare, why } of ROUTED_IN_SOURCE) {
    test(`${file}: ${why}`, async () => {
      // Reduced to booleans before the expect: a failing assertion that holds the whole file prints
      // the whole file.
      const src = await Bun.file(file).text();
      expect({
        routed: src.includes("clipText"),
        bareCut: bare.test(src),
      }).toEqual({
        routed: true,
        bareCut: false,
      });
    });
  }
});
