import { describe, expect, test } from "bun:test";
import { codeOnly } from "@/tests/utils/source-text";

// EVERY MODEL CALL NAMES ITS DEADLINE (issue #819).
//
// `runModelCall` applies a deadline to every call, and one left unnamed gets the agent's
// `modelCallTimeoutMs`. That default keeps a forgotten call bounded; it does not make it right. A
// guardrail on the customer's path given two minutes is as wrong as one given none, just less
// visibly. So every call site under `src/` passes its own `deadlineMs`, and this is where a new one
// that does not fails.

// The argument text of each `runModelCall(...)` call, balanced on parentheses, in comment-free code.
export function runModelCallArgs(src: string): string[] {
  const out: string[] = [];
  const code = codeOnly(src);
  const re = /\brunModelCall(?:<[^>]*>)?\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

async function offenders(): Promise<string[]> {
  const { Glob } = await import("bun");
  const found: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan(".")) {
    // The definition itself, which is where the default lives.
    if (file === "src/graph/model-limit.ts") continue;
    const src = await Bun.file(file).text();
    runModelCallArgs(src).forEach((args, n) => {
      if (!/\bdeadlineMs\b/.test(args)) found.push(`${file} (call ${n + 1})`);
    });
  }
  return found.sort();
}

describe("every runModelCall under src/ names its deadline", () => {
  test("no call site leaves deadlineMs to the default", async () => {
    expect(await offenders()).toEqual([]);
  });

  test("the sweep sees the calls it is about", async () => {
    // Five sites today (#819): if this drops to zero the sweep is looking at nothing.
    let calls = 0;
    const { Glob } = await import("bun");
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (file === "src/graph/model-limit.ts") continue;
      calls += runModelCallArgs(await Bun.file(file).text()).length;
    }
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  test("the predicate reads the arguments, not a comment beside them", () => {
    expect(
      runModelCallArgs(
        "await runModelCall((s) => m.invoke(x, { signal: s }), { deadlineMs: 15_000 });",
      ),
    ).toHaveLength(1);
    const [bare] = runModelCallArgs(
      "await runModelCall(() => m.invoke(x)); // deadlineMs handled elsewhere",
    );
    expect(/\bdeadlineMs\b/.test(bare ?? "")).toBe(false);
    const [nested] = runModelCallArgs(
      "runModelCall<string>(() => f(g(1)), { deadlineMs: D })",
    );
    expect(nested).toContain("deadlineMs");
  });
});
