import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import {
  admitWorkFor,
  fencedCheckpointer,
  recoveryNode,
  unansweredCalls,
  withoutAnswers,
} from "@/modules/client-channel/fence";

describe("the checkpointer a round-trip writes through", () => {
  const config = { configurable: { thread_id: "t", checkpoint_ns: "" } };
  const checkpoint = {
    v: 1,
    id: "00000000-0000-0000-0000-000000000001",
    ts: new Date().toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };

  test("writes while the claim is held, refuses every write once it is lost, reads either way", async () => {
    const saver = new MemorySaver();
    const fence = new AbortController();
    const fenced = fencedCheckpointer(saver, fence.signal);
    const written = await fenced.put(
      config,
      checkpoint as never,
      {} as never,
      {},
    );
    expect(await fenced.getTuple(written)).toBeTruthy();

    fence.abort(new Error("claim lost"));
    await expect(
      fenced.put(
        config,
        { ...checkpoint, id: "00000000-0000-0000-0000-000000000002" } as never,
        {} as never,
        {},
      ),
    ).rejects.toThrow("claim lost");
    await expect(
      fenced.putWrites(written, [["messages", []]], "task"),
    ).rejects.toThrow("claim lost");
    // Reads are not fenced: the round-trip still answers with what it has.
    expect(await fenced.getTuple(written)).toBeTruthy();
  });
});

describe("the calls a stopped round-trip left without an answer", () => {
  test("only the last assistant turn's calls that no tool message answers", () => {
    const messages = [
      new HumanMessage("oi"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "old", name: "calculator", args: {} }],
      }),
      new ToolMessage({ tool_call_id: "old", content: "2" }),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "a", name: "calculator", args: {} },
          { id: "b", name: "get_current_time", args: {} },
        ],
      }),
      new ToolMessage({ tool_call_id: "a", content: "4" }),
    ];
    expect(unansweredCalls(messages)).toEqual([
      { id: "b", name: "get_current_time" },
    ]);
    expect(unansweredCalls(messages.slice(0, 3))).toEqual([]);
    expect(unansweredCalls([new HumanMessage("oi")])).toEqual([]);
  });
});

describe("how long a round-trip may keep working on its claim", () => {
  test("half the claim, counted from when it was asked for, not from when it was confirmed", () => {
    // Asked at 30s for a 120s claim: expires at 150s, work stops being admitted at 90s.
    expect(admitWorkFor(30_000, 120_000, 30_000)).toBe(60_000);
    // Confirmed late, at 75s: 15s left, not another 60.
    expect(admitWorkFor(30_000, 120_000, 75_000)).toBe(15_000);
    // Confirmed after the point: stop now.
    expect(admitWorkFor(30_000, 120_000, 100_000)).toBe(0);
  });
});

describe("the node a recovery writes as", () => {
  test("client_tools when the graph has it, the agent when it has no tools at all", () => {
    expect(recoveryNode({ agent: 1, tools: 1, client_tools: 1 })).toBe(
      "client_tools",
    );
    expect(recoveryNode({ agent: 1 })).toBe("agent");
  });
});

describe("the pending calls a timeout closes", () => {
  test("only those the history does not already answer", () => {
    const calls = [
      { toolCallId: "a", name: "ler_tela", args: {} },
      { toolCallId: "b", name: "ler_nota", args: {} },
    ];
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "a", name: "ler_tela", args: {} },
          { id: "b", name: "ler_nota", args: {} },
        ],
      }),
      new ToolMessage({ tool_call_id: "a", content: "{}" }),
    ];
    expect(withoutAnswers(calls, messages).map((c) => c.toolCallId)).toEqual([
      "b",
    ]);
    expect(withoutAnswers(calls, [])).toHaveLength(2);
    // A call id an earlier turn already used and answered does not answer this turn's call.
    const reused = [
      new AIMessage({
        content: "",
        tool_calls: [{ id: "b", name: "ler_nota", args: {} }],
      }),
      new ToolMessage({ tool_call_id: "b", content: "antes" }),
      ...messages,
    ];
    expect(withoutAnswers(calls, reused).map((c) => c.toolCallId)).toEqual([
      "b",
    ]);
  });
});
