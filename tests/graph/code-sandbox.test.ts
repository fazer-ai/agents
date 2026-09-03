import { describe, expect, test } from "bun:test";
import {
  formatSandboxResult,
  runSandboxedCode,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_STACK_BYTES,
  SANDBOX_TIMEOUT_MS,
  type SandboxOutcome,
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
    ];
    for (const [code, want] of cases) {
      const out = await runSandboxedCode(code);
      expect(out, code).toMatchObject({ kind: "value", value: want });
    }
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
    const runaway = await runSandboxedCode(
      `function f(n) { return f(n + 1) }; f(0)`,
    );
    expect(runaway).toMatchObject({ kind: "limit", limit: "stack" });
    // ~2000 frames fit under SANDBOX_STACK_BYTES; measured, and the constant's comment says so.
    const honest = await runSandboxedCode(
      `function f(n) { return n === 0 ? 0 : 1 + f(n - 1) }; f(1500)`,
    );
    expect(honest).toMatchObject({ kind: "value", value: "1500" });
    expect(SANDBOX_STACK_BYTES).toBe(512 * 1024);
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

  test("clips at the model limit, marker included", () => {
    const text = formatSandboxResult(
      { kind: "value", value: "x".repeat(10000), logs: [], ms: 1 },
      { maxChars: 100 },
    );
    expect(text.length).toBe(100 + "…[truncated]".length);
    expect(text.endsWith("…[truncated]")).toBe(true);
  });
});
