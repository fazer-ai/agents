import { describe, expect, test } from "bun:test";
import { z } from "zod";
import config from "@/config";
import { auditedPromptVar, buildPromptAudit } from "@/graph/prompt-audit";
import { MAX_STRING, redactSecretsDeep } from "@/lib/redact";
import { assertSettingsDebugWindow } from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { MAX_SCHEDULE_WINDOWS } from "@/modules/business-hours/hours";
import {
  parseVariants,
  variantSchema,
  variantWriteSchema,
} from "@/modules/experiments/service";
import { readDebugModes } from "@/modules/flowlog/debug-mode";
import { DEBUG_MAX_STRING, debugCeilingFor } from "@/modules/flowlog/service";
import {
  disarmFullDetail,
  FULL_DETAIL_MAX_HOURS,
  parseIsoInstant,
  readObservabilityConfig,
} from "@/modules/flowlog/settings";
import {
  experimentCreate,
  experimentUpdate,
} from "@/modules/mcp/write-settings";

// The log debug mode of issue #58: while it is armed, this agent's flow lines keep their `detail`
// strings whole instead of cutting them at 2000, which is what lets an operator read the audited
// system prompt past that point.
//
// The mode is stored as the INSTANT IT ENDS, and that is the design under test here more than the
// lifting itself: there is no representable state where the mode is on and nobody said when it
// stops, and nothing has to RUN for it to expire.

const NOW = new Date("2026-08-25T12:00:00.000Z");
const iso = (msFromNow: number) =>
  new Date(NOW.getTime() + msFromNow).toISOString();

describe("readObservabilityConfig — the mode expires because the stored value IS the deadline", () => {
  // One row per way a bag can answer "is the mode on?", including every way it can fail to.
  const rows: Array<[string, unknown, boolean]> = [
    ["no observability block at all", {}, false],
    ["the key absent", { observability: {} }, false],
    [
      "an instant an hour ahead",
      { observability: { fullDetailUntil: iso(3_600_000) } },
      true,
    ],
    [
      "an instant a second ahead",
      { observability: { fullDetailUntil: iso(1000) } },
      true,
    ],
    [
      "an instant a second past",
      { observability: { fullDetailUntil: iso(-1000) } },
      false,
    ],
    [
      "an instant a day past",
      { observability: { fullDetailUntil: iso(-86_400_000) } },
      false,
    ],
    // The boundary is strictly greater: an instant that has ARRIVED is spent, not still running.
    [
      "exactly now",
      { observability: { fullDetailUntil: NOW.toISOString() } },
      false,
    ],
    [
      "prose where an instant should be",
      { observability: { fullDetailUntil: "amanhã" } },
      false,
    ],
    ["an empty string", { observability: { fullDetailUntil: "" } }, false],
    // Not a string at all: a bag written by hand or by an older build can hold anything here, and
    // every one of them has to leave the mode OFF, because off is what the column's documented
    // promise is written against.
    ["a boolean", { observability: { fullDetailUntil: true } }, false],
    [
      "a number of millis",
      { observability: { fullDetailUntil: NOW.getTime() + 1000 } },
      false,
    ],
    // The sharp one, and the reason the type check is load-bearing rather than tidy: `Date.parse`
    // coerces its argument to a string, and a BARE YEAR parses. Without the check, a bag holding the
    // number 2099 arms the mode until the year 2099 — permanently, and past the window bound the
    // schema enforces, because that bound only governs what a caller may newly SEND.
    [
      "a bare year as a number",
      { observability: { fullDetailUntil: 2099 } },
      false,
    ],
    // The far side of the window, and it is not a duplicate of the schema's bound: a schema only
    // governs what a CALLER SENDS, and `settings` is an arbitrary bag over REST, over the import
    // path and in the database itself. A deadline further out than the longest window anyone may
    // arm is not a deadline anyone could have set, so the reader refuses it — otherwise one write
    // the schema never saw arms the mode forever, which is the exact state the expiry exists to
    // make unreachable.
    [
      "a deadline a year out, which no arming could have produced",
      { observability: { fullDetailUntil: "2099-01-01T00:00:00.000Z" } },
      false,
    ],
    [
      "one millisecond past the longest window",
      {
        observability: {
          fullDetailUntil: iso(FULL_DETAIL_MAX_HOURS * 3_600_000 + 1),
        },
      },
      false,
    ],
    [
      "exactly the longest window",
      {
        observability: {
          fullDetailUntil: iso(FULL_DETAIL_MAX_HOURS * 3_600_000),
        },
      },
      true,
    ],
    [
      "an object",
      { observability: { fullDetailUntil: { until: iso(3_600_000) } } },
      false,
    ],
    // The one a bag can really hold that would otherwise WORK, which is why the type check is
    // load-bearing rather than tidy: `Date.parse` coerces, and a one-element array coerces to its
    // element. `["<iso>"]` therefore parses to a perfectly ordinary instant inside the window, and
    // without the check it would arm the mode from a value nothing in the system ever writes.
    [
      "an array holding the instant",
      { observability: { fullDetailUntil: [iso(3_600_000)] } },
      false,
    ],
    ["null", { observability: { fullDetailUntil: null } }, false],
  ];

  for (const [name, settings, expected] of rows) {
    test(`${name} → ${expected ? "on" : "off"}`, () => {
      const cfg = readObservabilityConfig(settings, NOW);
      expect(cfg.fullDetail).toBe(expected);
      // The instant is carried only while the mode is on, so a reader can never report an expiry
      // for a mode that is not running.
      expect(cfg.fullDetailUntil === null).toBe(!expected);
    });
  }

  test("it reports WHEN the mode ends, not just that it does", () => {
    const until = iso(3_600_000);
    expect(
      readObservabilityConfig(
        { observability: { fullDetailUntil: until } },
        NOW,
      ).fullDetailUntil?.toISOString(),
    ).toBe(until);
  });

  test("the two knobs are independent in both directions", () => {
    const onlySize = readObservabilityConfig(
      { observability: { fullDetailUntil: iso(3_600_000) } },
      NOW,
    );
    expect(onlySize.fullDetail).toBe(true);
    // Arming the SIZE switch must not start storing the customer's PII: that is the other axis, and
    // merging them is exactly what #58 refused.
    expect(onlySize.logToolValues).toBe(false);

    const onlyPii = readObservabilityConfig(
      { observability: { logToolValues: true } },
      NOW,
    );
    expect(onlyPii.logToolValues).toBe(true);
    expect(onlyPii.fullDetail).toBe(false);
  });

  test("a mode armed for the maximum window is still on at the end of it, and off past it", () => {
    const window = FULL_DETAIL_MAX_HOURS * 3_600_000;
    const settings = { observability: { fullDetailUntil: iso(window) } };
    const justBefore = new Date(NOW.getTime() + window - 1);
    const justAfter = new Date(NOW.getTime() + window + 1);
    expect(readObservabilityConfig(settings, justBefore).fullDetail).toBe(true);
    expect(readObservabilityConfig(settings, justAfter).fullDetail).toBe(false);
  });
});

describe("readDebugModes — one condition, three switches", () => {
  const armed = { observability: { fullDetailUntil: iso(3_600_000) } };
  const values = { observability: { logToolValues: true } };
  const langfuse = { langfuse: { sendContent: true } };

  test("nothing on", () => {
    const m = readDebugModes({}, {}, NOW);
    expect(m.any).toBe(false);
    expect([m.logToolValues, m.fullDetail, m.langfuseSendContent]).toEqual([
      false,
      false,
      false,
    ]);
  });

  // Each switch alone has to light the indicator. A test that only exercised two of the three would
  // pass with the third dropped from the `||`, which is the whole failure this warning exists to
  // prevent: the tenant-level one is on ANOTHER PAGE and is the one an operator forgets.
  test("the size switch alone lights it", () => {
    expect(readDebugModes(armed, {}, NOW).any).toBe(true);
  });
  test("the PII switch alone lights it", () => {
    expect(readDebugModes(values, {}, NOW).any).toBe(true);
  });
  test("the tenant's destination switch alone lights it", () => {
    expect(readDebugModes({}, langfuse, NOW).any).toBe(true);
  });

  test("an expired size switch does not light it", () => {
    expect(
      readDebugModes({ observability: { fullDetailUntil: iso(-1) } }, {}, NOW)
        .any,
    ).toBe(false);
  });

  test("the tenant switch is read as configured, not as runnable", () => {
    // No credential, no enabled flag: the operator still asked for content to leave, and an
    // indicator that went quiet because the credential broke would be lying about what is set.
    expect(
      readDebugModes({}, { langfuse: { sendContent: true } }, NOW)
        .langfuseSendContent,
    ).toBe(true);
    expect(
      readDebugModes({}, { langfuse: { sendContent: "true" } }, NOW)
        .langfuseSendContent,
    ).toBe(true);
    expect(
      readDebugModes({}, { langfuse: { sendContent: false } }, NOW)
        .langfuseSendContent,
    ).toBe(false);
    expect(readDebugModes({}, { langfuse: {} }, NOW).langfuseSendContent).toBe(
      false,
    );
  });
});

describe("the debug ceiling is derived from what the API already accepts", () => {
  // These two numbers are the justification for DEBUG_MAX_STRING, and they are pinned here so the
  // constant cannot outlive the measurement it was chosen from.
  const VARS = {
    canal: "x".repeat(1234),
    nome_contato: "Maria Aparecida da Silva",
    nome_empresa: "Clínica Exemplo",
  };
  const now = NOW;

  const factor = (template: string, vars: Record<string, string>) =>
    buildPromptAudit({ template, vars, opts: { now }, sections: [] }).length /
    template.length;

  test("the worst placeholder the closed context set allows expands 9 chars into at most 23", () => {
    // `{{canal}}` is the shortest name `buildPromptVars` answers, and the audited form is
    // `{{canal: string(N)}}`. Four digits is the widest N a real inbox name reaches.
    expect("{{canal}}".length).toBe(9);
    expect(auditedPromptVar("canal", VARS.canal).length).toBeLessThanOrEqual(
      23,
    );
  });

  test("a prompt made entirely of that placeholder expands by at most 2.56x", () => {
    expect(factor("{{canal}}".repeat(500), VARS)).toBeLessThanOrEqual(2.56);
  });

  test("ordinary prose expands by about 1.08x", () => {
    const prose =
      "Você é a atendente virtual da {{nome_empresa}}. Fale com {{nome_contato}} de forma cordial e objetiva, sempre no mesmo idioma em que a pessoa escrever. Nunca invente informações sobre procedimentos, valores ou disponibilidade: se não souber, diga que vai verificar e ofereça transferir para um atendente humano. ";
    expect(factor(prose.repeat(30), VARS)).toBeLessThan(1.2);
  });

  test("the ceiling covers the worst case over the largest prompt the API accepts", () => {
    expect(DEBUG_MAX_STRING).toBeGreaterThanOrEqual(
      Math.ceil(config.agent.promptMaxChars * 2.56),
    );
  });

  test("the ceiling is still a ceiling", () => {
    // Not "remove the cap": `detail` also carries tool arguments and results, which no configuration
    // bounds, so an unbounded write would let one runaway tool response into a row.
    expect(Number.isFinite(DEBUG_MAX_STRING)).toBe(true);
    const huge = "a".repeat(DEBUG_MAX_STRING * 2);
    const out = redactSecretsDeep({ s: huge }, 0, DEBUG_MAX_STRING) as {
      s: string;
    };
    expect(out.s).toContain("[truncated]");
    expect(out.s.length).toBeLessThanOrEqual(
      DEBUG_MAX_STRING + "…[truncated]".length,
    );
  });
});

describe("redactSecretsDeep — the ceiling is the caller's, at every depth", () => {
  const long = "a".repeat(MAX_STRING + 500);

  test("the default is the 2000 every caller had before", () => {
    const out = redactSecretsDeep({ s: long }) as { s: string };
    expect(out.s).toContain("[truncated]");
    expect(out.s.length).toBeLessThanOrEqual(
      MAX_STRING + "…[truncated]".length,
    );
  });

  test("a raised ceiling keeps the string whole", () => {
    const out = redactSecretsDeep({ s: long }, 0, MAX_STRING + 1000) as {
      s: string;
    };
    expect(out.s).toBe(long);
  });

  // The recursion is where a threaded parameter is silently dropped, and a `detail` is a nested bag
  // by construction (`{ systemPrompt }` is one level, a tool's arguments are several).
  test("it reaches a string nested in objects and arrays alike", () => {
    const out = redactSecretsDeep(
      { a: { b: [{ c: long }] } },
      0,
      MAX_STRING + 1000,
    ) as { a: { b: Array<{ c: string }> } };
    expect(out.a.b[0]?.c).toBe(long);
  });

  test("the secret scrub still runs under a raised ceiling", () => {
    const out = redactSecretsDeep(
      { s: `${long} sk-abcdefghijklmnopqrstuvwx` },
      0,
      MAX_STRING + 1000,
    ) as { s: string };
    expect(out.s).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });
});

describe("the window a caller may arm is bounded, which is what makes the expiry real", () => {
  const patch = z.object(BEHAVIOR_PATCH_SHAPE);
  const send = (v: unknown) =>
    patch.safeParse({ observability: { fullDetailUntil: v } }).success;
  const ahead = (h: number) =>
    new Date(Date.now() + h * 3_600_000).toISOString();

  test("an hour ahead is accepted", () => {
    expect(send(ahead(1))).toBe(true);
  });
  test("the maximum window is accepted", () => {
    expect(send(ahead(FULL_DETAIL_MAX_HOURS - 0.01))).toBe(true);
  });
  // Without this bound the "automatic expiry" is advisory: an operator arms the mode for the year
  // 2099 and it never arrives.
  test("a window past the maximum is refused", () => {
    expect(send(ahead(FULL_DETAIL_MAX_HOURS + 1))).toBe(false);
    expect(send("2099-01-01T00:00:00.000Z")).toBe(false);
  });
  test("null is accepted, which is how the mode is turned off", () => {
    expect(send(null)).toBe(true);
  });
  test("a past instant is accepted (it simply reads as off)", () => {
    expect(send(ahead(-1))).toBe(true);
  });
  test("prose where an instant should be is refused", () => {
    expect(send("amanhã")).toBe(false);
    expect(send(true)).toBe(false);
  });
});

// The ceiling bounds a STRING; a `detail` is a tree. Nothing in `redactSecretsDeep` bounds an
// object's key count (only arrays, at 50, and depth, at 6), so a per-leaf allowance of 300k over
// fifty leaves is a 15 MB row — the runaway tool response the raised ceiling was supposed to stop,
// arriving fifty times instead of once.
describe("the raised ceiling is a budget for the whole detail, not per string", () => {
  const long = () => "a".repeat(MAX_STRING * 2);

  test("without a budget, each string is capped on its own — unchanged for every existing caller", () => {
    const out = redactSecretsDeep({ a: long(), b: long() }) as Record<
      string,
      string
    >;
    // Both survive to the full per-string cap: this is the behaviour every line already has, and
    // sharing the ordinary 2,000 across an event would silently shorten all of them.
    expect(out.a?.length).toBeGreaterThan(MAX_STRING - 1);
    expect(out.b?.length).toBeGreaterThan(MAX_STRING - 1);
  });

  // The sum of what the LEAVES carry, which is what the budget bounds. `JSON.stringify` would
  // measure the key names too, and those grow with the field count no matter what this decides.
  const carried = (v: unknown): number =>
    typeof v === "string"
      ? v.length
      : v && typeof v === "object"
        ? Object.values(v).reduce<number>((n, x) => n + carried(x), 0)
        : 0;

  test("with a budget, the total is bounded no matter how many leaves there are", () => {
    const cap = 5_000;
    const leaves = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, "a".repeat(10_000)]),
    );
    const out = redactSecretsDeep(leaves, 0, cap, { left: cap });
    // The budget plus the ONE marker on the leaf that spent it. Not one per leaf: an allowance that
    // scales with the field count is not a bound, and this test used to grant exactly that.
    expect(carried(out)).toBeLessThanOrEqual(cap + "…[truncated]".length);
  });

  // The count is the whole point: `MAX_ARRAY` bounds arrays and `MAX_DEPTH` bounds nesting, but an
  // object's key count is bounded by nothing here. A model's tool result is an arbitrary document,
  // so "one marker per field past exhaustion" is a row that grows without limit — the debug ceiling
  // was raised to 12,050 and a five-thousand-field result would have written 60 KB of markers alone.
  test("the bound does not move when the field count does", () => {
    const cap = 4_000;
    const row = (fields: number) =>
      carried(
        redactSecretsDeep(
          Object.fromEntries(
            Array.from({ length: fields }, (_, i) => [
              `k${i}`,
              "a".repeat(500),
            ]),
          ),
          0,
          cap,
          { left: cap },
        ),
      );
    expect(row(5_000)).toBe(row(50));
    expect(row(5_000)).toBeLessThanOrEqual(cap + "…[truncated]".length);
  });

  test("a budget spent to EXACTLY zero is spent", () => {
    // The boundary the comparison is written on. `< 0` reads a budget of nothing left as room for
    // one more string, and `truncate(s, 0)` is the marker by itself — so the leak comes back for
    // every row whose leaves happen to land on the number.
    const cap = 100;
    const out = redactSecretsDeep(
      { exact: "a".repeat(cap), next: "b".repeat(50) },
      0,
      cap,
      { left: cap },
    ) as Record<string, string>;
    expect(out.exact).toBe("a".repeat(cap));
    expect(out.next).toBe("");
  });

  test("the per-string ceiling still applies under a bigger budget", () => {
    // BOTH bounds apply and the smaller wins. Consulting only the budget would leave `maxString`
    // dead whenever one is passed, so a caller could raise the per-string ceiling and never notice
    // the ceiling had stopped being read.
    const out = redactSecretsDeep({ s: "a".repeat(5_000) }, 0, 100, {
      left: 10_000,
    }) as Record<string, string>;
    expect(out.s).toBe(`${"a".repeat(100)}…[truncated]`);
  });

  test("a credential-named key is charged too, and stops at exhaustion", () => {
    // The key layer writes its own string. `‹redacted›` is ten characters in the column like any
    // other value, and an object's key count is not bounded — so a tool result full of
    // `password`-ish fields would grow the row past the budget one placeholder at a time, which is
    // the truncation marker's leak arriving by the other layer.
    const cap = 100;
    const out = redactSecretsDeep(
      {
        big: "a".repeat(cap),
        api_key: "sk-AAAAAAAAAAAAAAAAAAAA",
        password: "hunter2",
      },
      0,
      cap,
      { left: cap },
    ) as Record<string, string>;
    expect(out.big).toBe("a".repeat(cap));
    expect(out.api_key).toBe("");
    expect(out.password).toBe("");
  });

  test("placeholders alone can exhaust the budget", () => {
    // The charge is what makes the bound real: emitting the placeholder without debiting it leaves
    // the row growing one `‹redacted›` at a time forever, which is the same leak with the guard
    // still in place and never reached. Thirty characters of budget pays for three.
    const cap = 3 * "‹redacted›".length;
    const out = redactSecretsDeep(
      { a_secret: "x", b_secret: "x", c_secret: "x", d_secret: "x" },
      0,
      cap,
      { left: cap },
    ) as Record<string, string>;
    expect([out.a_secret, out.b_secret, out.c_secret]).toEqual([
      "‹redacted›",
      "‹redacted›",
      "‹redacted›",
    ]);
    expect(out.d_secret).toBe("");
  });

  test("a credential-named key still redacts while the budget holds", () => {
    // The counter-assertion: charging it must not turn the scrub off. The key layer is what drops a
    // credential wholesale, and a budget is not a reason to stop dropping it.
    const out = redactSecretsDeep(
      { password: "hunter2", tail: "b".repeat(20) },
      0,
      1_000,
      { left: 1_000 },
    ) as Record<string, string>;
    expect(out.password).toBe("‹redacted›");
    expect(out.tail).toBe("b".repeat(20));
  });

  test("without a budget the placeholder is unchanged, as every existing caller sees it", () => {
    const out = redactSecretsDeep({ password: "hunter2" }) as Record<
      string,
      string
    >;
    expect(out.password).toBe("‹redacted›");
  });

  test("an empty leaf past exhaustion stays empty, marker and all", () => {
    // `truncate("", -5)` is the marker BY ITSELF: the length test is `s.length > max`, and zero is
    // greater than a negative allowance. So an exhausted budget followed by empty fields — a tool
    // result's unset keys, which is the ordinary shape — would write a marker for each one, saying
    // a string was cut when there was no string.
    const cap = 1_000;
    const out = redactSecretsDeep(
      { big: "a".repeat(5_000), empty: "", also: "" },
      0,
      cap,
      { left: cap },
    ) as Record<string, string>;
    expect(out.empty).toBe("");
    expect(out.also).toBe("");
  });

  test("a leaf that was REDACTED is charged what it stored, not what it arrived as", () => {
    // The budget bounds the ROW, and a scrubbed credential is ten characters in the column however
    // long the token was. Charging the input would let a tool result full of tokens spend a budget
    // on bytes that never got written, and cut the content that did.
    const cap = 200;
    const token = `sk-${"A".repeat(120)}`;
    const out = redactSecretsDeep(
      { first: token, second: "b".repeat(150) },
      0,
      cap,
      { left: cap },
    ) as Record<string, string>;
    expect(out.first).toBe("‹redacted›");
    expect(out.second).toBe("b".repeat(150));
  });

  test("the first string may take the whole budget, and the next gets what is left", () => {
    const cap = 3_000;
    const out = redactSecretsDeep(
      { first: "a".repeat(10_000), second: "b".repeat(10_000) },
      0,
      cap,
      { left: cap },
    ) as Record<string, string>;
    expect(out.first?.startsWith("a")).toBe(true);
    expect(out.first?.length).toBe(cap + "…[truncated]".length);
    // Exhausted: the second leaf is EMPTY, marker included. `truncate(s, 0)` is the marker by
    // itself, and a marker nobody paid for is how the whole-row bound leaked.
    expect(out.second).toBe("");
  });

  test("the budget crosses nesting, which is where a tool's arguments actually live", () => {
    const cap = 2_000;
    const out = redactSecretsDeep(
      { args: { deep: [{ v: "a".repeat(9_000) }] }, result: "b".repeat(9_000) },
      0,
      cap,
      { left: cap },
    ) as { args: { deep: Array<{ v: string }> }; result: string };
    const spent =
      (out.args.deep[0]?.v.replace("…[truncated]", "").length ?? 0) +
      out.result.replace("…[truncated]", "").length;
    expect(spent).toBeLessThanOrEqual(cap);
  });

  test("a `generate` line is unaffected, because it holds one string", () => {
    const audit = "x".repeat(DEBUG_MAX_STRING - 10);
    const out = redactSecretsDeep(
      { systemPrompt: audit },
      0,
      DEBUG_MAX_STRING,
      {
        left: DEBUG_MAX_STRING,
      },
    ) as { systemPrompt: string };
    expect(out.systemPrompt).toBe(audit);
  });
});

// `Date.parse` is not a format check. It accepts `08/26/2026 10:00` and resolves it against the
// SERVER's local timezone, so one value armed from one console would land hours apart on two
// installations — while the field is documented as an ISO instant.
describe("only an ISO instant that names its offset arms the mode", () => {
  const rows: Array<[string, string, boolean]> = [
    ["a UTC instant", "2026-08-25T13:00:00.000Z", true],
    ["a UTC instant without millis", "2026-08-25T13:00:00Z", true],
    ["a UTC instant without seconds", "2026-08-25T13:00Z", true],
    ["an instant with a numeric offset", "2026-08-25T10:00:00-03:00", true],
    // Refused: `Date.parse` reads all three, and each means a different moment depending on where
    // the server is.
    [
      "a US-style date, which parses in server-local time",
      "08/26/2026 10:00",
      false,
    ],
    ["an ISO date with no offset at all", "2026-08-25T13:00:00", false],
    ["a bare date", "2026-08-25", false],
    ["a spelled-out date", "Aug 25 2026 13:00:00 GMT", false],
  ];

  for (const [name, value, ok] of rows) {
    test(`${name} → ${ok ? "read" : "refused"}`, () => {
      expect(parseIsoInstant(value) !== null).toBe(ok);
    });
  }

  test("the mode only arms from a value this parser accepts", () => {
    const at = new Date("2026-08-25T12:00:00.000Z");
    const on = (v: string) =>
      readObservabilityConfig({ observability: { fullDetailUntil: v } }, at)
        .fullDetail;
    expect(on("2026-08-25T13:00:00.000Z")).toBe(true);
    expect(on("08/25/2026 13:00")).toBe(false);
  });
});

// THE FAMILY, SWEPT RATHER THAN LISTED.
//
// The debug mode reaches a log line through `FlowContext.fullDetail`, and every context that knows
// an agent has to carry it — otherwise one agent's setting answers one way on a reply and another
// way on a follow-up, with nothing in the settings saying so. That is exactly what happened: the
// proactive turn was left out on the reasoning that it read no observability settings, which stopped
// being true the moment the loaded config grew the field.
//
// So the check is a sweep of every construction site, not a list of the ones remembered — and the
// FILE list has to be swept too, which it was not. It was four paths written by hand, and a hand-
// written list goes stale the same way a hand-written site list does: a new emitter arrived on the
// base (`flowlog/command.ts`) and this test had nothing to say about it, while five files that were
// there all along had never been looked at. Discovered now, from the tree.
const FLOW_SRC = new URL("../../src/", import.meta.url).pathname;

async function flowFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: FLOW_SRC })) {
    const src = await Bun.file(`${FLOW_SRC}${rel}`).text();
    if (flowContexts(src).length > 0) out.push(rel);
  }
  return out.sort();
}

// WHERE THE MODE HAS NOTHING TO WIDEN, named one by one with the reason.
//
// The mode lifts the 2,000-character cut on `detail` strings. A line whose detail is a closed
// vocabulary — counters, enums, status slugs, numeric ids — cannot reach that cut on its longest
// possible value, so carrying the mode there would buy nothing and cost a settings read per line.
// The two lines that DO carry an unbounded string, the `generate` line's audited prompt and the
// tool line's arguments and results, are in `graph/runtime.ts` and `graph/nudge.ts`.
//
// Named rather than counted, so a site added later fails this test instead of joining a tally.
const NO_LONG_STRING: Record<string, string> = {
  // `{ command: "teste" | "reset", reason: one of three literals, personaBot/routeBot: number }`.
  "modules/flowlog/command.ts": "closed vocabulary",
  // `contactAuthFlowEvent`: outcome, a boolean, an HTTP status number and a slug from a closed map.
  // The customer's text travels to the endpoint and nowhere else, which that file argues at length.
  "modules/conversations/reengage.ts": "closed vocabulary",
  // `{ coalesced: number }` and `GateCloseDetail` (`{ outcome, status }`, `gate-close.ts`).
  "modules/debounce/handler.ts": "closed vocabulary",
  // The same `GateCloseDetail`, on the handoff line.
  "modules/chatwoot/webhook.ts": "closed vocabulary",
};

// Every `FlowContext` object literal in a file, with the twelve lines that follow it: the playground
// builds its context before the settings are read and assigns the field just after, so a check that
// looked only inside the braces would call that site a miss.
function flowContexts(source: string): string[] {
  const out: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/FlowContext = \{|emitFlowEvent\($/.test(lines[i] ?? "")) continue;
    let depth = 0;
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? "";
      depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
      if (j > i && depth <= 0) break;
    }
    out.push(lines.slice(i, Math.min(j + 13, lines.length)).join("\n"));
  }
  return out;
}

describe("every flow context that knows an agent carries the debug mode", () => {
  test("the sweep finds construction sites, or it proves nothing", async () => {
    const files = await flowFiles();
    // The control has two halves. A glob that matched nothing, or a predicate that stopped seeing
    // the pattern, leaves the assertion below passing on an empty set — so the count is one half,
    // and NAMING the two files that carry the mode is the other: those are the sites the feature
    // actually rides on, and a sweep that lost them proves nothing about the ones it kept.
    let n = 0;
    for (const f of files) {
      n += flowContexts(await Bun.file(`${FLOW_SRC}${f}`).text()).length;
    }
    expect(n).toBeGreaterThanOrEqual(8);
    expect(files).toContain("graph/runtime.ts");
    expect(files).toContain("graph/nudge.ts");
  });

  test("a context naming a real agent also names the mode", async () => {
    const misses: string[] = [];
    for (const f of await flowFiles()) {
      if (f in NO_LONG_STRING) continue;
      const src = await Bun.file(`${FLOW_SRC}${f}`).text();
      for (const block of flowContexts(src)) {
        const namesAgent = /agentId: (?!null)/.test(block);
        if (!namesAgent) continue;
        // The vision-extract path in the playground loads no agent config, so it has no mode to
        // carry, and its detail holds only short enums (`kind`, `step`, `reason`) that the cap never
        // reaches. It is named here rather than excused by a count.
        if (block.includes("extractPlaygroundFile")) continue;
        // The value has to be an EXPRESSION, not a literal: `fullDetail: false` mentions the field
        // and carries nothing, which is what a hurried merge conflict resolution leaves behind and
        // what a presence check would call covered.
        if (!/fullDetail[:=]\s*(?!false\b|true\b)\S/.test(block)) {
          misses.push(`${f}: ${block.split("\n")[0]?.trim()}`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  test("an excused file is excused because it is THERE and quiet, not because it is missing", async () => {
    // A path that stops existing, or gets renamed, would go on being "excused" forever — and the
    // exemption would then be hiding nothing while a real site sat uncovered somewhere else. Every
    // name in the list has to be a file the sweep actually found; the one exception is a file the
    // derivation drops from this edition, which is not the case for any of these.
    const files = await flowFiles();
    for (const f of Object.keys(NO_LONG_STRING)) {
      if (!(await Bun.file(`${FLOW_SRC}${f}`).exists())) continue;
      expect(files).toContain(f);
    }
  });

  // The control: without it the assertion above passes on a sweep that matched nothing, and on a
  // predicate that quietly stopped seeing the `agentId` line.
  test("a context that names an agent and not the mode IS caught", () => {
    const carries = (line: string) => {
      const fake = [
        "  const flow: FlowContext = {",
        "    tenantId,",
        "    agentId: loaded.agentId,",
        line,
        "    base,",
        "  };",
      ].join("\n");
      const [block] = flowContexts(fake);
      expect(block).toBeDefined();
      expect(/agentId: (?!null)/.test(block as string)).toBe(true);
      return /fullDetail[:=]\s*(?!false\b|true\b)\S/.test(block as string);
    };
    expect(carries("    fullDetail: loaded.fullDetail,")).toBe(true);
    expect(carries("    base,")).toBe(false);
    // The one that mentions the field and carries nothing.
    expect(carries("    fullDetail: false,")).toBe(false);
    expect(carries("    fullDetail: true,")).toBe(false);
  });

  // And the deliberate exception says so in its own code rather than in this file.
  test("the one context without an agent is the unrouted line", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/flowlog/unrouted.ts", import.meta.url),
    ).text();
    expect(src).toContain("agentId: null");
  });
});

test("the debug ceiling can never fall below the ordinary one", () => {
  // `AGENT_PROMPT_MAX_CHARS` is an operator's env var and nothing stops it being small. Below 667
  // the derivation falls under 2,000, and arming the mode would then SHRINK what a line stores.
  expect(DEBUG_MAX_STRING).toBeGreaterThanOrEqual(MAX_STRING);
  expect(Math.max(MAX_STRING, 500 * 3)).toBe(MAX_STRING);
});

// The ceiling is derived from "the largest operator-authored prompt this API accepts", and that
// sentence is only true while every path that supplies a prompt is held to the same number. The A/B
// experiment variant was not: it REPLACES the agent's prompt when assigned, and its schema took any
// string, so a variant could ship a prompt the agent itself would have been refused — and the debug
// mode would then truncate the very field it exists to show.
describe("every prompt source is held to the ceiling the derivation assumes", () => {
  const at = () => "x".repeat(config.agent.promptMaxChars);
  const over = () => "x".repeat(config.agent.promptMaxChars + 1);

  test("a write at the ceiling is accepted, past it is refused", () => {
    expect(
      variantWriteSchema.safeParse({ key: "a", systemPrompt: at() }).success,
    ).toBe(true);
    expect(
      variantWriteSchema.safeParse({ key: "a", systemPrompt: over() }).success,
    ).toBe(false);
  });

  // The asymmetry is the fix, not an oversight. `variantSchema` is what `parseVariants` runs over a
  // STORED row, and it parses the whole ARRAY: bounding it would make one prompt written under the
  // older contract fail that parse and silently disable the entire experiment for every turn.
  // Bounding a write refuses the caller, who can act on it; bounding a read refuses the tenant, who
  // cannot.
  test("the READER accepts what is already stored, however long", () => {
    expect(
      variantSchema.safeParse({ key: "a", systemPrompt: over() }).success,
    ).toBe(true);
    expect(parseVariants([{ key: "a", systemPrompt: over() }])).toHaveLength(1);
  });

  test("an oversized legacy variant does not take the others down with it", () => {
    // `safeParse` on the array is all-or-nothing, so one bad entry answers `[]` and the experiment
    // stops assigning anything at all.
    expect(
      parseVariants([
        { key: "a", systemPrompt: over() },
        { key: "b", systemPrompt: "curto" },
      ]),
    ).toHaveLength(2);
  });

  test("a variant without a prompt is still valid on both", () => {
    expect(variantSchema.safeParse({ key: "a" }).success).toBe(true);
    expect(variantWriteSchema.safeParse({ key: "a" }).success).toBe(true);
  });

  test("the ceiling covers the audit of the largest prompt any path may supply", () => {
    // Both sources are now the same number, so the 2.56x worst case above still bounds the audit.
    expect(DEBUG_MAX_STRING).toBeGreaterThanOrEqual(
      Math.ceil(config.agent.promptMaxChars * 2.56),
    );
  });
});

// The audit does not only MASK: it keeps the agent's own configured hours resolved, because those
// are often the whole answer to "why did it say we were closed". A rendered schedule is not small,
// and nothing stopped a prompt from using the placeholder in every paragraph.
describe("a schedule variable expands once, not once per occurrence", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const availability = {
    schedule: {
      windows: Array.from({ length: MAX_SCHEDULE_WINDOWS }, (_, i) => ({
        day: (i % 7) as 0,
        start: `0${i % 9}:00`,
        end: `1${i % 9}:00`,
      })),
      exceptions: [],
      timezone: "America/Sao_Paulo",
    },
  };
  const audit = (template: string) =>
    buildPromptAudit({
      template,
      vars: {},
      opts: { now, availability },
      sections: [],
    });

  test("one occurrence still carries the whole schedule, which is the point of keeping it", () => {
    const a = audit("{{horario_atendimento}}");
    expect(a.length).toBeGreaterThan(2_000);
    expect(a).not.toContain("string(");
  });

  test("the repeats collapse instead of multiplying", () => {
    const one = audit("{{horario_atendimento}}").length;
    const fifty = audit("{{horario_atendimento}}".repeat(50)).length;
    // Unbounded, fifty occurrences would be fifty renderings. What it costs now is one rendering
    // plus a measured placeholder per repeat.
    expect(fifty).toBeLessThan(one * 2);
    expect(audit("{{horario_atendimento}}".repeat(50))).toContain(
      "{{horario_atendimento: string(",
    );
  });

  test("each NAME gets its own full rendering, EN spellings included", () => {
    // The collapse keys on the same map the interpolation resolves from, so `business_hours` and
    // `horario_atendimento` are two names for one concept and each keeps one rendering. A spelling
    // left out of that map would go back to expanding on every occurrence.
    const both = audit("{{horario_atendimento}}{{business_hours}}").length;
    const one = audit("{{horario_atendimento}}").length;
    expect(both).toBeGreaterThan(one * 1.5);
  });

  test("the ceiling reserves room for exactly that rule", () => {
    // Six names in the schedule map, one full rendering each, on top of the template's own audit.
    const worst = audit(
      "{{horario_atendimento}}{{business_hours}}{{esta_aberto}}{{is_open}}{{proximo_atendimento}}{{next_open_at}}".repeat(
        200,
      ),
    );
    expect(worst.length).toBeLessThan(DEBUG_MAX_STRING);
  });

  test("the reserved allowance is a MARGIN, and what is past it degrades rather than breaks", () => {
    // This input is UNREACHABLE by construction, and is built by hand for that reason: since issue
    // #346 `parseWindows` caps what any stored schedule surfaces at `MAX_SCHEDULE_WINDOWS`, so no
    // row renders past the allowance reserved above however the column was written. It used to be
    // reachable through the agent import, which took `windows` as `z.array(z.unknown())`.
    //
    // The test stays because what it pins is not the schedule, it is the ceiling's own fallback:
    // past the reserve the field is CUT, with no throw and no unbounded row. That has to keep
    // holding for whatever outgrows the reserve next, which is what makes the allowance a budget
    // rather than an assumption about its inputs.
    const huge = {
      schedule: {
        windows: Array.from({ length: MAX_SCHEDULE_WINDOWS * 200 }, (_, i) => ({
          day: (i % 7) as 0,
          start: `0${i % 9}:00`,
          end: `1${i % 9}:00`,
        })),
        exceptions: [],
        timezone: "America/Sao_Paulo",
      },
    };
    const oversized = buildPromptAudit({
      template: "{{horario_atendimento}}",
      vars: {},
      opts: { now, availability: huge },
      sections: [],
    });
    expect(oversized.length).toBeGreaterThan(DEBUG_MAX_STRING);
    const out = redactSecretsDeep(
      { systemPrompt: oversized },
      0,
      DEBUG_MAX_STRING,
      {
        left: DEBUG_MAX_STRING,
      },
    ) as { systemPrompt: string };
    expect(out.systemPrompt.endsWith("…[truncated]")).toBe(true);
    expect(out.systemPrompt.length).toBeLessThanOrEqual(
      DEBUG_MAX_STRING + "…[truncated]".length,
    );
  });

  test("and reserves it at a SMALL prompt ceiling, where it is the only thing that does", () => {
    // At this deployment's 100k the schedule term is noise beside `promptMaxChars * 3`. It exists
    // for the operator who set the prompt ceiling low: the schedule renderings do not shrink with
    // it, so without the term a short prompt naming the placeholder once would produce an audit
    // past its own ceiling and be truncated by the mode meant to show it.
    const tiny = audit("{{horario_atendimento}}{{business_hours}}");
    expect(tiny.length).toBeGreaterThan(debugCeilingFor(500) - 6 * 4_000);
    expect(tiny.length).toBeLessThan(debugCeilingFor(500));
    // And it stays above the ordinary cap however small the prompt ceiling is set — by the size of
    // the allowance itself, not by a floor: a `Math.max(MAX_STRING, …)` here was unreachable.
    expect(debugCeilingFor(0)).toBeGreaterThan(MAX_STRING);
    expect(debugCeilingFor(1)).toBeGreaterThan(MAX_STRING);
  });
});

// A read-time bound can only DELAY an over-horizon deadline, never refuse it: nothing in a lone
// instant says when it was armed, so a value 48h ahead is refused today and sits comfortably inside
// `now + 24h` tomorrow, arming the mode for the rest of its window. Refusing the WRITE is what makes
// it permanent for everything this platform stores.
describe("an over-horizon deadline is refused where it is written", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const ahead = (h: number) =>
    new Date(now.getTime() + h * 3_600_000).toISOString();
  const bag = (v: unknown) => ({ observability: { fullDetailUntil: v } });

  test("the reader's bound alone would let it in later — which is why the write refuses", () => {
    const stored = bag(ahead(48));
    expect(readObservabilityConfig(stored, now).fullDetail).toBe(false);
    // Twenty-five hours later, unchanged, the same value reads as armed.
    const later = new Date(now.getTime() + 25 * 3_600_000);
    expect(readObservabilityConfig(stored, later).fullDetail).toBe(true);
  });

  test("a write past the horizon is refused", () => {
    expect(() =>
      assertSettingsDebugWindow(bag(ahead(48)), undefined, now),
    ).toThrow();
  });

  test("a write inside the horizon is accepted", () => {
    expect(() =>
      assertSettingsDebugWindow(bag(ahead(1)), undefined, now),
    ).not.toThrow();
  });

  // Same shape as the text-size rule next to it: only what the write INTRODUCES or CHANGES is
  // refused, so a bag that already holds one does not block an unrelated save.
  test("an unchanged stored value does not block a later save", () => {
    const stored = bag(ahead(48));
    expect(() =>
      assertSettingsDebugWindow(bag(ahead(48)), stored, now),
    ).not.toThrow();
  });

  test("turning it off is always allowed", () => {
    expect(() =>
      assertSettingsDebugWindow(bag(null), bag(ahead(48)), now),
    ).not.toThrow();
    expect(() =>
      assertSettingsDebugWindow(bag(ahead(-1)), bag(ahead(48)), now),
    ).not.toThrow();
  });

  test("a bag without the block is not a write of it", () => {
    expect(() => assertSettingsDebugWindow({}, undefined, now)).not.toThrow();
    expect(() =>
      assertSettingsDebugWindow({ observability: {} }, undefined, now),
    ).not.toThrow();
  });
});

// The MCP preview runs BEFORE the service parses, so a preview that only maps arguments approves
// what the write refuses — and a preview that gets trusted is worse than no preview.
describe("the MCP dry run answers the same as the apply", () => {
  const over = "x".repeat(config.agent.promptMaxChars + 1);

  const principal = {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN" as const,
    scopes: ["mcp:read", "mcp:write"],
  } as never;
  const preview = (prompt: string) =>
    experimentCreate(principal, {
      name: "e",
      variants: [{ key: "a", system_prompt: prompt }],
      dry_run: true,
    });

  // THE CONTROL, and it is the point of this pair: without it the refusal below passes on a call
  // that never reached the check at all. It did — the first version of this test asserted a refusal
  // and was handed `insufficient_scope`, which is a refusal about something else entirely.
  test("a short variant prompt previews successfully", async () => {
    const res = JSON.stringify(await preview("curto"));
    expect(res).toContain('"ok":true');
    expect(res).not.toContain("insufficient_scope");
  });

  test("an update with an oversized variant answers, it does not throw", async () => {
    // `mapVariants` validates now, so on the update path it threw BEFORE the try — and a tool that
    // throws answers the caller with an exception instead of the `{ ok: false, error }` every other
    // refusal on this surface produces. Create had it inside the boundary; update did not.
    const res = await experimentUpdate(principal, {
      experiment_id: "1",
      variants: [{ key: "a", system_prompt: over }],
      dry_run: true,
    });
    expect(JSON.stringify(res)).toContain('"ok":false');
    expect(JSON.stringify(res)).not.toContain("insufficient_scope");
  });

  test("an oversized variant prompt is refused on the preview too", async () => {
    const res = JSON.stringify(await preview(over));
    expect(res).toContain('"ok":false');
    expect(res).not.toContain("insufficient_scope");
    expect(res).toContain("variants");
  });
});

// Proving the rule and proving its ADOPTION are two tests, and the second is the one that catches a
// call site added later. `assertSettingsTextSizes` is the write boundary this rule joined, so the
// check is that the two travel together: a transport that validates text sizes and not the window is
// a transport that can store an over-horizon deadline.
describe("every settings-write boundary charges the window too", () => {
  const FILES = ["src/modules/agents/service.ts", "src/modules/mcp/write.ts"];

  test("the pairing holds at every call site", async () => {
    let text = 0;
    let window = 0;
    for (const f of FILES) {
      const src = await Bun.file(new URL(`../../${f}`, import.meta.url)).text();
      // CALLS only: the declaration and the import name it too, and neither is a call site.
      text += src.match(/^\s+assertSettingsTextSizes\(/gm)?.length ?? 0;
      window += src.match(/^\s+assertSettingsDebugWindow\(/gm)?.length ?? 0;
    }
    // The control: a predicate that stopped matching would report 0 = 0 and pass.
    expect(text).toBeGreaterThanOrEqual(2);
    expect(window).toBe(text);
  });

  test("the counting predicate matches a call and not a declaration", () => {
    const call = "    assertSettingsDebugWindow(a, b);";
    const decl = "export function assertSettingsDebugWindow(";
    expect(/^\s+assertSettingsDebugWindow\(/m.test(call)).toBe(true);
    expect(/^\s+assertSettingsDebugWindow\(/m.test(decl)).toBe(false);
  });
});

describe("an import never arrives with the mode already armed", () => {
  const armed = new Date(Date.now() + 3_600_000).toISOString();

  test("the deadline is cleared, and the rest of the block is not", () => {
    const out = disarmFullDetail({
      observability: { logToolValues: true, fullDetailUntil: armed },
      split: { enabled: false },
    }) as Record<string, Record<string, unknown>>;
    expect(out.observability?.fullDetailUntil).toBeNull();
    // The PII switch is the operator's own configuration and travels with the bundle like every
    // other block; what is refused is a bundle ARMING a timed mode on their behalf.
    expect(out.observability?.logToolValues).toBe(true);
    expect(out.split).toEqual({ enabled: false });
  });

  test("a bag that never named it is returned untouched", () => {
    const bag = { split: { enabled: false } };
    expect(disarmFullDetail(bag)).toBe(bag);
    expect(
      disarmFullDetail({ observability: { logToolValues: true } }),
    ).toEqual({ observability: { logToolValues: true } });
  });

  test("what it produces reads as off", () => {
    const out = disarmFullDetail({ observability: { fullDetailUntil: armed } });
    expect(readObservabilityConfig(out).fullDetail).toBe(false);
  });

  test("the import path calls it", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/agents/transfer.ts", import.meta.url),
    ).text();
    expect(src).toContain("disarmFullDetail(");
  });
});

test("a date that does not exist is refused, not normalised", () => {
  // `Date.parse` answers March 2 for February 30 rather than refusing, and the shape check cannot
  // see it: February has thirty days as far as a regex is concerned.
  expect(parseIsoInstant("2026-02-30T12:00:00.000Z")).toBeNull();
  expect(parseIsoInstant("2026-13-01T12:00:00.000Z")).toBeNull();
  expect(parseIsoInstant("2026-04-31T12:00:00.000Z")).toBeNull();
  // And the ones that do exist still parse, leap day included.
  expect(parseIsoInstant("2026-02-28T12:00:00.000Z")).not.toBeNull();
  expect(parseIsoInstant("2028-02-29T12:00:00.000Z")).not.toBeNull();
  expect(parseIsoInstant("2026-12-31T23:59:00Z")).not.toBeNull();
});

test("an offset that crosses midnight is still a valid instant", () => {
  // The calendar check reads the STRING's own components. Comparing them to the parsed instant's
  // UTC date instead would refuse every offset that crosses midnight: this one is the 25th where it
  // was written and the 26th in UTC, and both are the same, perfectly ordinary moment.
  const at = parseIsoInstant("2026-08-25T23:00:00-03:00");
  expect(at).not.toBeNull();
  expect(at?.toISOString().slice(0, 10)).toBe("2026-08-26");
  expect(parseIsoInstant("2026-08-26T01:00:00+05:00")).not.toBeNull();
  // And the impossible date is still refused, offset or not.
  expect(parseIsoInstant("2026-02-30T23:00:00-03:00")).toBeNull();
});

test("a schedule variable rendered two ways keeps both", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const availability = {
    schedule: {
      windows: [{ day: 1 as const, start: "09:00", end: "18:00" }],
      exceptions: [],
      timezone: "America/Sao_Paulo",
    },
  };
  const audited = buildPromptAudit({
    template: "{{proximo_atendimento:YYYY}} e {{proximo_atendimento:HH:mm}}",
    vars: {},
    opts: { now, availability },
    sections: [],
  });
  // Two formats are the same VARIABLE answering two different things, so neither is a repeat. Keyed
  // on the name alone, the second would have collapsed into a length and the operator would have
  // lost an answer they asked for.
  expect(audited).not.toContain("string(");
  const repeated = buildPromptAudit({
    template: "{{proximo_atendimento:YYYY}} e {{proximo_atendimento:YYYY}}",
    vars: {},
    opts: { now, availability },
    sections: [],
  });
  // The same rendering twice IS a repeat.
  expect(repeated).toContain("{{proximo_atendimento: string(");
});
