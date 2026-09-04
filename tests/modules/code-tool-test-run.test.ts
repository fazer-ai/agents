import { describe, expect, test } from "bun:test";
import { SANDBOX_CODE_MAX_CHARS } from "@/graph/tools/code-sandbox";
import { AppError } from "@/lib/errors";
import { runCodeToolTest } from "@/modules/code-tools/test-run";

// The console's "Test" button (POST /v1/code-tools/test): an UNSAVED body, run through the same
// path a turn uses. It adds no capability — whoever reaches it can save the body and call it from
// the playground — so what it owes is the same ANSWERS: the same refusals a save gives, and the
// same text the model would read.

const DEF = {
  name: "validar_cpf",
  inputSchema: { cpf: { type: "string", required: true } },
  code: "const d = String(input.cpf).replace(/\\D/g, ''); const dv = (n) => { let s = 0; for (let i = 0; i < n - 1; i++) s += Number(d[i]) * (n - i); return ((s * 10) % 11) % 10; }; return { valid: d.length === 11 && dv(10) === Number(d[9]) && dv(11) === Number(d[10]) };",
};

async function refusal(p: Promise<unknown>): Promise<AppError | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e : null),
  );
}

describe("the code tool's test run", () => {
  // Round 24: the route declares `inputSchema` as `t.Unknown` (round 18, so a reserved key survives
  // to be refused by name rather than dropped by `t.Record`), and `parseToolInputSchema` is
  // tolerant by design — it is fed rows written by older builds. Between the two, a non-record
  // schema reached the sandbox as an EMPTY one, and the damage was not that the test "accepted"
  // it: the declared arguments were silently dropped, so the body ran with `input` empty and the
  // operator read a green Result for a call that never carried their argument, then hit the
  // service's `z.record` on save. The endpoint owes the same refusals a save gives.
  test("a schema that is not a field map is refused, the way a save refuses it", async () => {
    for (const inputSchema of [null, [1, 2], "cpf", 7] as unknown[]) {
      const e = await refusal(
        runCodeToolTest({
          definition: { ...DEF, inputSchema: inputSchema as never },
          args: { cpf: "123.516.128-50" },
        }),
      );
      expect({ inputSchema, status: e?.statusCode, field: e?.field }).toEqual({
        inputSchema,
        status: 422,
        field: "inputSchema",
      });
    }
  });

  // ...and the shape a save ACCEPTS still runs, including the absent one.
  test("an absent schema still runs, with no arguments", async () => {
    const r = await runCodeToolTest({
      definition: {
        ...DEF,
        inputSchema: undefined,
        code: "return { got: input };",
      },
      args: { cpf: "x" },
    });
    expect(r).toMatchObject({ failed: false, text: 'Result: {"got":{}}' });
  });

  test("answers with the text a turn would read, and the body's warnings", async () => {
    const r = await runCodeToolTest({
      definition: DEF,
      args: { cpf: "123.516.128-50" },
    });
    expect(r).toMatchObject({ failed: false, text: 'Result: {"valid":true}' });
    expect(r.warnings).toEqual([]);
  });

  test("refuses what a save refuses: the arguments, the size, and a reserved field name", async () => {
    const badArgs = await refusal(
      runCodeToolTest({ definition: DEF, args: {} }),
    );
    expect([badArgs?.statusCode, badArgs?.field]).toEqual([422, "args"]);

    const tooLong = await refusal(
      runCodeToolTest({
        definition: { ...DEF, code: "a".repeat(SANDBOX_CODE_MAX_CHARS + 1) },
      }),
    );
    expect([tooLong?.statusCode, tooLong?.field]).toEqual([422, "code"]);

    // `parseToolInputSchema` would drop this field, so the run would answer "fine" about a tool
    // whose declared argument the model can never send — while create and update refuse it.
    const reserved = await refusal(
      runCodeToolTest({
        definition: {
          ...DEF,
          inputSchema: JSON.parse('{"__proto__":{"type":"string"}}'),
        },
      }),
    );
    expect([reserved?.statusCode, reserved?.field]).toEqual([
      422,
      "inputSchema",
    ]);
  });

  test("a body that does not parse fails the way a turn's call fails, and says which line", async () => {
    const r = await runCodeToolTest({
      definition: { ...DEF, code: "return input.cpf." },
      args: { cpf: "1" },
    });
    expect(r.failed).toBe(true);
    expect(r.text).toContain("(line 1)");
    expect(r.warnings[0]).toMatchObject({ kind: "syntax", line: 1 });
  });
});
