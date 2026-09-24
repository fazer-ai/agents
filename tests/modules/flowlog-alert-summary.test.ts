import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_COMPLETION_MESSAGE } from "@/graph/empty-completion";
import { preconditionFlowEvent } from "@/graph/tools/precondition";
import { ALERT_DETAIL_KEYS, alertSummary } from "@/modules/flowlog/alerts";
import type { FlowEvent } from "@/modules/flowlog/service";
import type { FlowLevel } from "@/modules/flowlog/stages";
import { spendCeilingFlowEvent } from "@/modules/spend-ceiling/service";

// The alert body, issue #610. The first three events are the ones a production Discord channel
// received as `[observe via openai] skipped`, `[delivery] ok` and `[delivery] error (×23)`, with the
// detail each row carried, so the expected bodies are what those alerts should have said.

type AlertEvent = FlowEvent & { level: FlowLevel };

describe("alertSummary", () => {
  test("a superseded observation names the skip, not the trigger", () => {
    const ev: AlertEvent = {
      stage: "observe",
      level: "warn",
      status: "skipped",
      provider: "openai",
      model: "gpt-5.6-luna",
      detail: { reason: "burst", skipped: "superseded", messagesRead: 12 },
    };
    expect(alertSummary(ev)).toBe("[observe via openai] skipped: superseded");
  });

  test("a delivery recovered on retry says recovered, not ok", () => {
    const ev: AlertEvent = {
      stage: "delivery",
      level: "warn",
      status: "ok",
      detail: {
        outcome: "recovered",
        deliveryEvent: "message_created",
        deliveryId: 88,
        messageId: 13990249,
        conversationId: 4412,
      },
    };
    expect(alertSummary(ev)).toBe("[delivery] ok: recovered");
  });

  test("a stranded delivery says stranded, and on which status", () => {
    const ev: AlertEvent = {
      stage: "delivery",
      level: "error",
      status: "error",
      detail: {
        outcome: "stranded",
        deliveryEvent: "message_created",
        strandedOn: "PROCESSING",
        messageId: 13990250,
        conversationId: 4413,
        knownToMirror: true,
      },
    };
    expect(alertSummary(ev)).toBe(
      "[delivery] error: stranded strandedOn=PROCESSING",
    );
  });

  test("an error with text keeps the text, whatever detail says", () => {
    const ev: AlertEvent = {
      stage: "generate",
      level: "error",
      status: "error",
      provider: "openai",
      errorMessage: "model exploded",
      detail: { outcome: "stranded" },
    };
    expect(alertSummary(ev)).toBe("[generate via openai] model exploded");
  });

  test("a turn answered by the fallback labels the reason, so it does not read as a timeout", () => {
    const ev: AlertEvent = {
      stage: "observe",
      level: "warn",
      status: "ok",
      provider: "openrouter",
      detail: {
        reason: "burst",
        fallbackFrom: "openai",
        fallbackReason: "HTTP 503",
      },
    };
    expect(alertSummary(ev)).toBe(
      "[observe via openrouter] ok: fallbackReason=HTTP 503",
    );
  });

  test("the empty-completion reason is a vocabulary word too", () => {
    const ev: AlertEvent = {
      stage: "generate",
      level: "warn",
      status: "ok",
      provider: "openrouter",
      detail: {
        fallbackFrom: "openai",
        fallbackReason: EMPTY_COMPLETION_MESSAGE,
      },
    };
    expect(alertSummary(ev)).toBe(
      `[generate via openrouter] ok: fallbackReason=${EMPTY_COMPLETION_MESSAGE}`,
    );
  });

  test("a flag whose value is a count is named by its key", () => {
    const ev: AlertEvent = {
      stage: "generate",
      level: "warn",
      status: "ok",
      provider: "openai",
      detail: { toolLimitHit: 3, toolCalls: 3 },
    };
    expect(alertSummary(ev)).toBe("[generate via openai] ok: toolLimitHit");
  });

  test("only the first cause is named", () => {
    const ev: AlertEvent = {
      stage: "contact_auth",
      level: "warn",
      status: "skipped",
      detail: { outcome: "no_identity", shared: false, reason: "no_contact" },
    };
    expect(alertSummary(ev)).toBe("[contact_auth] skipped: no_identity");
  });

  test("outside observe, reason is the cause", () => {
    const ev: AlertEvent = {
      stage: "tts",
      level: "warn",
      status: "skipped",
      detail: { reason: "no_voice" },
    };
    expect(alertSummary(ev)).toBe("[tts] skipped: no_voice");
  });

  // The builders the emit sites use, so a builder that renames its key breaks this file and not an
  // operator's night.
  test("the spend ceiling says it is over", () => {
    const ev = spendCeilingFlowEvent(
      { state: "over", usedUsd: 12, ceilingUsd: 10 },
      "inbox",
    );
    expect(alertSummary({ ...ev, level: ev.level ?? "info" })).toBe(
      "[spend_ceiling] skipped: over",
    );
  });

  test("an unreadable precondition names the phase, never the error class or the key", () => {
    const ev = preconditionFlowEvent({
      tool: "transferir",
      cond: {
        kind: "attribute",
        scope: "contact",
        key: "cpf_validado",
        equals: "sim",
      },
      reason: "unreadable",
      err: new TypeError("connection to postgres://user:pw@db/app failed"),
    });
    const body = alertSummary({ ...ev, level: ev.level ?? "info" });
    expect(body).toBe("[tool] error: phase=precondition_unreadable");
  });

  test("with nothing to explain it, the body is the status as before", () => {
    const ev: AlertEvent = {
      stage: "route",
      level: "warn",
      status: "skipped",
      detail: { chatwootInboxId: 12 },
    };
    expect(alertSummary(ev)).toBe("[route] skipped");
    expect(alertSummary({ stage: "route", level: "warn" })).toBe(
      "[route] warn",
    );
  });

  // THE FENCE, pinned by values that must never reach an alert. Each allowlisted key is fed
  // something that is not a vocabulary word, and the keys outside the list carry the payloads a tool
  // line really has when the operator turns tool values on.
  test("text, addresses and unlisted keys never reach the body", () => {
    const ev: AlertEvent = {
      stage: "tool",
      level: "warn",
      status: "error",
      detail: {
        args: { cpf: "123.456.789-00", nome: "Zebrafina Quixotesca" },
        output: "cliente_zebrafina",
        skipped: "zebrafina@example.com",
        failed: "https://example.com/zebrafina",
        outcome: "cancel for Zebrafina",
        state: "a\nb",
        reason: "",
        fallbackUnavailable: "Zebrafina Quixotesca",
        phase: { nested: "zebrafina" },
        strandedOn: ["zebrafina"],
      },
    };
    const body = alertSummary(ev);
    expect(body).toBe("[tool] error");
    expect(body.toLowerCase()).not.toContain("zebrafina");
  });

  // Issue #842: the lines a production Discord channel received as `[generate] ok` and nothing else,
  // with the detail each row carried. Both values of `resolveDiscarded` arrived, and they are the two
  // different outcomes the operator has to tell apart.
  test("a turn that ended in silence says so, and whether the conversation was closed", () => {
    for (const resolveDiscarded of [true, false]) {
      expect(
        alertSummary({
          stage: "generate",
          level: "warn",
          status: "ok",
          detail: { silenceUnexplained: true, resolveDiscarded },
        }),
      ).toBe(
        `[generate] ok: silenceUnexplained resolveDiscarded=${resolveDiscarded}`,
      );
    }
  });

  test("a proactive turn that ran beside a held thread says so", () => {
    expect(
      alertSummary({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: {
          threadWaitExpired: true,
          waitedMs: 30_000,
          note: "another invoke has held this thread past its lease",
        },
      }),
    ).toBe("[generate] ok: threadWaitExpired");
  });

  test("a channel failure names its class and the channel's error number", () => {
    expect(
      alertSummary({
        stage: "channel_error",
        level: "warn",
        status: "error",
        detail: {
          messageId: 991,
          code: "131053",
          codeRead: true,
          class: "media",
          action: "text_fallback",
        },
      }),
    ).toBe(
      "[channel_error] error: action=text_fallback class=media code=131053",
    );
  });

  test("the body stays bounded however long the error is", () => {
    const body = (n: number) =>
      alertSummary({
        stage: "generate",
        level: "error",
        errorMessage: "x".repeat(n),
      });
    expect(body(20_000).length).toBe(body(2_000).length);
    expect(body(2_000).length).toBeLessThan(320);
  });
});

// THE FENCE issue #842 asked for. A warn or error line with no `errorMessage` is explained by its
// `detail` alone, and the alert prints only the keys it knows, so a line naming none of them alerts as
// its bare status: `[generate] ok`, which is what the unexplained-silence line did for as long as
// nobody listed its key. Read off the source, so the next such line fails here instead of in an
// operator's channel. A line that is legitimately explained some other way is listed below, with why.
const EXPLAINED_ELSEWHERE: Record<string, string> = {
  // Its detail is spread from the drop, which always carries a `reason` (`CommandDrop`).
  "src/modules/flowlog/command.ts": "reason arrives through ...args.drop",
};

// The keys such a line carries that the alert does NOT print, each with why it may stay out of the
// body. The line's cause is printed from another key; these are context for the Logs page (ids,
// counts, measurements, the verdict an `outcome` already summarises). A key that is on no list fails
// the fence below even when the line also carries a printed key, which is the shape the verifier
// used to break the first version of this fence: a new cause added BESIDE `silenceUnexplained`
// would have shipped silent, because "names at least one printed key" was already true.
const NOT_A_CAUSE: Record<string, string> = {
  attempt: "tts_check: which try this was; `outcome` says what was done",
  codeRead:
    "channel_error: whether `code` was present, which the body already shows by printing it or not",
  command: "command: the command name; the drop's `reason` is the cause",
  corrupted:
    "tts_check: the line is warn only when true, so the level already says it",
  fallbackFrom: "the model given up on; `fallbackReason` says why",
  messageId: "an id to find the message by, never a cause",
  mode: "tts_check: the check's configured mode, not an outcome",
  node: "which graph node retried; `retry` is the printed flag",
  score: "tts_check: the detector's raw number",
  thresholdMs: "capacity: the configured threshold the wait crossed",
  toolCalls: "how many calls ran; `toolLimitHit` is the printed flag",
  verdict: "tts_check: the detector's label; `outcome` is the printed cause",
  waitedMs:
    "a duration, also in `durationMs`; the stage and its other keys say what waited",
};

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== "src/client") out.push(...(await sourceFiles(p)));
    } else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// The text of each `emitFlowEvent(...)` call, by bracket depth.
function flowEventCalls(src: string): { call: string; line: number }[] {
  const out: { call: string; line: number }[] = [];
  for (const m of src.matchAll(/emitFlowEvent\(/g)) {
    let depth = 1;
    let j = (m.index ?? 0) + m[0].length;
    const start = j;
    while (depth > 0 && j < src.length) {
      const c = src[j];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      j++;
    }
    out.push({
      call: src.slice(start, j),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

// The top-level keys of the `detail: { ... }` literal, comments dropped.
function detailKeys(call: string): string[] | null {
  const m = /detail:\s*\{/.exec(call);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  let token = "";
  const keys: string[] = [];
  const take = () => {
    const k = /^\s*([A-Za-z_]\w*)\s*(?::|$)/.exec(
      token.replace(/\/\/[^\n]*/g, ""),
    );
    if (k?.[1]) keys.push(k[1]);
    token = "";
  };
  while (depth > 0 && i < call.length) {
    const c = call[i] as string;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth === 1 && c === ",") take();
    else if (depth >= 1) token += c;
    i++;
  }
  take();
  return keys;
}

describe("every warn and error line names what its alert prints", () => {
  test("the scan reads the line this issue was about, and would have failed on it", () => {
    const [site] = flowEventCalls(
      'emitFlowEvent(flow, { stage: "generate", level: "warn", status: "ok", detail: { silenceUnexplained: true, resolveDiscarded } });',
    );
    expect(detailKeys(site?.call ?? "")).toEqual([
      "silenceUnexplained",
      "resolveDiscarded",
    ]);
    expect(
      ["silenceUnexplained", "resolveDiscarded"].some((k) =>
        ALERT_DETAIL_KEYS.includes(k),
      ),
    ).toBe(true);
  });

  // The list the fence reads has to be the list the body prints from, in both directions: a key the
  // body prints but the list omits would fail a line that is in fact explained.
  test("every key the body prints is on the list the fence reads", () => {
    const printed: [string, unknown][] = [
      ["reason", "no_persona"],
      ["action", "text_fallback"],
      ["silenceUnexplained", true],
      ["resolveDiscarded", false],
    ];
    for (const [key, value] of printed) {
      const body = alertSummary({
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { [key]: value },
      });
      expect(body).not.toBe("[generate] ok");
      expect(ALERT_DETAIL_KEYS).toContain(key);
    }
  });

  test("no line without an error message alerts as its bare status", async () => {
    const silent: string[] = [];
    for (const file of await sourceFiles("src")) {
      const src = await readFile(file, "utf8");
      for (const { call, line } of flowEventCalls(src)) {
        const level = /level:\s*([^,\n]*)/.exec(call)?.[1] ?? "";
        if (!/"(?:warn|error)"/.test(level)) continue;
        if (/errorMessage/.test(call)) continue;
        if (EXPLAINED_ELSEWHERE[file]) continue;
        const keys = detailKeys(call) ?? [];
        if (!keys.some((k) => ALERT_DETAIL_KEYS.includes(k)))
          silent.push(`${file}:${line} [${keys.join(", ")}]`);
      }
    }
    expect(silent).toEqual([]);
  });

  test("every key such a line sets is printed or declared as context", async () => {
    const unclassified: string[] = [];
    const used = new Set<string>();
    for (const file of await sourceFiles("src")) {
      const src = await readFile(file, "utf8");
      for (const { call, line } of flowEventCalls(src)) {
        const level = /level:\s*([^,\n]*)/.exec(call)?.[1] ?? "";
        if (!/"(?:warn|error)"/.test(level)) continue;
        if (/errorMessage/.test(call)) continue;
        for (const k of detailKeys(call) ?? []) {
          used.add(k);
          if (!ALERT_DETAIL_KEYS.includes(k) && !(k in NOT_A_CAUSE))
            unclassified.push(`${file}:${line} [${k}]`);
        }
      }
    }
    expect(unclassified).toEqual([]);
    // Both lists stay honest: a key cannot be context and printed at once, and an entry no line sets
    // any more is removed rather than left to excuse a future key of the same name.
    expect(
      Object.keys(NOT_A_CAUSE).filter((k) => ALERT_DETAIL_KEYS.includes(k)),
    ).toEqual([]);
    expect(Object.keys(NOT_A_CAUSE).filter((k) => !used.has(k))).toEqual([]);
  });
});
