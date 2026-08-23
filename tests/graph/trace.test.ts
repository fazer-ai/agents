import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  buildPlaygroundTrace,
  collectTraceSources,
  traceGuardrail,
} from "@/graph/trace";

// Pure shaping tests (no DB / no model): a tool-calling turn must produce a tool_call → tool_result
// pair, surface the search_knowledge sources from the ToolMessage artifact, flag errors, exclude the
// final reply, and scrub anything secret-shaped from args/output.

describe("buildPlaygroundTrace", () => {
  test("shapes a search_knowledge call + result with sources, excludes the reply", () => {
    const messages = [
      new HumanMessage("qual o horário?"),
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "search_knowledge", args: { query: "horário" }, id: "c1" },
        ],
      }),
      new ToolMessage({
        content: "[1] (source: FAQ) Abrimos às 9h",
        tool_call_id: "c1",
        name: "search_knowledge",
        artifact: {
          sources: [
            { marker: "[1]", chunkId: "42", kb: "FAQ", title: "Horários" },
          ],
        },
      }),
      new AIMessage("Abrimos às 9h [1]."),
    ];

    const trace = buildPlaygroundTrace(messages);
    expect(trace).toHaveLength(2);

    const call = trace[0];
    expect(call?.type).toBe("tool_call");
    if (call?.type === "tool_call") {
      expect(call.name).toBe("search_knowledge");
      expect((call.args as { query: string }).query).toBe("horário");
    }

    const result = trace[1];
    expect(result?.type).toBe("tool_result");
    if (result?.type === "tool_result") {
      expect(result.isError).toBe(false);
      expect(result.sources?.[0]?.kb).toBe("FAQ");
      expect(result.sources?.[0]?.title).toBe("Horários");
    }

    // The final assistant reply is NOT part of the trace (surfaced separately as `reply`).
    expect(trace.some((e) => e.type === "assistant")).toBe(false);

    const sources = collectTraceSources(trace);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.chunkId).toBe("42");
  });

  test("flags a tool error and redacts secret-shaped values from args + output", () => {
    const messages = [
      new HumanMessage("cobra o cliente"),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "charge_customer",
            args: { amount: 100, api_key: "sk-abcdef0123456789abcd" },
            id: "c2",
          },
        ],
      }),
      new ToolMessage({
        content: "HTTP 401 Authorization: Bearer sk-abcdef0123456789abcd",
        tool_call_id: "c2",
        name: "charge_customer",
        status: "error",
      }),
      new AIMessage("Não consegui concluir a cobrança."),
    ];

    const trace = buildPlaygroundTrace(messages);
    const call = trace.find((e) => e.type === "tool_call");
    const json = JSON.stringify(trace);
    // The raw secret material never appears anywhere in the serialized trace.
    expect(json).not.toContain("sk-abcdef0123456789abcd");
    // The credential-named key is dropped wholesale.
    if (call?.type === "tool_call") {
      expect((call.args as { api_key: string }).api_key).not.toContain("sk-");
    }
    const result = trace.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.isError).toBe(true);
  });

  test("a plain reply with no tool calls yields an empty trace", () => {
    const messages = [new HumanMessage("oi"), new AIMessage("Olá! Tudo bem?")];
    expect(buildPlaygroundTrace(messages)).toHaveLength(0);
  });

  test("restricts to the latest turn (ignores prior history)", () => {
    const messages = [
      new HumanMessage("turno antigo"),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "old_tool", args: {}, id: "old" }],
      }),
      new ToolMessage({
        content: "old",
        tool_call_id: "old",
        name: "old_tool",
      }),
      new AIMessage("resposta antiga"),
      new HumanMessage("turno novo"),
      new AIMessage("resposta nova sem ferramentas"),
    ];
    // Only the latest turn (after the 2nd human message) is considered → no tool entries.
    expect(buildPlaygroundTrace(messages)).toHaveLength(0);
  });

  test("a follow-up turn opens on the injected nudge SystemMessage, not a human", () => {
    const messages = [
      new HumanMessage("oi"),
      new AIMessage("Olá! Como posso ajudar?"),
      // The follow-up injects a system nudge instead of a human message.
      new SystemMessage("An external system event just occurred…"),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "check_status", args: {}, id: "f1" }],
      }),
      new ToolMessage({
        content: "pendente",
        tool_call_id: "f1",
        name: "check_status",
      }),
      new AIMessage("Passando para saber se ainda precisa de algo."),
    ];
    // The turn must start AFTER the nudge — only the follow-up's own tool call/result, never the
    // prior turn's "Olá!" assistant reply.
    const trace = buildPlaygroundTrace(messages);
    expect(trace).toHaveLength(2);
    expect(trace[0]?.type).toBe("tool_call");
    expect(trace.some((e) => e.type === "assistant")).toBe(false);
  });
});

// The guardrail row goes to the same places the rows above do — over REST, into MCP, and into a
// stored transcript — but its text is written by a model that was shown the reply, so the reply's
// own leaks can come back quoted in it. It used to be spread in whole (`{ type, ...report }`),
// which is the one path into the trace that skipped the redaction every other path applies.
describe("traceGuardrail", () => {
  const report = {
    direction: "output" as const,
    outcome: "replaced" as const,
    action: "template" as const,
  };

  test("scrubs a secret the judge quoted back out of the reply", () => {
    const e = traceGuardrail({
      ...report,
      rationale: "a resposta continha a chave sk-abcdefghijklmnopqrstuvwxyz",
    });
    expect(e.rationale).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(e.rationale).toContain("‹redacted›");
  });

  test("scrubs a secret in a category too", () => {
    const e = traceGuardrail({
      ...report,
      categories: ["leaked: sk-abcdefghijklmnopqrstuvwxyz"],
    });
    expect(e.categories?.[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  test("bounds the rationale, which nothing upstream bounds", () => {
    const e = traceGuardrail({ ...report, rationale: "x".repeat(9000) });
    expect((e.rationale as string).length).toBeLessThan(9000);
  });

  test("bounds how many categories and how long each one is", () => {
    const e = traceGuardrail({
      ...report,
      categories: Array.from({ length: 40 }, () => "y".repeat(500)),
    });
    expect(e.categories?.length).toBeLessThan(40);
    for (const c of e.categories ?? []) expect(c.length).toBeLessThan(500);
  });

  test("carries the fields an operator reads, and adds no empty ones", () => {
    const e = traceGuardrail({ direction: "input", outcome: "clean" });
    expect(e).toEqual({
      type: "guardrail",
      direction: "input",
      outcome: "clean",
    });
  });

  test("nothing builds a guardrail row without going through it", () => {
    const src = readFileSync("src/modules/playground/service.ts", "utf8");
    // Both sinks (the turn and the follow-up) call it, and neither spreads the report itself.
    expect(src.match(/traceGuardrail\(r\)/g)?.length).toBe(2);
    expect(src).not.toContain('{ type: "guardrail", ...r }');
  });
});
