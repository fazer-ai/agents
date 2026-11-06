import { describe, expect, test } from "bun:test";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import {
  conversationDividerMessage,
  conversationStamp,
  humanAgentMessage,
  nudgeMessage,
} from "@/graph/markers";
import { type AgentConfig, customerChoiceCheck } from "@/graph/prepare";
import {
  type ChoiceCheck,
  choiceCheck,
  choiceTranscript,
  judgeChoice,
  literallyChosen,
} from "@/graph/tools/customer-choice";
import { buildDocumentTools } from "@/graph/tools/documents";
import {
  applyToolPreconditions,
  preconditionFlowEvent,
} from "@/graph/tools/precondition";
import {
  invalidToolPreconditions,
  parseAttributePrecondition,
  readToolPreconditions,
  unmetPreconditions,
} from "@/modules/agents/tool-preconditions";
import { parseContactAuthRule } from "@/modules/contact-auth/settings";
import {
  ScriptedCaptureModel,
  UsageReportingModel,
} from "@/tests/utils/scripted-models";

// The guarded effect is a document issued to the customer, which the approval queue then holds as a
// draft nobody chose. A spy that RECORDS the call is what tells "refused" from "ran and answered
// something that reads like a refusal".
function spyDocument(name = "send_orcamento") {
  const calls: unknown[] = [];
  const t = tool(
    async (input: unknown) => {
      calls.push(input);
      return "Documento emitido e anexado.";
    },
    {
      name,
      description: 'Issue a "Orçamento" for exactly what the customer chose.',
      schema: z.object({
        lineItems: z.array(
          z.object({ name: z.string(), unitPrice: z.number() }),
        ),
      }),
    },
  ) as unknown as StructuredToolInterface;
  return { tool: t, calls };
}

const ALL_THREE = {
  lineItems: [
    { name: "Pacote Fisioterapia 8 sessões", unitPrice: 1200 },
    { name: "Pacote Fisioterapia 10 sessões", unitPrice: 1450 },
    { name: "Pacote Fisioterapia 12 sessões", unitPrice: 1680 },
  ],
};
const TEN = {
  lineItems: [{ name: "Pacote Fisioterapia 10 sessões", unitPrice: 1450 }],
};

const noAttributes = async () => ({
  conversationAttributes: {},
  contactAttributes: {},
});

function guarded(
  inner: StructuredToolInterface,
  check: ChoiceCheck | undefined,
  refusals: unknown[] = [],
) {
  return applyToolPreconditions(
    [inner],
    readToolPreconditions({
      toolPreconditions: { [inner.name]: { kind: "customer_choice" } },
    }),
    noAttributes,
    (info) => refusals.push(info),
    undefined,
    undefined,
    undefined,
    check,
  );
}

// A judge on the agent's model, answering what the test says and recording what it was asked.
function judgeAnswering(answer: string) {
  const model = new UsageReportingModel([answer], { input: 120, output: 1 });
  return {
    model,
    check: choiceCheck({
      model: () => model as unknown as BaseChatModel,
      callbacks: () => [],
    }),
  };
}

async function runTurn(
  tools: StructuredToolInterface[],
  history: BaseMessage[],
  args: Record<string, unknown>,
  callbacks: BaseCallbackHandler[] = [],
) {
  const model = new ScriptedCaptureModel([
    { call: "send_orcamento", args },
    { reply: "Qual pacote você prefere?" },
  ]);
  const graph = buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools,
  });
  const out = await graph.invoke(
    { messages: history },
    { configurable: { thread_id: `choice-${Math.random()}` }, callbacks },
  );
  const results = (out.messages as BaseMessage[]).filter(
    (m) => m.getType() === "tool",
  ) as ToolMessage[];
  return { out, results, model };
}

describe("a choice-guarded tool in a real graph turn", () => {
  test("asked for 'the quote' with no option named, the document is not issued and the model is told to ask", async () => {
    const { tool: inner, calls } = spyDocument();
    const { model: judge, check } = judgeAnswering("NO");
    const refusals: unknown[] = [];
    const { results } = await runTurn(
      guarded(inner, check, refusals),
      [
        new HumanMessage(
          "Oi, pode me mandar o orçamento das sessões de fisioterapia em PDF?",
        ),
      ],
      ALL_THREE,
    );
    expect(calls).toEqual([]);
    expect(String(results[0]?.content)).toContain("was not run");
    expect(String(results[0]?.content)).toContain("Ask the customer to choose");
    // NOTE: the judge read the customer's words from the graph state the tool node handed in.
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]).toContain("orçamento das sessões de fisioterapia");
    expect(judge.calls[0]).toContain("8 sessões");
    expect(refusals).toHaveLength(1);
  });

  test("the option in the customer's own words issues it without asking the model", async () => {
    const { tool: inner, calls } = spyDocument();
    const { model: judge, check } = judgeAnswering("NO");
    await runTurn(
      guarded(inner, check),
      [
        new HumanMessage("Quero o orçamento."),
        new AIMessage("Temos 8, 10 ou 12 sessões. Qual prefere?"),
        new HumanMessage(
          "Pacote Fisioterapia 10 sessões, 1450. Pode mandar o PDF.",
        ),
      ],
      TEN,
    );
    expect(calls).toHaveLength(1);
    expect(judge.calls).toEqual([]);
  });

  test("a short answer to the agent's question runs when the judge says YES, and the judge saw the question", async () => {
    const { tool: inner, calls } = spyDocument();
    const { model: judge, check } = judgeAnswering("YES");
    await runTurn(
      guarded(inner, check),
      [
        new HumanMessage("Quero o orçamento da fisioterapia."),
        new AIMessage("Prefere 8, 10 ou 12 sessões?"),
        new HumanMessage("o do meio"),
      ],
      TEN,
    );
    expect(calls).toHaveLength(1);
    expect(judge.calls[0]).toContain("Prefere 8, 10 ou 12 sessões?");
    expect(judge.calls[0]).toContain("- customer: o do meio");
  });

  test("a judge that fails refuses the call (fail closed) and the line says unreadable", async () => {
    const { tool: inner, calls } = spyDocument();
    const refusals: Parameters<typeof preconditionFlowEvent>[0][] = [];
    const check = choiceCheck({
      model: () =>
        ({
          invoke: async () => {
            throw new Error("provider 503");
          },
        }) as unknown as BaseChatModel,
      callbacks: () => [],
    });
    await runTurn(
      guarded(inner, check, refusals),
      [new HumanMessage("manda o orçamento")],
      TEN,
    );
    expect(calls).toEqual([]);
    expect(refusals[0]?.reason).toBe("unreadable");
    const ev = preconditionFlowEvent(
      refusals[0] as Parameters<typeof preconditionFlowEvent>[0],
    );
    expect(ev.level).toBe("warn");
    expect(ev.detail?.preconditionKind).toBe("customer_choice");
  });

  test("with no check wired the rule still refuses", async () => {
    const { tool: inner, calls } = spyDocument();
    await runTurn(
      guarded(inner, undefined),
      [new HumanMessage("Pacote Fisioterapia 10 sessões, 1450")],
      TEN,
    );
    expect(calls).toEqual([]);
  });

  test("the judge's call reaches its own handlers and never the turn's", async () => {
    class Ends extends BaseCallbackHandler {
      name = "ends";
      n = 0;
      override handleLLMEnd() {
        this.n++;
      }
    }
    const turnSide = new Ends();
    const judgeSide = new Ends();
    const { tool: inner } = spyDocument();
    const model = new UsageReportingModel(["YES"]);
    const check = choiceCheck({
      model: () => model as unknown as BaseChatModel,
      callbacks: () => [judgeSide],
    });
    await runTurn(guarded(inner, check), [new HumanMessage("o do meio")], TEN, [
      turnSide,
    ]);
    expect(judgeSide.n).toBe(1);
    expect(turnSide.n).toBe(0);
  });
});

describe("literallyChosen", () => {
  const said = "Quero o PACOTE fisioterapia 10 Sessões! valor 1450";
  test.each([
    ["every value folded and found", said, TEN, true],
    ["one value missing", said, ALL_THREE, false],
    [
      "a boolean leaf goes to the judge",
      said,
      { name: "10 sessoes", urgent: true },
      false,
    ],
    [
      "a null leaf goes to the judge",
      said,
      { name: "10 sessoes", note: null },
      false,
    ],
    ["a partial word is not a match", said, { name: "sess" }, false],
    ["nothing to find is not a pass", said, { name: "  " }, false],
    ["no arguments is not a pass", said, {}, false],
    // A mention is not a choice: each of these names every value and chooses none of them.
    ["a refusal", "não quero o premium", { plan: "premium" }, false],
    [
      "a refusal in English",
      "I do not want premium",
      { plan: "premium" },
      false,
    ],
    [
      "a question about the options",
      "qual a diferença entre o básico e o premium?",
      { plans: ["básico", "premium"] },
      false,
    ],
    [
      "an either-or",
      "o básico ou o premium",
      { plans: ["básico", "premium"] },
      false,
    ],
  ])("%s", (_label, latest, args, expected) => {
    expect(literallyChosen(args, latest)).toBe(expected);
  });
});

describe("choiceTranscript", () => {
  test("the open attendance in order, with the system's own notes and tool chatter left out", () => {
    const t = choiceTranscript([
      conversationDividerMessage(7, "oi, quero um orçamento"),
      nudgeMessage("diretriz do operador", 7),
      humanAgentMessage(7, "palavras do atendente"),
      new AIMessage("8, 10 ou 12?"),
      new AIMessage({
        content: "pensando",
        tool_calls: [{ name: "x", args: {}, id: "c1" }],
      }),
      new HumanMessage("o de 10"),
    ]);
    expect(t).toEqual({
      exchange: [
        { role: "customer", text: "oi, quero um orçamento" },
        { role: "attendant", text: "palavras do atendente" },
        { role: "assistant", text: "8, 10 ou 12?" },
        { role: "customer", text: "o de 10" },
      ],
      latest: "o de 10",
    });
  });

  test("an earlier attendance is cut by its stamp, even with no divider between them", () => {
    const t = choiceTranscript([
      new HumanMessage({
        content: "quero o de 12",
        additional_kwargs: conversationStamp(6),
      }),
      new AIMessage("Feito."),
      new HumanMessage({
        content: "me manda o orçamento",
        additional_kwargs: conversationStamp(7),
      }),
    ]);
    expect(t).toEqual({
      exchange: [{ role: "customer", text: "me manda o orçamento" }],
      latest: "me manda o orçamento",
    });
  });

  test("a call with no graph state has no transcript", () => {
    expect(choiceTranscript(undefined)).toBeNull();
  });
});

describe("what the judge reads", () => {
  test("an answer stays next to its own question after a later exchange", async () => {
    const model = new UsageReportingModel(["YES"]);
    const check = choiceCheck({
      model: () => model as unknown as BaseChatModel,
      callbacks: () => [],
    });
    await check({
      tool: "agendar",
      description: "d",
      args: { pacote: "12 sessões", turno: "manhã" },
      messages: [
        new HumanMessage("quero agendar"),
        new AIMessage("10 ou 12 sessões?"),
        new HumanMessage("o segundo"),
        new AIMessage("manhã ou tarde?"),
        new HumanMessage("o primeiro"),
      ],
    });
    expect(model.calls[0]).toContain(
      "- assistant: 10 ou 12 sessões?\n- customer: o segundo\n- assistant: manhã ou tarde?\n- customer: o primeiro",
    );
  });

  test("a value only an earlier message named goes to the judge, which may know it was dropped", async () => {
    const model = new UsageReportingModel(["NO"]);
    const check = choiceCheck({
      model: () => model as unknown as BaseChatModel,
      callbacks: () => [],
    });
    const verdict = await check({
      tool: "x",
      description: "d",
      args: { plan: "premium" },
      messages: [
        new HumanMessage("quero o premium"),
        new AIMessage("Certo."),
        new HumanMessage("pensando melhor, deixa pra lá"),
      ],
    });
    expect(model.calls).toHaveLength(1);
    expect(verdict).toEqual({ chosen: false, reason: "unmet" });
  });
});

describe("the judge is told the business's date", () => {
  test("in the agent's timezone, with the weekday, so a weekday the customer said can be read against a date", async () => {
    const model = new UsageReportingModel(["YES"]);
    const check = choiceCheck({
      model: () => model as unknown as BaseChatModel,
      callbacks: () => [],
      timezone: "America/Sao_Paulo",
      // 02:00 UTC on the 6th is still the 5th in São Paulo.
      now: () => new Date("2026-11-06T02:00:00Z"),
    });
    await check({
      tool: "agendar",
      description: "d",
      args: { data: "2026-11-10" },
      messages: [new HumanMessage("terça às 8h")],
    });
    expect(model.calls[0]).toContain("Today is 2026-11-05 (Thursday).");
  });
});

describe("judgeChoice reads only a YES as yes", () => {
  test.each([
    ["YES", true],
    ["yes.", true],
    ["**YES**", true],
    ["NO", false],
    ["", false],
    ["Yesterday the customer said", false],
    ["I cannot tell; NO", false],
  ])("%p", async (answer, expected) => {
    const model = new UsageReportingModel([answer]);
    expect(
      await judgeChoice(model as unknown as BaseChatModel, "input", []),
    ).toBe(expected);
  });
});

describe("the customer_choice kind at the boundaries", () => {
  test("the reader and the write boundary accept it, alone and in a list", () => {
    const settings = {
      toolPreconditions: {
        send_orcamento: { kind: "customer_choice" },
        agendar: [
          { kind: "attribute", scope: "contact", key: "cpf" },
          { kind: "customer_choice" },
        ],
      },
    };
    expect(invalidToolPreconditions(settings)).toEqual([]);
    expect(readToolPreconditions(settings)).toEqual({
      send_orcamento: [{ kind: "customer_choice" }],
      agendar: [
        { kind: "attribute", scope: "contact", key: "cpf" },
        { kind: "customer_choice" },
      ],
    });
  });

  test("where only attributes are read (a rule's action), the choice is unmet", () => {
    expect(
      unmetPreconditions([{ kind: "customer_choice" }], {
        conversationAttributes: {},
        contactAttributes: {},
      }),
    ).toEqual([{ kind: "customer_choice" }]);
  });

  test("the contact-authorization rule does not take it", () => {
    expect(parseAttributePrecondition({ kind: "customer_choice" })).toBeNull();
    expect(parseContactAuthRule({ kind: "customer_choice" })).toBeNull();
  });
});

describe("the judge a toolset builds", () => {
  test("runs on the agent's own model and key, pinned, and bills its own ledger node", async () => {
    const built: unknown[] = [];
    const rows: { node: string | null; model: string; promptTokens: number }[] =
      [];
    const check = customerChoiceCheck(
      {
        agentId: 5n,
        mc: { provider: "openai", model: "gpt-5.4-mini", temperature: 0.7 },
        apiKey: "sk-agent",
        credentialBaseUrl: null,
        conversationDbId: null,
        inboxDbId: null,
      } as unknown as AgentConfig,
      { tenantId: 1n, threadId: "t-1", base: undefined } as never,
      {
        flow: { tenantId: 1n, turnId: "turn-1", source: "inbox" },
        makeModel: (mc: unknown) => {
          built.push(mc);
          return new UsageReportingModel(["YES"], {
            input: 90,
            output: 1,
          }) as unknown as BaseChatModel;
        },
        persistUsage: async (row: (typeof rows)[number]) => {
          rows.push(row);
        },
      } as never,
    );
    const verdict = await check({
      tool: "send_orcamento",
      description: "d",
      args: TEN,
      messages: [new HumanMessage("o do meio")],
    });
    expect(verdict).toEqual({ chosen: true, by: "judge" });
    expect(built).toEqual([
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        apiKey: "sk-agent",
        baseURL: undefined,
        temperature: 0,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.node).toBe("choice_check");
    expect(rows[0]?.model).toBe("gpt-5.4-mini");
    expect(rows[0]?.promptTokens).toBe(90);
  });

  // An `openai-compatible` endpoint may run keyless, so no key is not the guard's reason to refuse:
  // the factory decides, and a factory that cannot build refuses.
  test.each([
    ["builds", true],
    ["throws", false],
  ])("an agent with no key asks the factory, which %s", async (_l, builds) => {
    let built = 0;
    const check = customerChoiceCheck(
      {
        agentId: 5n,
        mc: { provider: "openai-compatible", model: "local" },
        apiKey: "",
        credentialBaseUrl: "http://llm.internal/v1",
      } as unknown as AgentConfig,
      { tenantId: 1n, threadId: "t-1" } as never,
      {
        makeModel: () => {
          built++;
          if (!builds) throw new Error("not runnable");
          return new UsageReportingModel(["YES"]) as unknown as BaseChatModel;
        },
      } as never,
    );
    const verdict = await check({
      tool: "x",
      description: "d",
      args: TEN,
      messages: [new HumanMessage("o do meio")],
    });
    expect(built).toBe(1);
    expect(verdict.chosen).toBe(builds);
  });
});

describe("the document tool's own sentence", () => {
  test("says every line is summed into one total and that unchosen alternatives are not listed", () => {
    const [doc] = buildDocumentTools(
      [
        {
          templateId: 1n,
          name: "Orçamento",
          slug: "orcamento",
          description: null,
          fields: [],
        },
      ] as never,
      { tenantId: 1n, simulate: true } as never,
    );
    const d = doc?.description ?? "";
    expect(d).toContain("for exactly what the customer chose");
    expect(d).toContain("Every line is summed into one total");
    expect(d).toContain("never list alternatives the customer has not chosen");
    expect(d).toContain("ask in text and call this after they answer");
  });
});
