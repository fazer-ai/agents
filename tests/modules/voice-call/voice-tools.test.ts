import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  invocationDeadlineFetch,
  withinInvocation,
} from "@/modules/voice-call/invocation-deadline";
import { elevenLabsToolDefs } from "@/modules/voice-call/providers/elevenlabs-tools";
import { toVoiceTools, voiceAgentFrom } from "@/modules/voice-call/tools";

// A tool that failed without throwing (an HTTP 500, a refused contact update) answers a ToolMessage
// marked as an error; on a call it is a failed tool, not a result the agent reads as success.

describe("the agent's tools on a call", () => {
  test("a tool that answers an error is a failure, one that answers a result is not", async () => {
    const failing = tool(
      async () =>
        new ToolMessage({
          content: "HTTP 500",
          tool_call_id: "c1",
          status: "error",
        }),
      { name: "consulta", description: "d", schema: z.object({}) },
    );
    const working = tool(async () => "livre às 10h", {
      name: "agenda",
      description: "d",
      schema: z.object({}),
    });
    const [bad, good] = toVoiceTools([failing, working]);
    await expect(bad?.invoke({}, "c1")).rejects.toThrow("HTTP 500");
    expect(await good?.invoke({}, "c2")).toBe("livre às 10h");
  });
});

describe("a tool whose argument is a union of types", () => {
  test("receives the value, not the JSON text the call carried it as", async () => {
    const seen: unknown[] = [];
    const limited = tool(
      async (input: { limite: number | boolean }) => {
        seen.push(input.limite);
        return "ok";
      },
      {
        name: "buscar",
        description: "d",
        schema: z.object({ limite: z.union([z.number(), z.boolean()]) }),
      },
    );
    const [voice] = toVoiceTools([limited]);
    expect(await voice?.invoke({ limite: "5" }, "c1")).toBe("ok");
    expect(seen).toEqual([5]);
  });
});

describe("a union inside an argument that may be null", () => {
  test("is read back as the declaration carried it", async () => {
    const seen: unknown[] = [];
    const filtered = tool(
      async (input: { filtro: { limite: number | boolean } | null }) => {
        seen.push(input.filtro);
        return "ok";
      },
      {
        name: "listar",
        description: "d",
        schema: z.object({
          filtro: z
            .object({ limite: z.union([z.number(), z.boolean()]) })
            .nullable(),
        }),
      },
    );
    const [voice] = toVoiceTools([filtered]);
    expect(await voice?.invoke({ filtro: { limite: "5" } }, "c1")).toBe("ok");
    expect(seen).toEqual([{ limite: 5 }]);
  });
});

describe("a custom tool named end_call", () => {
  test("is not offered on a call, where the engine's own hang-up has that name", () => {
    const custom = tool(async () => "ok", {
      name: "end_call",
      description: "d",
      schema: z.object({}),
    });
    expect(toVoiceTools([custom])).toEqual([]);
  });
});

// What a tool sends goes under the deadline of the invocation that sent it, whatever kind of tool it
// is: the call already told the model the tool failed once that deadline passed.
describe("a request a call's tool makes", () => {
  const recorder = () => {
    const sent: Array<AbortSignal | null | undefined> = [];
    const inner = (async (_input: unknown, init?: RequestInit) => {
      sent.push(init?.signal);
      return new Response("ok");
    }) as unknown as typeof fetch;
    return { sent, fetch: invocationDeadlineFetch(inner) };
  };

  test("is cancelled with the invocation that made it", async () => {
    const { sent, fetch } = recorder();
    const booking = tool(
      async () => {
        await fetch("https://8.8.8.8/book");
        return "ok";
      },
      { name: "agendar", description: "d", schema: z.object({}) },
    );
    const deadline = new AbortController();
    const [voice] = toVoiceTools([booking]);
    expect(await voice?.invoke({}, "c1", deadline.signal)).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.aborted).toBe(false);
    deadline.abort();
    expect(sent[0]?.aborted).toBe(true);
  });

  test("past the deadline is not sent", async () => {
    const { sent, fetch } = recorder();
    await expect(
      withinInvocation(AbortSignal.abort(), () =>
        fetch("https://8.8.8.8/book"),
      ),
    ).rejects.toThrow("deadline passed before the request was sent");
    expect(sent).toEqual([]);
  });

  test("outside any invocation goes as it was", async () => {
    const { sent, fetch } = recorder();
    await fetch("https://8.8.8.8/book");
    expect(sent).toEqual([undefined]);
  });
});

describe("the prompt a call is given", () => {
  const plain = tool(async () => "ok", {
    name: "agenda",
    description: "d",
    schema: z.object({}),
  });
  const fromServer = Object.assign(
    tool(async () => "ok", {
      name: "mcp__crm__busca",
      description: "d",
      schema: z.object({}),
    }),
    {
      metadata: {
        mcpServer: {
          label: "crm",
          instructions: "Busque pelo CPF antes do nome.",
        },
      },
    },
  );

  test("carries each MCP server's scope and instructions, after the agent's own", () => {
    const agent = voiceAgentFrom("Você é a Raquel.", [plain, fromServer]);
    expect(agent.systemPrompt.startsWith("Você é a Raquel.\n\n")).toBe(true);
    expect(agent.systemPrompt).toContain("### crm");
    expect(agent.systemPrompt).toContain("Busque pelo CPF antes do nome.");
    expect(agent.systemPrompt).toContain("Ferramentas: mcp__crm__busca");
    expect(agent.tools.map((t) => t.name)).toEqual([
      "agenda",
      "mcp__crm__busca",
    ]);
  });

  test("is the agent's own when no MCP tool is given", () => {
    expect(voiceAgentFrom("Você é a Raquel.", [plain]).systemPrompt).toBe(
      "Você é a Raquel.",
    );
  });
});

describe("a tool whose argument may be null", () => {
  test("receives null, which clears where leaving it out keeps", async () => {
    const seen: unknown[] = [];
    const update = tool(
      async (input: { horario: string | null }) => {
        seen.push(input.horario);
        return "ok";
      },
      {
        name: "atualiza",
        description: "d",
        schema: z.object({ horario: z.string().nullable() }),
      },
    );
    const [voice] = toVoiceTools([update]);
    await voice?.invoke({ horario: "null" }, "c1");
    await voice?.invoke({ horario: "comercial" }, "c2");
    expect(seen).toEqual([null, "comercial"]);
  });
});

// An MCP tool may take a dictionary as its whole argument (keys the caller chooses). ElevenLabs takes
// only an object of declared fields, so the dictionary travels as one JSON field and is unwrapped
// before the tool runs.
describe("a tool whose whole argument is a dictionary", () => {
  test("is declared as one JSON field and receives the object it held", async () => {
    const seen: unknown[] = [];
    const free = tool(
      async (input: Record<string, unknown>) => {
        seen.push(input);
        return "ok";
      },
      {
        name: "registrar",
        description: "d",
        schema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
    );
    const [voice] = toVoiceTools([free]);
    const [declared] = elevenLabsToolDefs(voice ? [voice] : []);
    expect(declared?.parameters).toEqual({
      type: "object",
      properties: {
        arguments: {
          type: "string",
          description: "registrar (a JSON value: object)",
        },
      },
      required: ["arguments"],
    });
    expect(
      await voice?.invoke({ arguments: '{"origem":"site","lote":3}' }, "c1"),
    ).toBe("ok");
    expect(seen).toEqual([{ origem: "site", lote: 3 }]);
  });
});
