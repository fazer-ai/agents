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

  // Measured live (PR #485, round 4): `…; { day, days }` at the end is a block to the parser, and
  // 2 of 3 date answers went wrong through it — one returned the last name's value and the model
  // narrated a date that was never computed, the other cost three SyntaxError round trips.
  test("an object literal at the end is the result, not a block", async () => {
    const cases: Array<[string, string]> = [
      ["const d = 8; { day: d, ok: true }", '{"day":8,"ok":true}'],
      ["const a = 1, b = 2; { a, b }", '{"a":1,"b":2}'],
      [
        "const a = 1;\n{ a, nested: { b: [1, 2] } };",
        '{"a":1,"nested":{"b":[1,2]}}',
      ],
      ["({ a: 1 })", '{"a":1}'],
      // After a block: the shape measured live once the model guards a month roll-over first.
      ["let y = 0; if (true) { y = 1 } { y, ok: true }", '{"y":1,"ok":true}'],
      // No semicolons at all (round 6): with only the parenthesis added, the object read on as a
      // call of the previous line — `compute()({…})` — and failed at run time, past the fallback.
      [
        "function compute() { return { valid: true } }\nconst result = compute()\n{ valid: result.valid }",
        '{"valid":true}',
      ],
      ["const a = { b: 1 }\n{ a }", '{"a":{"b":1}}'],
      // Round 7: what is not syntax must not move the cut — a comment after the object, a "}" in
      // a string or a regex, a template with a hole — and a block keyword before it is a block.
      [
        'const valid = true; { valid, reason: "ok" } // verdict',
        '{"valid":true,"reason":"ok"}',
      ],
      ['({ reason: "a } b" })', '{"reason":"a } b"}'],
      ['const r = /}/; { ok: r.test("}") }', '{"ok":true}'],
      ['const p = /{/; { ok: p.test("{") }', '{"ok":true}'],
      ["const s = '{'; { s }", '{"s":"{"}'],
      // Split so the lint does not read the snippet's template hole as this file's.
      [`const t = \`}$${"{'}'}"}\`; { t }`, '{"t":"}}"}'],
      ["/* c */ { a: 1 } /* d */", '{"a":1}'],
      ["let z = 2; if (false) {} else { z = 3 }", "3"],
      // A block after `else`, even across a line break, even when it would parse as an object.
      ["let q = 0; if (false) {} else\n{ q: 1 }", "1"],
      ["const u = 'x'; { u }; // done", '{"u":"x"}'],
      // Not an object: a real block, and braces that belong to a statement, run as written.
      ["{ let x = 1; x + 1 }", "2"],
      ["if (true) { 5 }", "5"],
      ["function f() { return 3 }\nf()", "3"],
      ["let n = 0; for (const i of [1, 2]) { n += i }", "3"],
    ];
    for (const [code, want] of cases) {
      const out = await runSandboxedCode(code);
      expect(out, code).toMatchObject({ kind: "value", value: want });
    }
    // A runtime error with the parentheses on is the snippet's error once, not twice.
    const thrown = await runSandboxedCode(
      "let calls = 0; function g() { calls++; throw new Error('boom ' + calls) }\n{ v: g() }",
    );
    expect(thrown).toMatchObject({
      kind: "error",
      message: expect.stringContaining("boom 1"),
    });
  });

  test("a top-level `return` is accepted as a function body", async () => {
    const out = await runSandboxedCode(
      `const v = 2 * 21;\nreturn { answer: v };`,
    );
    expect(out).toMatchObject({ kind: "value", value: '{"answer":42}' });
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

  // The two helpers, against published vectors: the issue's CPF, the classic numeric CNPJ, and the
  // alphanumeric CNPJ example from the Receita Federal technical note (check digits 35).
  test("validateCpf and validateCnpj are there, and answer the published vectors", async () => {
    const cases: Array<[string, string]> = [
      ['validateCpf("12351612850")', '{"valid":true}'],
      ['validateCpf("123.516.128-50")', '{"valid":true}'],
      ['validateCpf("12351612851")', '{"valid":false}'],
      ['validateCpf("11111111111")', '{"valid":false}'],
      ['validateCpf("1235161285")', '{"valid":false}'],
      ["validateCpf(12351612850)", '{"valid":true}'],
      ["validateCpf(null)", '{"valid":false}'],
      ['validateCnpj("11.222.333/0001-81")', '{"valid":true}'],
      ['validateCnpj("11222333000181")', '{"valid":true}'],
      ['validateCnpj("11222333000182")', '{"valid":false}'],
      ['validateCnpj("12.ABC.345/01DE-35")', '{"valid":true}'],
      ['validateCnpj("12.abc.345/01de-35")', '{"valid":true}'],
      ['validateCnpj("12.ABC.345/01DE-36")', '{"valid":false}'],
      ['validateCnpj("12.ABC.345/01DE-3A")', '{"valid":false}'],
      ['validateCnpj("00000000000000")', '{"valid":false}'],
    ];
    for (const [code, want] of cases) {
      expect(await runSandboxedCode(code), code).toMatchObject({
        kind: "value",
        value: want,
      });
    }
  });

  test("a SyntaxError names the line and shows it", async () => {
    const out = await runSandboxedCode(`const a = 1;\nconst b = ;\na + b`);
    expect(out).toMatchObject({ kind: "error", name: "SyntaxError" });
    expect((out as { message: string }).message).toContain(
      "(line 2: const b = ;)",
    );
    // Through the function-body retry the line is still the snippet's own.
    const wrapped = await runSandboxedCode(`return 1;\nconst c = ;`);
    expect((wrapped as { message: string }).message).toContain(
      "(line 2: const c = ;)",
    );
  });

  test("a runtime error names its line too", async () => {
    const out = await runSandboxedCode(`const a = 1;\nconst b = null;\nb.x`);
    expect(out).toMatchObject({ kind: "error", name: "TypeError" });
    expect((out as { message: string }).message).toContain("(line 3: b.x)");
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

  // The value path is the one that DOES get a fresh deadline: rendering runs interpreter code, and
  // a snippet that spends its budget building a large value would otherwise have the render
  // interrupted and come back as "[object Object]". Sized from a measurement: 60k objects build in
  // ~20 ms and render in ~80 ms, so 250 ms of the 300 ms spent first leaves the render no room.
  test("a value built with the last of the budget is still rendered whole", async () => {
    const out = await runSandboxedCode(
      `const t = Date.now(); while (Date.now() - t < 250) {}\nArray.from({ length: 60000 }, (_, i) => ({ i }))`,
      { timeoutMs: 300, maxChars: 2_000_000 },
    );
    expect(out.kind).toBe("value");
    const v = (out as { value: string }).value;
    expect(v.startsWith('[{"i":0},{"i":1}')).toBe(true);
    expect(v.endsWith('{"i":59999}]')).toBe(true);
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
        "2026-01-14T22:30:00-03:00",
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
        Date.parse("2026-09-05"), Date.parse("2026-09-05T12:00:00+02:00"),
        Date.parse("Sat, 05 Sep 2026 12:00:00 GMT"), String(Date.parse("not a date"))]`,
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
      ]),
    });
  });

  // Round 8, the same century bug seen from inside: year 99 rendered as 1999 with an offset of
  // minus a billion minutes. Reference values from Bun under TZ=America/Sao_Paulo (LMT, −03:06:28).
  test("a date in the first century is in the zone too", async () => {
    const out = await runSandboxedCode(
      `const d = new Date(0); d.setUTCFullYear(99, 5, 15); d.setUTCHours(12, 0, 0, 0);
       [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getTimezoneOffset(), d.toISOString()]`,
      { clock: { timezone: "America/Sao_Paulo" } },
    );
    expect(out).toMatchObject({
      kind: "value",
      value: JSON.stringify([99, 5, 15, 8, 186, "0099-06-15T12:00:00.000Z"]),
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
        "console,decodeURI,decodeURIComponent,encodeURI,encodeURIComponent,escape,eval,globalThis,isFinite,isNaN,parseFloat,parseInt,undefined,unescape,validateCnpj,validateCpf",
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
      "0099-06-15T08:53:32-03:06",
    );
    expect(localIsoNow("UTC", y99)).toBe("0099-06-15T12:00:00+00:00");
  });

  const at = new Date("2026-01-15T01:30:00Z");
  const rows: Array<[string, string]> = [
    ["America/Sao_Paulo", "2026-01-14T22:30:00-03:00"],
    ["UTC", "2026-01-15T01:30:00+00:00"],
    ["Asia/Kolkata", "2026-01-15T07:00:00+05:30"],
    ["Pacific/Kiritimati", "2026-01-15T15:30:00+14:00"],
    // A zone Intl does not know falls back to UTC rather than to nothing.
    ["Mars/Olympus", "2026-01-15T01:30:00+00:00"],
  ];
  for (const [tz, want] of rows) {
    test(tz, () => expect(localIsoNow(tz, at)).toBe(want));
  }
  test("the string parses back to the instant it was written from", () => {
    for (const [tz] of rows) {
      expect(new Date(localIsoNow(tz, at)).getTime()).toBe(at.getTime());
    }
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

  test("a burst of fifty cheap calls all come back as values under the default gate", async () => {
    const outs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => runSandboxedCode(`${i} * 2`)),
    );
    expect(outs.map((o) => o.kind)).toEqual(Array(50).fill("value"));
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
      [/^Error: TypeError: boom/, /call run_code again/],
    ],
    [
      { kind: "limit", limit: "time", logs: [] },
      [
        new RegExp(`stopped after ${SANDBOX_TIMEOUT_MS} ms`),
        /call run_code again/,
      ],
    ],
    [
      { kind: "limit", limit: "memory", logs: ["partial"] },
      [
        /^Output:\npartial/,
        new RegExp(`${SANDBOX_MEMORY_BYTES / (1024 * 1024)} MB`),
      ],
    ],
    [{ kind: "limit", limit: "stack", logs: [] }, [/recursion/, /iteratively/]],
    [{ kind: "limit", limit: "aborted", logs: [] }, [/aborted/, /Simplify/]],
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
    expect(err).toMatch(
      /Error: TypeError: boom\nThe code did not finish\. Fix it and call run_code again\.$/,
    );
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
