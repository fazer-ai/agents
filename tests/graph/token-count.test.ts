import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { datedHistory } from "@/graph/history-dates";
import { selectHistoryWindow } from "@/graph/history-window";
import { sentAtStamp } from "@/graph/markers";
import { countMessageTokens, memoizedTokenCounter } from "@/graph/token-count";
import { estimateTokens } from "@/lib/token-estimate";

describe("countMessageTokens", () => {
  test("a longer message costs more than a shorter one", () => {
    const short = countMessageTokens(new HumanMessage("oi"));
    const long = countMessageTokens(
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
  test("an assistant message that only calls tools is not free", () => {
    const empty = countMessageTokens(new AIMessage(""));
    const toolCall = countMessageTokens(
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

  test("content delivered as text blocks is counted like a string", () => {
    const asString = countMessageTokens(
      new AIMessage("bom dia, tudo certo por aqui"),
    );
    const asBlocks = countMessageTokens(
      new AIMessage({
        content: [
          { type: "text", text: "bom dia, " },
          { type: "text", text: "tudo certo por aqui" },
        ],
      }),
    );
    expect(asBlocks).toBe(asString);
  });

  // A customer can type anything, including a tokenizer control marker. A real BPE tokenizer THROWS
  // on one by default, and the caller reads a throw as "no ceiling available" and sends the whole
  // history — which would hand any customer a one-message switch for turning the ceiling off. The
  // marker has to count as the ordinary characters it is, whatever the estimator underneath.
  test("a tokenizer control marker in customer text is counted, not thrown on", () => {
    const withMarker = "bom dia <|endoftext|> tudo bem?";
    expect(() =>
      countMessageTokens(new HumanMessage(withMarker)),
    ).not.toThrow();
    expect(countMessageTokens(new HumanMessage(withMarker))).toBeGreaterThan(
      countMessageTokens(new HumanMessage("bom dia tudo bem?")),
    );
    expect(() =>
      countMessageTokens(
        new AIMessage({
          content: "",
          tool_calls: [
            { name: "x", args: { q: "<|fim_prefix|>" }, id: "call_1" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  // The estimate is deliberately not exact (see the module header), but it has to stay in the right
  // ballpark: a message of a few dozen words must not read as a handful of tokens, or the ceiling
  // would be off by an order of magnitude rather than by the measured ~17%.
  test("the estimate stays within a sane band of the real count", () => {
    const text =
      "Perfeito, Ana! Consegui três horários para a avaliação: terça-feira 18/08 às 08:00, 08:30 e 09:00. A consulta custa R$ 250,00 e o pagamento pode ser feito via PIX ou cartão em até 3x sem juros.";
    // 63 tokens under o200k_base, measured with js-tiktoken while choosing this estimator.
    const real = 63;
    const got = countMessageTokens(new HumanMessage(text));
    expect(got).toBeGreaterThan(real * 0.7);
    expect(got).toBeLessThan(real * 1.3);
  });
});

// The history ceiling counts the whole thread on every model call, and each turn loads the thread
// from the checkpoint as new objects. What is estimated per call has to be what is new, not the
// whole history.
describe("memoizedTokenCounter", () => {
  function thread(turns: number): BaseMessage[] {
    const t0 = Date.parse("2026-11-01T12:00:00Z");
    return Array.from({ length: turns }, (_, t) => [
      new HumanMessage({
        id: `h${t}`,
        content: `mensagem ${t} `.repeat(8),
        additional_kwargs: sentAtStamp(new Date(t0 + t * 60_000)),
      }),
      new AIMessage({
        id: `a${t}`,
        content: "",
        tool_calls: [{ id: `c${t}`, name: "search_kb", args: { q: `q${t}` } }],
      }),
      new ToolMessage({
        id: `t${t}`,
        tool_call_id: `c${t}`,
        content: `resultado ${t} `.repeat(60),
      }),
    ]).flat();
  }

  function counting() {
    const seen: string[] = [];
    const count = memoizedTokenCounter((text) => {
      seen.push(text);
      return estimateTokens(text);
    });
    return { count, seen };
  }

  test("a call on a longer history estimates only the messages it has not seen", () => {
    const { count, seen } = counting();
    const window = (h: BaseMessage[]) =>
      selectHistoryWindow(h, 1_000_000, (m) =>
        count(datedHistory([m], "America/Sao_Paulo")[0] as BaseMessage),
      );
    const first = window(thread(10));
    expect(seen.length).toBe(30);
    const sizes = [20, 80, 320];
    for (const turns of sizes) {
      const before = seen.length;
      const previous = (sizes[sizes.indexOf(turns) - 1] ?? 10) * 3;
      window(thread(turns));
      expect(seen.length - before).toBe(turns * 3 - previous);
    }
    const before = seen.length;
    const again = window(thread(10));
    expect(seen.length).toBe(before);
    expect(again.tokens).toBe(first.tokens);
  });

  test("returns what the unmemoized estimate returns", () => {
    const { count } = counting();
    for (const m of thread(5)) {
      const fresh = countMessageTokens(m);
      expect(count(m)).toBe(fresh);
      expect(count(m)).toBe(fresh);
    }
  });

  test("a message edited under the same id is estimated again, at its new size", () => {
    const { count, seen } = counting();
    const short = count(new HumanMessage({ id: "m1", content: "oi" }));
    const long = count(
      new HumanMessage({ id: "m1", content: "oi, tudo bem? ".repeat(50) }),
    );
    expect(seen.length).toBe(2);
    expect(long).toBeGreaterThan(short * 10);
    expect(count(new HumanMessage({ id: "m1", content: "oi" }))).toBe(short);
    count(new HumanMessage({ id: "m1", content: "ok" }));
    expect(seen).toEqual(["oi", "oi, tudo bem? ".repeat(50), "ok"]);
  });

  test("tool calls that change are a new text, even with the same empty content", () => {
    const { count, seen } = counting();
    const call = (q: string) =>
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "search_kb", args: { q } }],
      });
    count(call("a"));
    count(call("a much longer question about the schedule"));
    expect(seen.length).toBe(2);
  });
});
