import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { loadTokenCounter } from "@/graph/token-count";

describe("loadTokenCounter", () => {
  test("resolves from disk, with no network call", async () => {
    const count = await loadTokenCounter();
    expect(count).not.toBeNull();
  });

  test("a longer message costs more than a shorter one", async () => {
    const count = await loadTokenCounter();
    if (!count) throw new Error("encoding unavailable");
    const short = count(new HumanMessage("oi"));
    const long = count(
      new HumanMessage(
        "Não consegui remarcar a consulta de terça-feira às 08h30. É possível transferir para a próxima semana?",
      ),
    );
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short * 5);
  });

  // The defect this counter exists to avoid: LangChain's own counter reads `msg.content` only, and
  // an assistant message that just calls a tool has EMPTY content with the whole payload in
  // tool_calls. Under that counter the heaviest messages of a tool-driven thread score zero, so the
  // ceiling lets through exactly the threads it was built to bound.
  test("an assistant message that only calls tools is not free", async () => {
    const count = await loadTokenCounter();
    if (!count) throw new Error("encoding unavailable");
    const empty = count(new AIMessage(""));
    const toolCall = count(
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "calendar_create_event",
            args: {
              calendarId: "clinica@example.com",
              summary: "Avaliação - Ana Paula",
              start: "2026-08-18T08:00:00-03:00",
              end: "2026-08-18T08:30:00-03:00",
            },
            id: "call_9f3a2b",
          },
        ],
      }),
    );
    expect(empty).toBeGreaterThan(0); // the per-message envelope
    expect(toolCall).toBeGreaterThan(empty + 20);
  });

  // A customer can type anything, including a tokenizer control marker. js-tiktoken's default is to
  // THROW on one, and the caller treats a throw as "ceiling unavailable" and sends the full history
  // — so the default would hand any customer a one-message switch for turning off the agent's
  // ceiling. The marker has to count as the ordinary characters it is.
  test("a tokenizer control marker in customer text is counted, not thrown on", async () => {
    const count = await loadTokenCounter();
    if (!count) throw new Error("encoding unavailable");
    expect(() =>
      count(new HumanMessage("bom dia <|endoftext|> tudo bem?")),
    ).not.toThrow();
    expect(
      count(new HumanMessage("bom dia <|endoftext|> tudo bem?")),
    ).toBeGreaterThan(count(new HumanMessage("bom dia tudo bem?")));
    // Inside a tool result too, which is the other half of what travels in a history.
    expect(() =>
      count(
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "x", args: { q: "<|fim_prefix|>" }, id: "call_1" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  test("content delivered as text blocks is counted like a string", async () => {
    const count = await loadTokenCounter();
    if (!count) throw new Error("encoding unavailable");
    const asString = count(new AIMessage("bom dia, tudo certo por aqui"));
    const asBlocks = count(
      new AIMessage({
        content: [
          { type: "text", text: "bom dia, " },
          { type: "text", text: "tudo certo por aqui" },
        ],
      }),
    );
    expect(asBlocks).toBe(asString);
  });
});
