import { describe, expect, test } from "bun:test";
import {
  formatSandboxResult,
  localIsoNow,
  runSandboxedCode,
  SANDBOX_MAX_CONCURRENCY,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_STACK_BYTES,
  SANDBOX_TIMEOUT_MS,
  type SandboxOutcome,
  SandboxQueue,
} from "@/graph/tools/code-sandbox";
import { zoneFormatter, zoneOffsetSeconds } from "@/graph/tools/zone-offset";
import { replaceLoneSurrogates } from "@/lib/text";

// The snippet the issue is about, as a model writes it: normalise, weigh, `%11%10`, and END with
// the verdict. `12351612850` is the reporter's own number, valid, second check digit through the
// remainder-10 rule; typed unpunctuated, which is where the model's comparison broke.
const CPF_SNIPPET = (input: string) => `
function validateCpf(raw) {
  const d = String(raw).replace(/\\D/g, "");
  if (d.length !== 11 || /^(\\d)\\1{10}$/.test(d)) return { valid: false };
  const dv = (n) => {
    let sum = 0;
    for (let i = 0; i < n - 1; i++) sum += Number(d[i]) * (n - i);
    return (sum * 10) % 11 % 10;
  };
  return { valid: dv(10) === Number(d[9]) && dv(11) === Number(d[10]) };
}
validateCpf(${JSON.stringify(input)});
`;

const fixture = (name: string) =>
  new URL(`../fixtures/code-sandbox/${name}`, import.meta.url).href;

describe("runSandboxedCode", () => {
  test("returns the verdict the snippet computed, for the issue's own CPF in both spellings", async () => {
    for (const typed of ["12351612850", "123.516.128-50"]) {
      const out = await runSandboxedCode(CPF_SNIPPET(typed));
      expect(out.kind).toBe("value");
      expect((out as { value: string }).value).toBe('{"valid":true}');
    }
    const bad = await runSandboxedCode(CPF_SNIPPET("12351612851"));
    expect((bad as { value: string }).value).toBe('{"valid":false}');
  });

  test("the last expression is the result and console output rides along", async () => {
    const out = await runSandboxedCode(
      `console.log("step", { a: 1 }); console.warn("w"); const x = 40; x + 2`,
    );
    expect(out).toMatchObject({
      kind: "value",
      value: "42",
      logs: ['step {"a":1}', "w"],
    });
  });

  test("renders what JSON cannot say instead of lying about it", async () => {
    const cases: Array<[string, string]> = [
      ["10n ** 20n", "100000000000000000000"],
      ["({ big: 10n ** 20n })", '{"big":"100000000000000000000"}'],
      ["0 / 0", "NaN"],
      ["({ n: 1 / 0 })", '{"n":"Infinity"}'],
      ["let x = 1;", "undefined"],
      ["'text'", '"text"'],
      ["[1, 'a', null, true, undefined]", '[1,"a",null,true,null]'],
      ["new Map([[1, 2]])", "[[1,2]]"],
      ["new Set(['a'])", '["a"]'],
      ["new Date(0)", '"1970-01-01T00:00:00.000Z"'],
      ["({ f() {}, s: Symbol('q') })", '{"f":"[function]","s":"Symbol(q)"}'],
      [
        "(() => { const o = { k: 1 }; o.self = o; return o })()",
        '{"k":1,"self":"[circular]"}',
      ],
      ["new TypeError('kept')", '{"name":"TypeError","message":"kept"}'],
      // NOTE: A parsed document can carry `__proto__` as an own key, and an assignment by that name
      // reaches the legacy setter instead of the object, so the key vanished from the rendering
      // (PR #485, round 3). The nested form is the one that dropped a whole subtree.
      [
        `JSON.parse('{"__proto__":{"c":1},"a":1}')`,
        '{"__proto__":{"c":1},"a":1}',
      ],
    ];
    for (const [code, want] of cases) {
      const out = await runSandboxedCode(code);
      expect(out, code).toMatchObject({ kind: "value", value: want });
    }
    const logged = await runSandboxedCode(
      `console.log(JSON.parse('{"__proto__":"x"}')); 1`,
    );
    expect(logged).toMatchObject({
      kind: "value",
      logs: ['{"__proto__":"x"}'],
    });
  });

  // The sandbox ships NO domain logic, and this is the fence. `validateCpf`/`validateCnpj` came
  // from PR #485, where the MODEL wrote the snippet and its arithmetic could not be trusted; with
  // the operator writing the body that reason is gone, and a runtime that ships CPF is asked for
  // CEP, phone and inscricao estadual next. The rule is written once, in the body, by whoever owns
  // it. Asserted by name rather than left to the global sweep below, which would go green on a
  // helper added under a name it happens not to list.
  test("no domain helper is installed: the body brings its own rules", async () => {
    const out = await runSandboxedCode(
      `[typeof validateCpf, typeof validateCnpj, typeof checkDigit]`,
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify(["undefined", "undefined", "undefined"]),
    });
  });

  // ...and the rule the operator writes instead answers the issue's own number, unpunctuated,
  // which is where the model's comparison broke. The algorithm is the body's, not the runtime's.
  test("a body that carries the CPF rule itself answers the issue's number", async () => {
    const cases: Array<[string, string]> = [
      ["12351612850", '{"valid":true}'],
      ["123.516.128-50", '{"valid":true}'],
      ["12351612851", '{"valid":false}'],
      ["11111111111", '{"valid":false}'],
    ];
    for (const [input, want] of cases) {
      expect(await runSandboxedCode(CPF_SNIPPET(input)), input).toMatchObject({
        kind: "value",
        value: want,
      });
    }
  });

  // The NUMBER and not the text: this message reaches the model, the flow log and the alert
  // channels, and the line is the operator's own source (a literal pasted into a body would travel
  // with it). The operator reads the number against the body in their editor.
  test("a SyntaxError names the line, and never quotes it", async () => {
    const secret = "const b = ; // sk-not-a-real-key";
    const out = await runSandboxedCode(`const a = 1;\n${secret}\na + b`);
    expect(out).toMatchObject({ kind: "error", name: "SyntaxError" });
    const message = (out as { message: string }).message;
    expect(message).toContain("(line 2)");
    expect(message).not.toContain("sk-not-a-real-key");
    // In function-body mode the line is still the body's own, not the wrapper's.
    const wrapped = await runSandboxedCode(`return 1;\nconst c = ;`, {
      call: { input: {}, context: {} },
    });
    expect((wrapped as { message: string }).message).toContain("(line 2)");
  });

  test("a runtime error names its line too", async () => {
    const out = await runSandboxedCode(`const a = 1;\nconst b = null;\nb.x`);
    expect(out).toMatchObject({ kind: "error", name: "TypeError" });
    expect((out as { message: string }).message).toContain("(line 3)");
  });

  // The CVE-2026-0863 shape: reading the thrown value runs the snippet's own code. Both reads
  // below would spin forever; they come back as an error at the snippet's OWN deadline (the read
  // is not given a fresh one), not as a dead thread.
  test("a hostile thrown value is read under the snippet's deadline and cannot hang the sandbox", async () => {
    for (const code of [
      `throw { get message() { while (true) {} } }`,
      `throw { toString() { while (true) {} } }`,
    ]) {
      const started = performance.now();
      const out = await runSandboxedCode(code, { timeoutMs: 300 });
      const elapsed = performance.now() - started;
      expect(out.kind, code).toBe("error");
      expect(elapsed, code).toBeLessThan(600);
    }
    const plain = await runSandboxedCode(
      `throw { name: "Custom", message: "plain" }`,
    );
    expect(plain).toMatchObject({
      kind: "error",
      name: "Custom",
      message: "plain",
    });
  });

  // The value path is the one that DOES get a fresh deadline: rendering runs interpreter code, and a
  // value the body finished building with the deadline nearly spent would otherwise have its render
  // interrupted and come back as "[object Object]".
  //
  // WHAT THE BODY SPENDS IS PINNED TO THE CLOCK, NOT TO THE WORK. Two earlier versions of this test
  // asserted how fast this machine is, and both kept the shard red (#518). The first spent 250 ms of
  // a fixed 300 ms budget and then built 60k objects: it passed on a laptop and failed on every CI
  // runner, deterministically. The second measured the build and set the deadline just past it --
  // better, because it no longer wrote the machine down, but it still asked the SECOND run to finish
  // the same build within 1.5x of what the FIRST one took, and one scheduler preemption on a shared
  // runner is wider than that margin (measured here: the build varies 1.2x over 25 runs, and the
  // whole margin is ~12 ms).
  //
  // So the body no longer races its own budget. It builds the value with the budget wide open, then
  // SPINS on `Date.now()` until a chosen instant, which puts the end of the body at a wall-clock
  // point that does not move with how fast the build was. A stall during the build is absorbed by
  // the spin instead of being fatal.
  //
  // The leftover the render then has to live on is `setup + render/2`, and both halves are measured
  // rather than written down, because the safe window is `(setup, setup + render)` and BOTH of its
  // ends scale with the machine:
  //
  //   - above `setup`, or the BODY is interrupted (setup is the span from the deadline starting in
  //     `open()` to the snippet's first statement -- 16-23 ms here, and it is not zero);
  //   - below `setup + render`, or the render fits anyway and the renewal guards nothing.
  //
  // Halfway between them satisfies both by ALGEBRA, on any machine: the leftover is
  // `leftMs - setupMs = render/2`, which is positive and less than `render` whatever those numbers
  // turn out to be. Nothing here is a margin that a slower machine can exhaust.
  //
  // What that buys, measured by shrinking the budget, which is exactly what losing time to a stall
  // does: the previous shape survives a stall of 14 ms and fails at 15; this one survives 89 and
  // fails at 90. The factor matters less than WHICH quantity it is a fraction of -- the old margin
  // was half the BUILD, which the second run had to beat, and this one is half the RENDER, which
  // grows on exactly the machines where the old one ran out.
  test("a value built with the last of the budget is still rendered whole", async () => {
    // N IS BOUNDED FROM ABOVE BY A DEADLINE THIS TEST DOES NOT CONTROL. The renewal installs a
    // FIXED `RENDER_BUDGET_MS`, so a value too big to render inside it fails even on the baseline
    // call, whatever `timeoutMs` says -- which would put the machine's speed back into the test by
    // the other door. Measured here by walking N up: 200k still renders whole, 300k does not, so the
    // ceiling is between them and 40k leaves about 6x. The first draft of this rewrite used 100k,
    // which leaves 2-3x, and a runner that slow is exactly the one this test exists for.
    const N = 40_000;
    const BUILD = `Array.from({ length: ${N} }, (_, i) => ({ i }))`;
    const CHARS = 20_000_000;

    // SETUP: the deadline starts in `open()`, and the interpreter's prelude runs inside it, so the
    // snippet's own first statement is already this far past the start.
    //
    // Read from the WORKER's own `ms`, which starts at the top of `run()` — a hair before `open()`
    // — and not from this side of the call. Measuring it here would fold in spawning the worker and
    // dispatching to it, which happen BEFORE the deadline exists: measured, 16-25 ms from here
    // against 9 ms of deadline-covered setup, an inflation the same size as the leftover itself.
    // Overstating it inflates `leftMs` by the same amount, which leaves the render enough real time
    // to finish WITHOUT the renewal — and the assertions below cannot see it, because they subtract
    // the same overstated number.
    const clockT0 = performance.now();
    const clock = await runSandboxedCode("Date.now()", { timeoutMs: 30_000 });
    const clockWall = performance.now() - clockT0;
    expect(clock.kind).toBe("value");
    const setupMs = (clock as { ms: number }).ms;
    // ...and the same call answers a SECOND question: what a round trip costs when the value is
    // tiny. `wall - ms` on any call folds in spawning the worker and dispatching to it, which happen
    // before `run()` starts its own clock and are not rendering anything. Measured, that is 9-14 ms
    // here and it is the term the round-2 finding is about: on a runner where startup drags, it
    // inflates the render figure below without the render getting any slower.
    const overheadMs = clockWall - setupMs;
    expect(overheadMs).toBeGreaterThan(0);

    // RENDER: wall minus the span `ms` covers, which ends before the render begins.
    const t0 = performance.now();
    const baseline = await runSandboxedCode(BUILD, {
      timeoutMs: 30_000,
      maxChars: CHARS,
    });
    const wall = performance.now() - t0;
    expect(baseline.kind).toBe("value");
    const buildMs = (baseline as { ms: number }).ms;
    // NET of the round-trip cost above, so what is left is the render plus carrying its result back
    // — and no longer moves with how long the worker took to come up. Measured at this N: 66-74 ms
    // gross, 9-14 ms of that being startup, 52-64 ms net, against an interpreter render the sweep
    // below puts at 30-40 ms.
    const renderMs = wall - buildMs - overheadMs;
    // The premise, asserted rather than assumed: there has to BE a render to interrupt.
    expect(renderMs).toBeGreaterThan(1);

    // A QUARTER of that, because even net of the round trip it is the render PLUS carrying the
    // result back. Swept with the renewal removed, which is the only way to see the interpreter's
    // half alone: at 20k the render is interrupted with 20 ms left and fits with 25, and at 40k it
    // is interrupted with 30 and fits with 40. Against the 52-64 ms net that is a ratio near 0.6, so
    // sizing the leftover at HALF would land on the threshold — measured, the mutation this test
    // exists to catch survived 2 runs in 5 that way. A quarter is 13-16 ms against a threshold of
    // 30, and the two ends of that margin are the sweep and the measurement, not a guess.
    const leftMs = setupMs + Math.floor(renderMs / 4);
    // THE SIZING IS THE TEST, so it is asserted and not merely computed. Both bounds were shown to
    // matter by mutation: with the leftover at 3x the render, and with the spin below removed, this
    // test PASSES while the renewal is gone -- it would guard nothing and say so to nobody.
    const leftoverMs = leftMs - setupMs;
    expect(leftoverMs).toBeGreaterThan(0);
    expect(leftoverMs).toBeLessThan(renderMs);
    // The budget is the leftover plus room the build cannot plausibly need, scaled to the build this
    // machine actually does rather than to a number from mine: the spin absorbs whatever is left.
    // ...and CAPPED, because this number is a busy spin the test itself has to sit through. A
    // baseline preempted into a 240 ms build would make `buildMs * 20` a 4.8-second spin, and Bun's
    // own per-test deadline is 5 s: the test would then fail by timing out on exactly the stalled
    // runner it is meant to survive.
    const budgetMs = leftMs + Math.min(2_000, Math.max(500, buildMs * 20));
    const spun = `const t0 = Date.now(); const v = ${BUILD}; while (Date.now() - t0 < ${budgetMs - leftMs}) {} v`;

    const out = await runSandboxedCode(spun, {
      timeoutMs: budgetMs,
      maxChars: CHARS,
    });
    // Not `limit`: the body ends `render/2` before the deadline by construction, so a body that was
    // interrupted means the arithmetic above is wrong, not that the machine was slow.
    expect(out.kind).toBe("value");
    // ...and the body really did spend the budget, which is the other half the mutation found: with
    // the spin gone the body returns after the build, the render inherits a budget it never needed
    // renewed, and this test passes while guarding nothing. `ms` covers the setup and the body.
    expect((out as { ms: number }).ms).toBeGreaterThanOrEqual(
      budgetMs - leftMs,
    );
    const v = (out as { value: string }).value;
    expect(v.startsWith('[{"i":0},{"i":1}')).toBe(true);
    expect(v.endsWith(`{"i":${N - 1}}]`)).toBe(true);
    // Comfortably above the cap plus the three calls that precede the spin, so the cap is what
    // bounds this test and not a default nobody here chose.
  }, 20_000);

  // A value can still run the body's code AFTER the body returned: a getter, a proxy trap. The
  // renderer used to swallow that and answer "[object Object]" as a successful value, so the agent
  // read a verdict nobody produced and the operator was never alerted — the failure contract says a
  // throw from the body is a failure, and this is one, one step later.
  test("a throw while the value is being read is an error, not a value", async () => {
    for (const code of [
      'return { get x() { throw new Error("boom") } }',
      'return new Proxy({}, { ownKeys() { throw new Error("boom") } })',
    ]) {
      const out = await runSandboxedCode(code, {
        call: { input: {}, context: {} },
      });
      expect([code, out.kind]).toEqual([code, "error"]);
      expect((out as { message: string }).message).toContain("boom");
    }
    // A console LINE that cannot be rendered is not a failed call: the fallback stays there.
    const logged = await runSandboxedCode(
      'console.log({ get y() { throw new Error("log") } }); return { ok: true }',
      { call: { input: {}, context: {} } },
    );
    expect(logged).toMatchObject({ kind: "value", value: '{"ok":true}' });
    expect((logged as { logs: string[] }).logs).toEqual(["[object Object]"]);
  });

  test("the agent's clock is inside: TIMEZONE and NOW_LOCAL, not the interpreter's UTC", async () => {
    // 01:30 UTC on the 15th is still the 14th in São Paulo; the string says so and parses back to
    // the same instant.
    const now = new Date("2026-01-15T01:30:00Z");
    const out = await runSandboxedCode(
      `[TIMEZONE, NOW_LOCAL, new Date(NOW_LOCAL).toISOString(), NOW_LOCAL.slice(0, 10)]`,
      { clock: { timezone: "America/Sao_Paulo", now } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        "America/Sao_Paulo",
        "2026-01-14T22:30:00.000-03:00",
        "2026-01-15T01:30:00.000Z",
        "2026-01-14",
      ]),
    });
    const utc = await runSandboxedCode(`[TIMEZONE, typeof NOW_LOCAL]`);
    expect(utc).toMatchObject({ kind: "value", value: '["UTC","string"]' });
  });

  // Round 4 of PR #485: TIMEZONE and NOW_LOCAL are strings, and `Date` was the interpreter's, whose
  // local methods follow the HOST's zone (UTC in the container), so `new Date(NOW_LOCAL).getDate()`
  // was the UTC day — the exact date arithmetic the description advertises, wrong every evening.
  // Measured before the design: `process.env.TZ` inside a Bun worker changes nothing (assigned, or
  // passed as the worker's env), and the process zone is shared by every turn in flight anyway. So
  // the zone is applied INSIDE the interpreter, through one host function that answers the zone's
  // offset at an instant. Tokyo, so that a host in São Paulo (this machine) and one in UTC (CI)
  // both disagree with every expected value; the reference values are Bun's own Date under TZ.
  test("Date's local methods follow TIMEZONE, not the host's zone", async () => {
    const now = new Date("2026-01-14T22:30:00Z"); // 07:30 on Thursday the 15th in Tokyo
    const out = await runSandboxedCode(
      `const d = new Date(NOW_LOCAL);
       [d.getDate(), d.getHours(), d.getTimezoneOffset(), d.getDay(),
        new Date(2026, 0, 15, 7, 30).toISOString(),
        Date.parse("2026-01-15T07:30") === d.getTime(),
        new Date("2026-01-15T07:30:00").getTime() === d.getTime(),
        d.toString(), d.toDateString(), d.toTimeString(),
        (() => { const e = new Date(d); e.setDate(e.getDate() + 1); return e.toISOString() })(),
        (() => { const e = new Date(d); e.setHours(0, 0, 0, 0); return e.toISOString() })(),
        new Date("2026-01-15").getTime() === Date.UTC(2026, 0, 15),
        d.toISOString(), d instanceof Date, Object.prototype.toString.call(d),
        new Date(26, 0, 1).getFullYear(), new Date(NaN).toString(), String(new Date(NaN).getDate()),
        \`\${d}\` === d.toString(), JSON.stringify({ d })]`,
      { clock: { timezone: "Asia/Tokyo", now } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        15,
        7,
        -540,
        4,
        "2026-01-14T22:30:00.000Z",
        true,
        true,
        "Thu Jan 15 2026 07:30:00 GMT+0900",
        "Thu Jan 15 2026",
        "07:30:00 GMT+0900",
        "2026-01-15T22:30:00.000Z",
        "2026-01-14T15:00:00.000Z",
        true,
        "2026-01-14T22:30:00.000Z",
        true,
        "[object Date]",
        1926,
        "Invalid Date",
        "NaN",
        true,
        '{"d":"2026-01-14T22:30:00.000Z"}',
      ]),
    });
  });

  // A zone with transitions, across both of them. The two wall-clock times that have no single
  // answer are pinned to what the spec (and Bun) say: a time inside the spring gap keeps the offset
  // from before it, a time that happens twice in autumn is its first occurrence. The gap case is
  // what a one-step conversion gets wrong by an hour.
  // Round 5 of PR #485: an offset-less string with a field out of range (`2026-13-01T00:00`, a
  // minute of 60) went through `Date.UTC`, which normalises, where the engine's own parser answers
  // NaN — a malformed customer date silently became another date. The wall clock is now what the
  // engine makes of the same text as UTC, so the two spellings agree field for field: measured in
  // QuickJS and in Bun alike, month 13 / minute 60 / second 60 / month 0 / day 0 are NaN, February
  // 30 and 24:00 normalise. `setYear` (Annex B) was also outside the shim; the engine happened to
  // route it through `setFullYear`, and it is defined on its own now so that nothing rests on that.
  test("a malformed local date is NaN like the engine's own, and setYear is local too", async () => {
    const out = await runSandboxedCode(
      `[String(Date.parse("2026-13-01T00:00")), String(new Date("2026-01-01T00:60").getTime()),
        String(Date.parse("2026-01-01T23:59:60")), String(Date.parse("2026-00-10T00:00")),
        Date.parse("2026-02-30T00:00") - Date.parse("2026-02-30T00:00Z"),
        Date.parse("2026-01-01T24:00") === Date.parse("2026-01-02T00:00"),
        (() => { const d = new Date(2006, 2, 20, 12, 0); d.setYear(2007); return [d.getHours(), d.toISOString()] })(),
        (() => { const d = new Date(2006, 2, 20, 12, 0); d.setYear(99); return d.getFullYear() })(),
        (() => { const d = new Date(NaN); return String(d.setYear(2007)) })()]`,
      { clock: { timezone: "America/New_York" } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        "NaN",
        "NaN",
        "NaN",
        "NaN",
        300 * 60_000,
        true,
        [12, "2007-03-20T16:00:00.000Z"],
        1999,
        // The spec's +0 rule: a year set on an invalid date is January 1st of that year, local.
        "1167627600000",
      ]),
    });
  });

  test("a DST zone is honored across its transitions, gap and overlap included", async () => {
    const out = await runSandboxedCode(
      `[new Date("2026-01-10T12:00:00Z").getTimezoneOffset(),
        new Date("2026-07-10T12:00:00Z").getTimezoneOffset(),
        new Date(2026, 2, 8, 3, 30).toISOString(),
        new Date(2026, 2, 8, 2, 30).toISOString(),
        new Date(2026, 10, 1, 1, 30).toISOString(),
        Date.parse("2026-03-08T02:30"),
        (() => { const e = new Date("2026-03-07T12:00:00Z"); e.setDate(e.getDate() + 1); return [e.getHours(), e.toISOString()] })()]`,
      { clock: { timezone: "America/New_York" } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        300,
        240,
        "2026-03-08T07:30:00.000Z",
        "2026-03-08T07:30:00.000Z",
        "2026-11-01T05:30:00.000Z",
        1772955000000,
        [7, "2026-03-08T11:00:00.000Z"],
      ]),
    });
  });

  // Round 7: every offset-less text the engine accepts beyond the ISO `T` form is read in the HOST's
  // zone (measured: three hours apart between a UTC host and a São Paulo one). Tokyo as the agent,
  // so that this machine (São Paulo) and CI (UTC) both disagree with the expected values; a date
  // alone stays UTC and a designator stays the engine's, as the spec says.
  test("an offset-less text in any format the engine accepts is read in TIMEZONE", async () => {
    const out = await runSandboxedCode(
      `[new Date("2026-09-05 12:00:00").toISOString(),
        Date.parse("2026/09/05 12:00"), Date.parse("Sep 5, 2026 12:00"),
        Date.parse("2026-09-05T12:00:00.1234"),
        Date.parse("2026-09-05"), Date.parse("2026-09-05T12:00:00.000+02:00"),
        Date.parse("Sat, 05 Sep 2026 12:00:00 GMT"), String(Date.parse("not a date")),
        // Round 10: the engine's own zone table, absolute in any host — and a parenthesis alone is not a zone.
        Date.parse("Sep 5, 2026 12:00 EST"), Date.parse("Sep 5, 2026 12:00 UT"),
        Date.parse("Sat Sep 05 2026 12:00:00 GMT+0200 (Central European Summer Time)"),
        Date.parse("Sep 5, 2026 12:00 +02"), Date.parse("Sep 5, 2026 12:00 CEST"),
        Date.parse("Sep 5, 2026 12:00 GMT (x)"), Date.parse("Sep 5, 2026 12:00 (Eastern)"),
        Date.parse("Sep 5, 2026 12:00 +2"), Date.parse("Sep 5, 2026 12:00 GMT+2"),
        String(Date.parse("Sep 5, 2026 12:00 JST")),
        // Round 14: a year alone is a date alone; an offset glued to the time, or followed by two
        // comments, is a designator; a day or a year at the end of a date is NOT one, and a date
        // padded with spaces is the free form, which the engine reads as local.
        Date.parse("2026"), Date.parse("Sep 5, 2026 12:00-03"), Date.parse("Sep 5, 2026 12:00 -3 (x) (y)"),
        Date.parse("2026-09-05T12:00:00+0200"),
        Date.parse("09-05-2026"), Date.parse(" 2026-09-05 "), Date.parse("12:00 2026-09-05")]`,
      { clock: { timezone: "Asia/Tokyo" } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        "2026-09-05T03:00:00.000Z",
        1788577200000,
        1788577200000,
        1788577200123,
        1788566400000,
        1788602400000,
        1788609600000,
        "NaN",
        1788627600000,
        1788609600000,
        1788602400000,
        1788602400000,
        1788602400000,
        1788609600000,
        1788577200000,
        1788602400000,
        1788602400000,
        "NaN",
        1767225600000,
        1788620400000,
        1788620400000,
        1788602400000,
        1788534000000,
        1788534000000,
        1788577200000,
      ]),
    });
  });

  // Round 14: the text the engine read in the host's zone was recovered from the instant it made,
  // through the host's offset at that instant. The engine builds that instant from the offset at
  // the WALL CLOCK read as UTC (measured), so on a host with a DST gap two wall clocks become one
  // instant (New York, March 8th: 06:30 and 07:30 both land on 11:30Z), and the one the snippet
  // wrote is gone before the shim sees it. The wall clock must come from the text: the engine
  // reads the same text as UTC when it ends in a designator. The host's zone can only be set on a
  // child process, so the vectors run there, on two hosts whose gaps fall on either side of UTC.
  test("an offset-less text is read in TIMEZONE on a host with a DST gap, too", () => {
    const expected = JSON.stringify([
      "2026-03-07T17:30:00.000Z", // 02:30 Tokyo, a New York host's gap (was 18:30Z there)
      "2026-03-07T21:30:00.000Z", // 06:30 Tokyo, inside a New York host's window (was 22:30Z)
      "2026-03-07T17:30:00.000Z", // the slash form, same wall clock
      "2026-03-07T17:30:00.123Z", // ISO with a four-digit fraction: the engine's local ISO form
      "2026-03-07T17:30:00.000Z", // ISO with an expanded year
      "2026-10-31T16:30:00.000Z", // 01:30 Tokyo, a New York host's overlap
      "2026-09-26T16:30:00.000Z", // 01:30 Tokyo, the hour before an Auckland host's gap
      "2026-09-26T17:30:00.000Z", // 02:30 Tokyo, an Auckland host's gap
      "2026-09-05T17:00:00.000Z", // a designated text is the engine's, on any host
      "2026-09-05T03:00:00.123Z", // ISO with a comma fraction: the engine's local ISO form too
      "2026-09-01T03:00:00.000Z", // ISO without a day: the same
      "2026-09-04T15:00:00.000Z", // a dashed date, read local by the engine: the zone's midnight
    ]);
    for (const tz of ["America/New_York", "Pacific/Auckland"]) {
      const child = Bun.spawnSync(
        ["bun", "tests/fixtures/code-sandbox/host-zone.ts"],
        {
          cwd: process.cwd(),
          env: { ...process.env, TZ: tz },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(child.stderr.toString(), tz).toBe("");
      expect(JSON.parse(child.stdout.toString()), tz).toMatchObject({
        kind: "value",
        value: expected,
      });
    }
  }, 30_000);

  // Round 11: the Date shim resolved `String`, `Number`, `Math`, `isNaN`, `Object` when called —
  // after the snippet, whose own top-level `const` had shadowed them. Bound when the shim is
  // installed, like the renderer's and the error reader's.
  test("a snippet that shadows a global still gets the zone", async () => {
    const out = await runSandboxedCode(
      `const String = 0, Number = 0, Math = 0, isNaN = 0, Object = 0;
       [new Date(2026, 0, 15, 7, 30).toISOString(), new Date("2026-01-15T07:30").getDate(),
        new Date(NOW_LOCAL).getHours(), new Date(NOW_LOCAL).toString(),
        typeof Date(), /^[A-Z][a-z]{2} [A-Z][a-z]{2} \\d{2} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT\\+0900$/.test(Date())]`,
      {
        clock: {
          timezone: "Asia/Tokyo",
          now: new Date("2026-01-14T22:30:00Z"),
        },
      },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        "2026-01-14T22:30:00.000Z",
        15,
        7,
        "Thu Jan 15 2026 07:30:00 GMT+0900",
        // Round 12: `Date()` without `new` is the current local date as a string — checked by shape,
        // since two reads of the clock can straddle a second (round 13).
        "string",
        true,
      ]),
    });
  });

  // Round 8, the same century bug seen from inside: year 99 rendered as 1999 with an offset of
  // minus a billion minutes. Reference values from Bun under TZ=America/Sao_Paulo (LMT, −03:06:28).
  // Round 9 added the seconds: local mean time had them (São Paulo −03:06:28, Tokyo +09:18:59),
  // and a minute's rounding put the clock 28 s off Intl's. `getTimezoneOffset` is whole minutes cut
  // toward zero, as the engines do.
  test("a date in the first century is in the zone too, to the second", async () => {
    const probe = `const d = new Date(0); d.setUTCFullYear(99, 5, 15); d.setUTCHours(12, 0, 0, 0);
      const e = new Date(d); e.setHours(8, 53, 32);
      [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(),
       d.getTimezoneOffset(), d.toTimeString(), d.toISOString(), e.toISOString()]`;
    const sp = await runSandboxedCode(probe, {
      clock: { timezone: "America/Sao_Paulo" },
    });
    expect(sp).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        99,
        5,
        15,
        8,
        53,
        32,
        186,
        "08:53:32 GMT-0306",
        "0099-06-15T12:00:00.000Z",
        "0099-06-15T12:00:00.000Z",
      ]),
    });
    const tokyo = await runSandboxedCode(probe, {
      clock: { timezone: "Asia/Tokyo" },
    });
    expect(tokyo).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        99,
        5,
        15,
        21,
        18,
        59,
        -558,
        "21:18:59 GMT+0918",
        "0099-06-15T12:00:00.000Z",
        "0099-06-14T23:34:33.000Z",
      ]),
    });
  });

  // Round 7: the renderer named `Date`, `JSON`, `Object`… as globals, resolved when it ran — after
  // the snippet, whose own `const Date = 1` had shadowed them, so the verdict rendered as
  // "[object Object]". The bindings are taken when the renderer is made, before any snippet.
  test("a snippet that shadows a global by accident still gets its result rendered", async () => {
    const cases: Array<[string, string]> = [
      ["const Date = 1; ({ valid: true })", '{"valid":true}'],
      ["const JSON = null; [1, { a: 2 }]", '[1,{"a":2}]'],
      ["let Object = 0; ({ b: 3 })", '{"b":3}'],
      ["const Array = []; ({ c: [1] })", '{"c":[1]}'],
      ["const String = 0, isFinite = 0; [10n, 1 / 0]", '["10","Infinity"]'],
      [
        "var Map = 5, Set = 6, Error = 7; ({ d: new TypeError('kept') })",
        '{"d":{"name":"TypeError","message":"kept"}}',
      ],
    ];
    for (const [code, want] of cases) {
      const out = await runSandboxedCode(code);
      expect(out, code).toMatchObject({ kind: "value", value: want });
    }
    const logged = await runSandboxedCode(
      "const Date = 1; console.log({ ok: true }); 1",
    );
    expect(logged).toMatchObject({ kind: "value", logs: ['{"ok":true}'] });
  });

  // A positive-offset zone (round 6): the wall clock as UTC is half a day AFTER the instant it
  // names, so reading the offset at it took the far side of every transition. Auckland's spring gap
  // (02:00 → 03:00 on 2025-09-28) and autumn overlap (03:00 → 02:00 on 2025-04-06), through the
  // constructor, parsing and a setter; reference values from Bun under TZ=Pacific/Auckland.
  test("a positive-offset DST zone resolves its gap and overlap the same way", async () => {
    const out = await runSandboxedCode(
      `[new Date(2025, 8, 28, 2, 30).toISOString(),
        new Date(2025, 8, 28, 3, 30).toISOString(),
        new Date(2025, 3, 6, 2, 30).toISOString(),
        Date.parse("2025-04-06T02:30"),
        (() => { const d = new Date("2025-09-27T12:00:00Z"); d.setHours(2, 30); return d.toISOString() })(),
        new Date("2025-09-28T02:30:00Z").getTimezoneOffset(),
        new Date("2025-04-06T02:30:00Z").getTimezoneOffset()]`,
      { clock: { timezone: "Pacific/Auckland" } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        "2025-09-27T14:30:00.000Z",
        "2025-09-27T14:30:00.000Z",
        "2025-04-05T13:30:00.000Z",
        1743859800000,
        "2025-09-27T14:30:00.000Z",
        -780,
        -720,
      ]),
    });
  });

  test("a snippet that throws is ITS error, with the output it produced before", async () => {
    const out = await runSandboxedCode(`console.log("before"); null.x`);
    expect(out).toMatchObject({
      kind: "error",
      name: "TypeError",
      logs: ["before"],
    });
    expect((out as { message: string }).message).toContain("null");
  });

  test("a snippet that does not parse is a SyntaxError, not a sandbox failure", async () => {
    const out = await runSandboxedCode(`const = ;`);
    expect(out).toMatchObject({ kind: "error", name: "SyntaxError" });
  });

  test("an infinite loop is stopped at the deadline, and the main thread never blocked", async () => {
    // The timer is the control for the design: had the interpreter run on this thread, a 50 ms
    // timer could not fire until the loop was interrupted at 300 ms.
    const timerStart = performance.now();
    const timer = new Promise<number>((r) =>
      setTimeout(() => r(performance.now() - timerStart), 50),
    );
    const started = performance.now();
    const out = await runSandboxedCode(`while (true) {}`, { timeoutMs: 300 });
    const elapsed = performance.now() - started;
    expect(out).toMatchObject({ kind: "limit", limit: "time" });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1500);
    expect(await timer).toBeLessThan(200);
  });

  test("catastrophic regex backtracking is interrupted too", async () => {
    const out = await runSandboxedCode(`/(a+)+$/.test("a".repeat(28) + "b")`, {
      timeoutMs: 200,
    });
    expect(out).toMatchObject({ kind: "limit", limit: "time" });
  });

  test("the memory ceiling is the CONFIGURED one, not the interpreter's own heap maximum", async () => {
    // 800k JSValues: fits under the default ceiling (measured) and not under 8 MB. Asserting the pair
    // is what tells "setMemoryLimit is wired" apart from "the WASM heap ran out eventually" — an
    // unbounded push reports "out of memory" either way, just much later and much larger.
    const alloc = `new Array(800000).fill(1).length`;
    expect(await runSandboxedCode(alloc)).toMatchObject({
      kind: "value",
      value: "800000",
    });
    expect(
      await runSandboxedCode(alloc, { memoryBytes: 8 * 1024 * 1024 }),
    ).toMatchObject({ kind: "limit", limit: "memory" });
  });

  test("runaway recursion is refused by the interpreter, and honest recursion is not", async () => {
    // NOTE: The loop in front is the fence. The interrupt handler fires every 10k opcodes, and
    // without work before the recursion the engine's limit tripped before the first one fired deep;
    // with it, the handler is entered near full depth, which is where a budget past the thread's
    // native room turned this reply into `aborted` (round 4 of PR #485: the first form of this test
    // passed at 512 KiB by that phase alone).
    const busy = "for (let i = 0; i < 12000; i++) {}\n";
    const runaway = await runSandboxedCode(
      `${busy}function f(n) { return f(n + 1) }; f(0)`,
    );
    expect(runaway).toMatchObject({ kind: "limit", limit: "stack" });
    // ~1,340 frames fit under SANDBOX_STACK_BYTES; measured, and the constant's comment says so.
    const honest = await runSandboxedCode(
      `${busy}function f(n) { return n === 0 ? 0 : 1 + f(n - 1) }; f(1000)`,
    );
    expect(honest).toMatchObject({ kind: "value", value: "1000" });
    expect(SANDBOX_STACK_BYTES).toBe(256 * 1024);
  });

  // A thread with less native room than the budget assumes (another OS, another Bun) gets the same
  // answer: the RangeError JSC throws through the WASM frames is the stack limit, and nothing in the
  // interpreter is touched after it. 512 KiB is the budget measured to sit past this machine's
  // native room (macOS; ~2,400 frames), so here this is the host path; on a thread with more room
  // it is the engine's own refusal and this proves less. A budget past the WASM shadow stack is a
  // different failure (a trap, `aborted`), so it cannot be forced from further up.
  test("a stack budget the thread cannot honor is still reported as the stack limit", async () => {
    const out = await runSandboxedCode(
      `for (let i = 0; i < 12000; i++) {}\nfunction f(n) { return f(n + 1) }; f(0)`,
      { stackBytes: 512 * 1024 },
    );
    expect(out).toMatchObject({ kind: "limit", limit: "stack" });
    // The unwound runtime is not freed. Freeing it still answers `stack` (the abort is caught), so
    // the outcome cannot tell; the engine's abort goes to the thread's stderr, read from outside.
    const child = Bun.spawnSync(
      ["bun", "tests/fixtures/code-sandbox/host-limit.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(child.stdout.toString()).toContain('"limit":"stack"');
    expect(child.stderr.toString()).not.toContain("Aborted(");
  });

  // The fence: the whole point of an interpreter is what is NOT there. Each name is something a
  // prompt-injected snippet would reach for first, and each must be absent — not throwing, absent.
  test("no ambient authority: nothing from this process is reachable from inside", async () => {
    const names = [
      "fetch",
      "process",
      "require",
      "Bun",
      "setTimeout",
      "setInterval",
      "XMLHttpRequest",
      "WebSocket",
      "postMessage",
      "self",
      "window",
      "document",
      "WebAssembly",
      "Deno",
      "navigator",
    ];
    const out = await runSandboxedCode(
      `[${names.map((n) => `typeof ${n}`).join(",")}].join(",")`,
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify(names.map(() => "undefined").join(",")),
    });
    const globals = await runSandboxedCode(
      `Object.getOwnPropertyNames(globalThis).filter((n) => !/^[A-Z]/.test(n)).sort().join(",")`,
    );
    // Lower-case globals are the ECMAScript functions plus the three things installed on purpose:
    // the console and the two validators. A fourth name here is a new capability, and this line is
    // where it has to be argued for.
    expect((globals as { value: string }).value).toBe(
      JSON.stringify(
        "console,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent,escape,eval,globalThis,isFinite,isNaN,parseFloat,parseInt,undefined,unescape",
      ),
    );
  });

  test("calls are isolated from each other, in sequence and in parallel", async () => {
    await runSandboxedCode(`globalThis.leak = 1`);
    const next = await runSandboxedCode(`typeof leak`);
    expect(next).toMatchObject({ kind: "value", value: '"undefined"' });

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        runSandboxedCode(`globalThis.n = ${i}; n * 10`),
      ),
    );
    expect(results.map((r) => (r as { value: string }).value)).toEqual([
      "10",
      "20",
      "30",
      "40",
      "50",
    ]);
  });

  test("the result and the output are each bounded at the worker, whatever the snippet built", async () => {
    const out = await runSandboxedCode(
      `for (let i = 0; i < 100; i++) console.log("x".repeat(100)); "y".repeat(10000)`,
      { maxChars: 500 },
    );
    expect(out.kind).toBe("value");
    const v = out as { value: string; logs: string[] };
    expect(v.value.length).toBeLessThanOrEqual(500 + "…[truncated]".length);
    expect(v.value.endsWith("…[truncated]")).toBe(true);
    expect(v.logs.join("").length).toBeLessThanOrEqual(600);
  });

  // PR #485, round 2: two more values the snippet controls that reached the host unbounded. An
  // empty `console.log()` spent nothing against the budget, so a loop of them built an array of a
  // million entries on this side of the memory ceiling; and `e.name` is one assignment away from a
  // megabyte, while only the message was clipped.
  // Round 8: a logged string crossed the boundary WHOLE and was cut on the host side — copied out
  // of the interpreter's 32 MB heap into the host's, where nothing bounds it: +75 MB of RSS for one
  // call, +143 MB for eight at once, measured. The console methods now cut inside the VM, and the
  // host reads the length off the VM string without copying and refuses an uncut line with a
  // sentinel; that sentinel is what a host-side cut would leave here.
  // Round 10, the same for the result and for a thrown value: 15 million characters as the last
  // expression added 101 MB of RSS for one call; the renderer and the error reader now cut inside
  // the VM, and the host refuses an uncut string with a sentinel rather than copying it.
  test("a huge result and a huge thrown value are cut before they cross the boundary", async () => {
    const marker = "…[truncated]";
    const result = await runSandboxedCode(`"x".repeat(15_000_000)`);
    const value = (result as { value: string }).value;
    expect(result.kind).toBe("value");
    expect(value.startsWith('"xxx')).toBe(true);
    expect(value.endsWith(marker)).toBe(true);
    expect(value.length).toBe(4000 + marker.length);
    const thrown = await runSandboxedCode(
      `throw new Error("y".repeat(15_000_000))`,
    );
    expect(thrown).toMatchObject({ kind: "error", name: "Error" });
    const message = (thrown as { message: string }).message;
    expect(message.startsWith("yyy")).toBe(true);
    expect(message.endsWith(marker)).toBe(true);
    expect(message.length).toBe(4000 + marker.length);
    // The reader's own bindings are taken before the snippet runs, like the renderer's.
    const shadowed = await runSandboxedCode(
      `const JSON = null, String = 0; throw new TypeError("kept")`,
    );
    expect(shadowed).toMatchObject({
      kind: "error",
      name: "TypeError",
      message: "kept (line 1)",
    });
    const plain = await runSandboxedCode("throw { a: 1 }");
    expect(plain).toMatchObject({
      kind: "error",
      name: "Error",
      message: '{"a":1}',
    });
  });

  test("a huge console line is cut before it crosses the sandbox boundary", async () => {
    const huge = await runSandboxedCode(
      `console.log("x".repeat(15_000_000)); 1`,
    );
    expect(huge).toMatchObject({
      kind: "value",
      logs: [`${"x".repeat(4000)}…[truncated]`],
    });
    // A rendered argument is cut inside too, and the line keeps its marker.
    const rendered = await runSandboxedCode(
      `console.log("y".repeat(10), { k: "z".repeat(9000) }); 1`,
    );
    const line = (rendered as { logs: string[] }).logs[0] ?? "";
    expect(line.startsWith("yyyyyyyyyy {")).toBe(true);
    expect(line.endsWith("…[truncated]")).toBe(true);
    expect(line.length).toBe(4000 + "…[truncated]".length);
  });

  test("empty console calls and a huge error name are bounded like everything else", async () => {
    const empties = await runSandboxedCode(
      `for (let i = 0; i < 1000000; i++) console.log(); "done"`,
      { maxChars: 500, timeoutMs: 3000 },
    );
    expect(empties.kind).toBe("value");
    expect((empties as { logs: string[] }).logs.length).toBeLessThanOrEqual(
      500,
    );

    const named = await runSandboxedCode(
      `const e = new Error("m"); e.name = "x".repeat(100000); throw e`,
    );
    expect(named.kind).toBe("error");
    const n = named as { name: string; message: string };
    expect(n.name.length).toBeLessThanOrEqual(100 + "…[truncated]".length);
    expect(n.message).toContain("m");
    expect(
      formatSandboxResult(
        {
          kind: "error",
          name: "y".repeat(100000),
          message: "m",
          logs: [],
          ms: 1,
        },
        { maxChars: 500 },
      ).length,
    ).toBeLessThan(400);
  });

  // Round 20: a snippet can build a NUL or half a character (`String.fromCharCode(0)`, a lone
  // `\\ud800`), and the strings it leaves in a console line or an error message become the
  // ToolMessage's content, which the checkpoint writes as jsonb — and Postgres refuses a NUL and an
  // unpaired surrogate in jsonb, failing the turn instead of returning the result. Repaired where
  // the strings are made, before they cross the thread boundary, like every other writer here.
  test("a NUL or half a character made by the snippet does not cross the thread boundary", async () => {
    const out = await runSandboxedCode(
      `console.log("a" + String.fromCharCode(0) + "b" + "\\ud800");
       throw new Error("m" + String.fromCharCode(0) + "\\udc00")`,
    );
    expect(out).toMatchObject({
      kind: "error",
      logs: ["ab\uFFFD"],
      message: expect.stringMatching(/^m\uFFFD \(line 2/),
    });
    const text = JSON.stringify(out);
    expect(text.includes("\u0000")).toBe(false);
    expect(replaceLoneSurrogates(text)).toBe(text);
  });

  // Round 21: Intl reports a year BEFORE 1 CE as a year of its era (astronomical −1 is "2 BC"),
  // and the formatter neither asked for the era nor read it, so the wall clock was rebuilt in 2 CE
  // and the offset came out as years — even in UTC. The era is read and folded back into the
  // astronomical year JavaScript's Date counts in; year 0 is 1 BC.
  test("a date before 1 CE is in the zone too, era folded into the astronomical year", async () => {
    const out = await runSandboxedCode(
      `const d = new Date("-000001-01-01T12:00:00Z"); const z = new Date("0000-06-15T12:00:00Z");
       [d.getFullYear(), d.getHours(), d.getMinutes(), d.getSeconds(), z.getFullYear(), z.getMonth(),
        new Date(-1, 0, 1, 21, 18, 59).toISOString()]`,
      { clock: { timezone: "Asia/Tokyo" } },
    );
    // Tokyo's local mean time, +09:18:59, is what Intl answers for that year.
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        -1,
        21,
        18,
        59,
        0,
        5,
        "-000001-01-01T12:00:00.000Z",
      ]),
    });
    expect(
      zoneOffsetSeconds(zoneFormatter("UTC"), Date.UTC(-1, 0, 1, 12)),
    ).toBe(0);
    expect(localIsoNow("UTC", new Date("-000001-01-01T12:00:00Z"))).toBe(
      "-000001-01-01T12:00:00.000+00:00",
    );
  });

  test("a thread that cannot boot is the sandbox's failure, reported as such", async () => {
    const out = await runSandboxedCode(
      "1 + 1",
      { timeoutMs: 300 },
      { workerUrl: fixture("worker-boot-fails.ts") },
    );
    expect(out.kind).toBe("unavailable");
    expect((out as { reason: string }).reason).toContain("boot failed");
  });

  test("a thread that boots and never answers is killed at the deadline, as a time limit", async () => {
    const started = performance.now();
    const out = await runSandboxedCode(
      "1 + 1",
      { timeoutMs: 200 },
      { workerUrl: fixture("worker-hangs.ts") },
    );
    expect(out).toMatchObject({ kind: "limit", limit: "time" });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Round 18: `ready` is posted when the module loads, and the runtime, the context, the renderer
  // and the four preludes are set up on the request, before the snippet runs. A failure there was
  // an uncaught error after `ready`, which the host reads as the snippet's abort — so an install or
  // environment problem told the model to simplify and retry, every turn, instead of reaching the
  // operator as the sandbox being unavailable. Asked of the thread directly, because the host
  // resolves the zone before the request and an unknown one cannot reach the shim through it.
  test("the interpreter failing to set up after the thread is ready is the sandbox's failure, not the snippet's", async () => {
    const worker = new Worker(
      new URL("../../src/graph/tools/code-sandbox.worker.ts", import.meta.url)
        .href,
    );
    const reply = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 5000);
      worker.onmessage = (ev: MessageEvent<{ kind: string }>) => {
        if (ev.data.kind === "ready") {
          worker.postMessage({
            code: "1 + 1",
            timeoutMs: 1000,
            memoryBytes: 32 * 1024 * 1024,
            stackBytes: 256 * 1024,
            maxChars: 4000,
            clock: {
              timezone: "Not/AZone",
              nowLocal: "2026-01-01T00:00:00.000+00:00",
            },
          });
          return;
        }
        clearTimeout(timer);
        resolve(ev.data);
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        resolve({ kind: "uncaught", message: String(e.message) });
      };
    });
    worker.terminate();
    expect(reply).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/Not\/AZone|time zone/i),
    });
  });

  test("a thread that dies after booting is the snippet's abort, not a sandbox failure", async () => {
    const out = await runSandboxedCode(
      "1 + 1",
      { timeoutMs: 300 },
      { workerUrl: fixture("worker-dies.ts") },
    );
    expect(out).toMatchObject({ kind: "limit", limit: "aborted" });
  });
});

// The text the model reads, as a decision table: one row per outcome, and every row that is not a
// value tells the model what to change.
describe("localIsoNow", () => {
  // Round 8: `Date.UTC` reads a year of 0–99 as 1900–1999, so the wall clock of a date in that
  // range was rebuilt nineteen centuries late and the offset came out as sixteen million hours.
  test("a year below 100 keeps its own century", () => {
    const y99 = new Date(0);
    y99.setUTCFullYear(99, 5, 15);
    y99.setUTCHours(12, 0, 0, 0);
    expect(localIsoNow("America/Sao_Paulo", y99)).toBe(
      "0099-06-15T08:53:32.000-03:06",
    );
    expect(localIsoNow("UTC", y99)).toBe("0099-06-15T12:00:00.000+00:00");
  });

  const at = new Date("2026-01-15T01:30:00Z");
  const rows: Array<[string, string]> = [
    ["America/Sao_Paulo", "2026-01-14T22:30:00.000-03:00"],
    ["UTC", "2026-01-15T01:30:00.000+00:00"],
    ["Asia/Kolkata", "2026-01-15T07:00:00.000+05:30"],
    ["Pacific/Kiritimati", "2026-01-15T15:30:00.000+14:00"],
    // A zone Intl does not know falls back to UTC rather than to nothing.
    ["Mars/Olympus", "2026-01-15T01:30:00.000+00:00"],
  ];
  for (const [tz, want] of rows) {
    test(tz, () => expect(localIsoNow(tz, at)).toBe(want));
  }
  test("the string parses back to the instant it was written from", () => {
    for (const [tz] of rows) {
      expect(new Date(localIsoNow(tz, at)).getTime()).toBe(at.getTime());
    }
    // Round 11: with the milliseconds, or the round trip lands up to 999 ms early.
    const withMs = new Date("2026-09-02T22:05:33.412Z");
    expect(localIsoNow("America/Sao_Paulo", withMs)).toBe(
      "2026-09-02T19:05:33.412-03:00",
    );
    expect(new Date(localIsoNow("Asia/Tokyo", withMs)).getTime()).toBe(
      withMs.getTime(),
    );
  });
});

describe("SandboxQueue", () => {
  test("holds a burst to its limit, and every call still runs", async () => {
    // Six busy snippets through a gate of two: three batches of ~200 ms, not one. The elapsed
    // time is the proof the gate exists; the outcomes are the proof nothing was dropped or
    // misreported as the sandbox failing to start, which is what 50-at-once measured with no gate.
    const queue = new SandboxQueue(2);
    const started = performance.now();
    const outs = await Promise.all(
      Array.from({ length: 6 }, () =>
        runSandboxedCode(`while (true) {}`, { timeoutMs: 200 }, { queue }),
      ),
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(600);
    expect(outs.map((o) => o.kind)).toEqual(Array(6).fill("limit"));
    expect(queue.active).toBe(0);
    expect(queue.queued).toBe(0);
  });

  // What the gate has to do with fifty callers is answer all fifty — none dropped, none refused for
  // want of a slot. The DEFAULT deadline is not part of that question, and leaving it in made this
  // an assertion about how fast fifty workers start on the machine at hand: green locally, red on
  // every CI runner for four consecutive commits (#518). A deadline no honest machine can miss
  // keeps the queue as the only thing measured.
  test("a burst of fifty cheap calls all come back as values under the default gate", async () => {
    const outs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runSandboxedCode(`${i} * 2`, { timeoutMs: 30_000 }),
      ),
    );
    expect(outs.map((o) => o.kind)).toEqual(Array(50).fill("value"));
    expect(outs.map((o) => (o as { value: string }).value)).toEqual(
      Array.from({ length: 50 }, (_, i) => String(i * 2)),
    );
    expect(SANDBOX_MAX_CONCURRENCY).toBe(8);
  });

  test("a call that never boots still releases its slot", async () => {
    const queue = new SandboxQueue(1);
    const first = await runSandboxedCode(
      "1",
      { timeoutMs: 200 },
      { queue, workerUrl: fixture("worker-boot-fails.ts") },
    );
    expect(first.kind).toBe("unavailable");
    expect(queue.active).toBe(0);
    const second = await runSandboxedCode("1 + 1", {}, { queue });
    expect(second).toMatchObject({ kind: "value", value: "2" });
  });
});

describe("formatSandboxResult", () => {
  const rows: Array<
    [Exclude<SandboxOutcome, { kind: "unavailable" }>, RegExp[]]
  > = [
    [
      { kind: "value", value: '{"valid":true}', logs: [], ms: 3 },
      [/^Result: \{"valid":true\}$/],
    ],
    [
      { kind: "value", value: "42", logs: ["a", "b"], ms: 3 },
      [/^Output:\na\nb\n\nResult: 42$/],
    ],
    [
      { kind: "error", name: "TypeError", message: "boom", logs: [], ms: 1 },
      [/^Error: TypeError: boom$/],
    ],
    [
      { kind: "limit", limit: "time", logs: [] },
      [new RegExp(`^Execution stopped after ${SANDBOX_TIMEOUT_MS} ms`)],
    ],
    [
      { kind: "limit", limit: "memory", logs: ["partial"] },
      [
        new RegExp(
          `^Execution exceeded the ${SANDBOX_MEMORY_BYTES / (1024 * 1024)} MB`,
        ),
        /\n\nOutput:\npartial$/,
      ],
    ],
    [
      { kind: "limit", limit: "stack", logs: [] },
      [/^Execution overflowed/, /recursion/],
    ],
    [{ kind: "limit", limit: "aborted", logs: [] }, [/^Execution was aborted/]],
  ];
  for (const [outcome, expectations] of rows) {
    test(`${outcome.kind}${"limit" in outcome ? `/${outcome.limit}` : ""}`, () => {
      const text = formatSandboxResult(outcome);
      for (const re of expectations) expect(text).toMatch(re);
    });
  }

  test("clips a value at the model limit, marker included", () => {
    const text = formatSandboxResult(
      { kind: "value", value: "x".repeat(10000), logs: [], ms: 1 },
      { maxChars: 100 },
    );
    expect(text).toBe(`Result: ${"x".repeat(100)}…[truncated]`);
  });

  // PR #485, round 1: a head-first clip over the whole text let 4,000 characters of console output
  // push the `Result:` line off the end, so a snippet that finished correctly handed the model no
  // verdict at all. The tail is the deliverable; the output takes what is left.
  test("console output never pushes the result or the error off the end", () => {
    const logs = Array.from({ length: 100 }, () => "y".repeat(100));
    const ok = formatSandboxResult(
      { kind: "value", value: '{"valid":true}', logs, ms: 1 },
      { maxChars: 500 },
    );
    expect(ok.endsWith('\n\nResult: {"valid":true}')).toBe(true);
    expect(ok.startsWith("Output:\n")).toBe(true);
    expect(ok).toContain("…[output truncated]");
    expect(ok.length).toBeLessThanOrEqual(500);

    const err = formatSandboxResult(
      { kind: "error", name: "TypeError", message: "boom", logs, ms: 1 },
      { maxChars: 500 },
    );
    // A failure leads with its reason: the flow log keeps the first line as the cause.
    expect(err.startsWith("Error: TypeError: boom\n\nOutput:\n")).toBe(true);
    expect(err).toContain("…[output truncated]");
    expect(err.length).toBeLessThanOrEqual(500);

    // Output that FITS is shown whole, and a tail that leaves no room drops the output rather than
    // the tail.
    const fits = formatSandboxResult(
      { kind: "value", value: "1", logs: ["a", "b"], ms: 1 },
      { maxChars: 500 },
    );
    expect(fits).toBe("Output:\na\nb\n\nResult: 1");
    const noRoom = formatSandboxResult(
      { kind: "value", value: "v".repeat(480), logs: ["a"], ms: 1 },
      { maxChars: 500 },
    );
    expect(noRoom).toBe(`Result: ${"v".repeat(480)}`);
  });
});

// The production mode: a code tool's body runs as `function (input, context)` and answers with
// `return`. `input` is what the model passed (validated by the tool's schema), `context` what the
// turn knows; both cross as JSON text and are parsed inside before the body runs.
describe("function-body mode (a code tool's call)", () => {
  const call = (input: unknown, context: unknown = {}) => ({
    call: { input, context },
  });

  test("the return value is the result, and input is the parsed argument object", async () => {
    const out = await runSandboxedCode(
      "return input.a + input.b",
      call({ a: 40, b: 2 }),
    );
    expect(out).toMatchObject({ kind: "value", value: "42" });
  });

  test("input and context arrive whole: nested, unicode, null, a __proto__ key", async () => {
    const input = {
      cpf: "123.516.128-50",
      list: [1, "dois", null, { deep: true }],
      nome: "José 🙂",
      __proto__: { polluted: 1 },
    };
    const context = {
      contact_name: "Maria",
      conversationAttributes: { vip: true },
    };
    const out = await runSandboxedCode(
      "return [JSON.stringify(input), JSON.stringify(context), Object.getPrototypeOf(input) === Object.prototype]",
      call(input, context),
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        JSON.stringify(input),
        JSON.stringify(context),
        true,
      ]),
    });
  });

  test("the helpers, the clock and the zone are there for the body", async () => {
    const out = await runSandboxedCode(
      "const d = String(input.cpf).replace(/\\D/g, ''); return { cpf: d.length === 11, tz: TIMEZONE, offset: new Date(NOW_LOCAL).getTimezoneOffset() }",
      {
        ...call({ cpf: "12351612850" }),
        clock: { timezone: "America/Sao_Paulo" },
      },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: '{"cpf":true,"tz":"America/Sao_Paulo","offset":180}',
    });
  });

  test("a body runs ONCE (no re-evaluation), and one without return answers undefined", async () => {
    const once = await runSandboxedCode(
      'console.log("once"); const x = { a: 1 }; { x }',
      call({}),
    );
    expect(once).toMatchObject({
      kind: "value",
      value: "undefined",
      logs: ["once"],
    });
  });

  test("an error names the body's own line, not the wrapper's", async () => {
    const syntax = await runSandboxedCode(
      "const ok = 1;\nconst x = ;",
      call({}),
    );
    expect(syntax).toMatchObject({ kind: "error", name: "SyntaxError" });
    expect((syntax as { message: string }).message).toMatch(/\(line 2\)$/);
    const thrown = await runSandboxedCode(
      '\n\nthrow new Error("boom")',
      call({}),
    );
    expect(thrown).toMatchObject({ kind: "error", name: "Error" });
    expect((thrown as { message: string }).message).toBe("boom (line 3)");
  });

  test("the body sees input and context as parameters and nothing new on the global object", async () => {
    const out = await runSandboxedCode(
      "return [typeof __INPUT_JSON, typeof __CONTEXT_JSON, typeof __takeArgs, Object.getOwnPropertyNames(globalThis).filter((n) => !/^[A-Z]/.test(n)).sort().join(',')]",
      call({ a: 1 }),
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([
        "undefined",
        "undefined",
        "undefined",
        "console,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent,escape,eval,globalThis,isFinite,isNaN,parseFloat,parseInt,undefined,unescape",
      ]),
    });
  });

  test("the limits classify the same way in this mode", async () => {
    const loop = await runSandboxedCode("while (true) {}", {
      ...call({}),
      timeoutMs: 200,
    });
    expect(loop).toMatchObject({ kind: "limit", limit: "time" });
    const deep = await runSandboxedCode(
      "function f() { return f() } return f()",
      call({}),
    );
    expect(deep).toMatchObject({ kind: "limit", limit: "stack" });
  });

  test("an undefined argument crosses as null rather than as the text 'undefined'", async () => {
    const out = await runSandboxedCode("return [input, context]", {
      call: { input: undefined, context: undefined },
    });
    expect(out).toMatchObject({ kind: "value", value: "[null,null]" });
  });

  // A body that returns a promise did not finish, and there is no event loop here to finish it. The
  // renderer walks the object, finds no own keys, and answers `Result: {}` with `failed: false`, so
  // the agent reads an empty object as the operator's verdict and nobody is alerted -- including
  // when the async body THREW, which came back the same way (round 31, measured on all four).
  test("a returned promise is an error, not an empty object", async () => {
    const bodies = [
      "return Promise.resolve(42);",
      "return (async () => 42)();",
      "return (async () => { throw new Error('boom'); })();",
      // A thenable is what an `await` would have unwrapped, so it is the same mistake wearing a
      // different shape.
      "return { then(r) { r(7); } };",
    ];
    for (const body of bodies) {
      const out = await runSandboxedCode(body, call({}));
      expect([body, (out as { kind: string }).kind]).toEqual([body, "error"]);
      expect([body, (out as { name: string }).name]).toEqual([
        body,
        "TypeError",
      ]);
      expect((out as { message: string }).message).toContain(
        "returned a promise",
      );
    }
  });

  // The control, and it is the one that matters: an ordinary object has to keep rendering. A check
  // that reads `.then` off every result would be answered by refusing every object.
  test("an object that merely HAS keys is still a value", async () => {
    const out = await runSandboxedCode(
      "return { then: 1, valid: true, name: 'Maria' };",
      call({}),
    );
    expect(out).toMatchObject({
      kind: "value",
      value: '{"then":1,"valid":true,"name":"Maria"}',
    });
  });
});
