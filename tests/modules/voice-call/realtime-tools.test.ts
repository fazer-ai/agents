import { describe, expect, test } from "bun:test";
import {
  RealtimeToolRunner,
  realtimeToolDefs,
  withDeadline,
} from "@/modules/voice-call/providers/realtime-tools";
import type { VoiceTool } from "@/modules/voice-call/providers/types";

const clock: VoiceTool = {
  name: "get_current_time",
  description: "now",
  parameters: { type: "object", properties: {} },
  invoke: async () => "10:30",
};

describe("RealtimeToolRunner", () => {
  test("answers a call once the response is done, then asks the model to go on", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const runner = new RealtimeToolRunner([clock], (e) => sent.push(e));
    expect(
      runner.start({
        name: "get_current_time",
        call_id: "c1",
        arguments: "{}",
      }),
    ).toBe(true);
    expect(await runner.flush()).toBe(true);
    expect(sent).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "c1", output: "10:30" },
      },
      { type: "response.create" },
    ]);
    expect(await runner.flush()).toBe(false);
  });

  test("runs a tool under a deadline of its own", async () => {
    const handed: Array<AbortSignal | undefined> = [];
    const runner = new RealtimeToolRunner(
      [
        {
          ...clock,
          invoke: async (_a, _id, signal) => {
            handed.push(signal);
            return "10:30";
          },
        },
      ],
      () => {},
    );
    runner.start({ name: "get_current_time", call_id: "c1", arguments: "{}" });
    await runner.flush();
    expect(handed.map((s) => s instanceof AbortSignal)).toEqual([true]);
  });

  test("leaves end_call to the provider", () => {
    const runner = new RealtimeToolRunner([clock], () => {});
    expect(
      runner.start({ name: "end_call", call_id: "c2", arguments: "{}" }),
    ).toBe(false);
  });

  test("turns an unknown tool or a failure into an output the model can read", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const broken: VoiceTool = {
      ...clock,
      name: "broken",
      invoke: async () => Promise.reject(new Error("boom")),
    };
    const runner = new RealtimeToolRunner([broken], (e) => sent.push(e));
    runner.start({ name: "broken", call_id: "c3", arguments: "{}" });
    runner.start({ name: "nope", call_id: "c4", arguments: "{}" });
    await runner.flush();
    const outputs = sent
      .filter((e) => e.type === "conversation.item.create")
      .map((e) => (e.item as { output: string }).output);
    expect(outputs.sort()).toEqual([
      "Erro ao usar a ferramenta: boom",
      "Erro ao usar a ferramenta: unknown tool nope",
    ]);
  });

  test("offers end_call beside the agent's tools", () => {
    expect(realtimeToolDefs([clock]).map((t) => t.name)).toEqual([
      "end_call",
      "get_current_time",
    ]);
  });
});

describe("a tool run past its deadline", () => {
  test("is cut before the call hears it timed out, so it sends nothing after that answer", async () => {
    let handed: AbortSignal | undefined;
    const outcome = await withDeadline((signal) => {
      handed = signal;
      return new Promise<string>(() => {});
    }, 5).catch((err: Error) => ({
      message: err.message,
      cutFirst: handed?.aborted === true,
    }));
    expect(outcome).toEqual({
      message: "tool timed out after 5 ms",
      cutFirst: true,
    });
  });

  test("one that answers in time is not cut", async () => {
    let handed: AbortSignal | undefined;
    expect(
      await withDeadline(async (signal) => {
        handed = signal;
        return "ok";
      }, 1_000),
    ).toBe("ok");
    expect(handed?.aborted).toBe(false);
  });
});
