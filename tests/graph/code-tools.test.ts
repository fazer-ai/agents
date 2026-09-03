import { describe, expect, test } from "bun:test";
import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  buildCodeTool,
  buildCodeTools,
  type CodeToolDeps,
  runCodeToolDefinition,
} from "@/graph/tools/code";
import {
  CODE_TOOL_CONTEXT_MAX_CHARS,
  CODE_TOOL_INPUT_MAX_CHARS,
} from "@/graph/tools/code-sandbox";

// The operator-authored kind (issue #363): the body is the operator's, the arguments are the
// model's, and a failure of the body is an integration failure the operator hears about.

const VALIDAR_CPF = {
  name: "validar_cpf",
  description: "Valida um CPF informado pelo cliente.",
  inputSchema: {
    cpf: { type: "string", required: true, description: "CPF como escrito" },
  },
  code: "return validateCpf(input.cpf)",
};

type Run = NonNullable<CodeToolDeps["run"]>;

// A sandbox stand-in that records the call and answers what the test says.
function fakeRun(answer: Awaited<ReturnType<Run>>) {
  const calls: Array<{ code: string; opts: unknown }> = [];
  const run = (async (code: string, opts?: unknown) => {
    calls.push({ code, opts });
    return answer;
  }) as unknown as Run;
  return { run, calls };
}

async function callThroughNode(
  tool: ReturnType<typeof buildCodeTool>,
  args: Record<string, unknown>,
): Promise<ToolMessage> {
  const node = new ToolNode([tool]);
  const out = (await node.invoke({
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: tool.name, args }],
      }),
    ],
  })) as { messages: ToolMessage[] };
  return out.messages[0] as ToolMessage;
}

describe("a code tool", () => {
  test("hands the model the verdict the operator's body returned, for the issue's CPF", async () => {
    const tool = buildCodeTool(VALIDAR_CPF);
    expect(String(await tool.invoke({ cpf: "123.516.128-50" }))).toBe(
      'Result: {"valid":true}',
    );
    expect(String(await tool.invoke({ cpf: "123.516.128-51" }))).toBe(
      'Result: {"valid":false}',
    );
  });

  test("its schema is the compact map's AI fields, so a missing required argument is refused before any code runs", async () => {
    const { run, calls } = fakeRun({
      kind: "value",
      value: "1",
      logs: [],
      ms: 1,
    });
    const tool = buildCodeTool(VALIDAR_CPF, { run });
    await expect(tool.invoke({})).rejects.toThrow();
    expect(calls.length).toBe(0);
    expect(tool.description).toBe(VALIDAR_CPF.description);
    expect(tool.name).toBe("validar_cpf");
  });

  test("the body runs in function mode with the model's arguments, the turn's context, the bags read at call time and the agent's zone", async () => {
    const { run, calls } = fakeRun({
      kind: "value",
      value: "1",
      logs: [],
      ms: 1,
    });
    let loads = 0;
    const tool = buildCodeTool(VALIDAR_CPF, {
      run,
      timezone: "Europe/Lisbon",
      context: { conversation_id: "7", contact_name: "Maria" },
      loadState: async () => {
        loads += 1;
        return {
          conversationAttributes: { vip: true },
          contactAttributes: { plano: "ouro" },
        };
      },
    });
    await tool.invoke({ cpf: "1" });
    expect(loads).toBe(1);
    expect(calls[0]?.code).toBe(VALIDAR_CPF.code);
    expect(calls[0]?.opts).toEqual({
      clock: { timezone: "Europe/Lisbon" },
      call: {
        input: { cpf: "1" },
        context: {
          conversation_id: "7",
          contact_name: "Maria",
          conversationAttributes: { vip: true },
          contactAttributes: { plano: "ouro" },
        },
      },
    });
    // No loader (the playground, a test): empty bags, and the default zone.
    const bare = buildCodeTool(VALIDAR_CPF, { run });
    await bare.invoke({ cpf: "1" });
    expect(calls[1]?.opts).toEqual({
      clock: { timezone: "America/Sao_Paulo" },
      call: {
        input: { cpf: "1" },
        context: { conversationAttributes: {}, contactAttributes: {} },
      },
    });
  });

  test("a body that does not parse is the OPERATOR's failure: marked, naming the line, telling the model to answer without it", async () => {
    const tool = buildCodeTool({ ...VALIDAR_CPF, code: "return input.cpf." });
    const answer = await callThroughNode(tool, { cpf: "1" });
    expect(answer.status).toBe("error");
    const text = String(answer.content);
    expect(text.startsWith("validar_cpf failed: Error: SyntaxError:")).toBe(
      true,
    );
    expect(text.split("\n")[0]).toContain("(line 1: return input.cpf.)");
    expect(text).toContain("do not tell the customer their data is invalid");
  });

  test("a body that throws, and one that hits a limit, are failures too, with the console output after the reason", async () => {
    const thrown = await callThroughNode(
      buildCodeTool({
        ...VALIDAR_CPF,
        code: 'console.log("checking"); throw new Error("boom")',
      }),
      { cpf: "1" },
    );
    expect(thrown.status).toBe("error");
    const lines = String(thrown.content).split("\n");
    expect(lines[0]).toMatch(
      /^validar_cpf failed: Error: Error: boom \(line 1/,
    );
    expect(String(thrown.content)).toContain("Output:\nchecking");

    const { run } = fakeRun({ kind: "limit", limit: "time", logs: [] });
    const limited = await callThroughNode(buildCodeTool(VALIDAR_CPF, { run }), {
      cpf: "1",
    });
    expect(limited.status).toBe("error");
    expect(String(limited.content)).toMatch(
      /^validar_cpf failed: Execution stopped after \d+ ms/,
    );
  });

  test("a sandbox that cannot start, and a context that cannot be read, are failures", async () => {
    const { run } = fakeRun({ kind: "unavailable", reason: "no wasm" });
    const down = await callThroughNode(buildCodeTool(VALIDAR_CPF, { run }), {
      cpf: "1",
    });
    expect(down.status).toBe("error");
    expect(String(down.content)).toContain("could not start (no wasm)");

    const ok = fakeRun({ kind: "value", value: "1", logs: [], ms: 1 });
    const unread = await callThroughNode(
      buildCodeTool(VALIDAR_CPF, {
        run: ok.run,
        loadState: async () => {
          throw new Error("db down");
        },
      }),
      { cpf: "1" },
    );
    expect(unread.status).toBe("error");
    expect(String(unread.content)).toContain(
      "conversation context could not be read",
    );
    // The driver's own words stay server-side: this text is posted to the model provider and kept
    // in the flow log, and a Prisma failure carries SQL, a host and sometimes a role.
    expect(String(unread.content)).not.toContain("db down");
    // ...and the caller still gets the reason, which is what the server log records.
    expect(
      await runCodeToolDefinition(
        VALIDAR_CPF,
        { cpf: "1" },
        {
          run: ok.run,
          loadState: async () => {
            throw new Error("db down");
          },
        },
      ),
    ).toMatchObject({ outcome: { kind: "unavailable", reason: "db down" } });
    expect(ok.calls.length).toBe(0);
  });

  test("a context past its cap is a failure, not a truncation: the bags are the tenant's, not the model's", async () => {
    const { run, calls } = fakeRun({
      kind: "value",
      value: "1",
      logs: [],
      ms: 1,
    });
    const answer = await callThroughNode(
      buildCodeTool(VALIDAR_CPF, {
        run,
        loadState: async () => ({
          conversationAttributes: {
            historico: "x".repeat(CODE_TOOL_CONTEXT_MAX_CHARS),
          },
          contactAttributes: {},
        }),
      }),
      { cpf: "1" },
    );
    // Marked, so the operator hears about it, and no thread was spawned to carry it.
    expect(answer.status).toBe("error");
    expect(String(answer.content)).toContain("attributes are too large");
    expect(calls.length).toBe(0);
  });

  test("arguments past the input cap are the MODEL's doing: a normal result saying what to change", async () => {
    const { run, calls } = fakeRun({
      kind: "value",
      value: "1",
      logs: [],
      ms: 1,
    });
    const tool = buildCodeTool(VALIDAR_CPF, { run });
    const answer = await callThroughNode(tool, {
      cpf: "9".repeat(CODE_TOOL_INPUT_MAX_CHARS),
    });
    expect(answer.status).not.toBe("error");
    expect(String(answer.content)).toContain("too large");
    expect(calls.length).toBe(0);
  });

  test("runCodeToolDefinition is the one path: the test endpoint and the turn read the same text", async () => {
    const r = await runCodeToolDefinition(VALIDAR_CPF, { cpf: "12351612850" });
    expect(r).toMatchObject({
      failed: false,
      text: 'Result: {"valid":true}',
      outcome: { kind: "value" },
    });
    expect(
      buildCodeTools([VALIDAR_CPF, { ...VALIDAR_CPF, name: "b" }]).map(
        (t) => t.name,
      ),
    ).toEqual(["validar_cpf", "b"]);
  });
});
