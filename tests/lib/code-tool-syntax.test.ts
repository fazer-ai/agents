import { describe, expect, test } from "bun:test";
import { runSandboxedCode } from "@/graph/tools/code-sandbox";
import { checkCodeToolSyntax } from "@/lib/code-tool-syntax";

// The console's live warning and the service's save-time warning are this one function, and the
// engine that runs the body at call time is the truth it approximates: the last case proves the
// two agree over the table.
describe("checkCodeToolSyntax", () => {
  const rows: Array<[string, string, unknown[]]> = [
    ["a plain body", "return { valid: input.cpf.length === 11 }", []],
    [
      "a top-level return inside a block",
      "if (input.a) {\n  return 1;\n}\nreturn 2;",
      [],
    ],
    [
      "a syntax error on the first line",
      "const x = ;",
      [{ kind: "syntax", line: 1, column: 10 }],
    ],
    [
      "a syntax error on a later line, reported as the body's own line",
      "const ok = 1;\nconst a = 2;\nconst x = ;",
      [{ kind: "syntax", line: 3, column: 10 }],
    ],
    [
      "an unclosed brace lands on the body's last line, not past it",
      "if (input.a) {\nreturn 1;",
      [{ kind: "syntax", line: 2 }],
    ],
    ["no return at all", "const x = input.a + 1;", [{ kind: "noReturn" }]],
    [
      "a return inside a nested function does not count",
      "function f() { return 1; }\nconst g = () => { return 2; };\nf(); g();",
      [{ kind: "noReturn" }],
    ],
    [
      "a return inside a nested function beside a real one is fine",
      "const f = () => { return 1; };\nreturn f();",
      [],
    ],
    ["an empty body", "", [{ kind: "noReturn" }]],
    [
      "syntax the engine also refuses: await outside async",
      "const r = await input.x;\nreturn r;",
      [{ kind: "syntax", line: 1 }],
    ],
  ];

  for (const [name, code, want] of rows) {
    test(name, async () => {
      const got = await checkCodeToolSyntax(code);
      expect(got.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) {
        expect(got[i]).toMatchObject(want[i] as object);
      }
    });
  }

  test("the message drops acorn's position suffix; the position is in its own fields", async () => {
    const [w] = await checkCodeToolSyntax("const x = ;");
    expect(w).toMatchObject({ kind: "syntax", line: 1, column: 10 });
    expect((w as { message: string }).message).not.toMatch(/\(\d+:\d+\)$/);
    expect((w as { message: string }).message.length).toBeGreaterThan(0);
  });

  // The parse here and the engine at call time must not disagree on what parses: a body the
  // console calls clean that the sandbox refuses would be warned about only in the flow log.
  test("agrees with the sandbox on every row: clean here ⇔ no SyntaxError there", async () => {
    for (const [name, code] of rows) {
      const warnings = await checkCodeToolSyntax(code);
      const cleanHere = !warnings.some((w) => w.kind === "syntax");
      const out = await runSandboxedCode(code, {
        call: { input: { a: 1, cpf: "12351612850", x: 1 }, context: {} },
      });
      const cleanThere = !(out.kind === "error" && out.name === "SyntaxError");
      expect({ name, cleanHere }).toEqual({ name, cleanHere: cleanThere });
    }
  });
});
