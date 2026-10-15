import { describe, expect, spyOn, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { CALLED_OFF_TOOL_RESULT } from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import * as reminders from "@/modules/appointments/reminders";
import * as redirect from "@/modules/channel-redirect/followup";
import * as debounce from "@/modules/debounce/handler";
import * as approvalOutcome from "@/modules/documents/approval-outcome";
import * as followups from "@/modules/followups/handlers";
import * as snoozed from "@/modules/followups/snoozed";
import { getJobHandler, type JobContext } from "@/modules/scheduler/worker";

// Where a job's deadline meets the graph. The signal is never handed to `graph.invoke`:
// aborting an invoke between a checkpointed tool call and its result leaves the thread with a call no
// `ToolMessage` answers, which the providers reject on every later turn, and the invoke rejects while
// the tool is still running, so the job would look finished with its work still going. The signal
// reaches the model call and the tool boundary instead: a tool already running finishes and is
// answered, the next model call sees the abort, and a call not yet run is refused like a called-off
// turn's.

// The first model call calls the writer; the second answers. Records whether each call's signal had
// aborted. `afterCalling` runs as the first returns its call, which is where a test puts the deadline
// to land between the model's answer and the tool.
class CallsThenAnswers {
  rounds = 0;
  sawAborted: boolean[] = [];
  constructor(private afterCalling?: () => void) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    return {
      async invoke(_m: BaseMessage[], opts?: { signal?: AbortSignal }) {
        self.rounds++;
        self.sawAborted.push(opts?.signal?.aborted === true);
        if (self.rounds === 1) {
          self.afterCalling?.();
          return new AIMessage({
            content: "",
            tool_calls: [{ name: "writer", args: { v: "sim" }, id: "c1" }],
          });
        }
        return new AIMessage("pronto");
      },
    };
  }
}

// A writer whose work spans a turn of the event loop. `during` runs as the tool starts, which is
// where a test puts the deadline to land while the tool is running; the write lands only after the
// abort's own reactions have run, so a graph that stopped waiting for the tool returns without it.
function writer(ran: string[], during?: () => void): StructuredToolInterface {
  return tool(
    async ({ v }: { v: string }) => {
      during?.();
      await new Promise((r) => setTimeout(r, 0));
      ran.push(v);
      return `wrote ${v}`;
    },
    {
      name: "writer",
      description: "writes something to the world",
      schema: z.object({ v: z.string() }),
    },
  ) as unknown as StructuredToolInterface;
}

// Every tool call in the thread has a `ToolMessage` answering it.
function unanswered(messages: BaseMessage[]): string[] {
  const answered = new Set(
    messages
      .filter((m) => m.getType() === "tool")
      .map((m) => (m as unknown as { tool_call_id: string }).tool_call_id),
  );
  return messages
    .flatMap((m) =>
      m.getType() === "ai" ? ((m as AIMessage).tool_calls ?? []) : [],
    )
    .map((c) => c.id as string)
    .filter((id) => !answered.has(id));
}

describe("a job's deadline inside the graph (issue #811)", () => {
  test("a tool running when the deadline fires finishes and is answered, and no model call starts after it", async () => {
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const controller = new AbortController();
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [
        writer(ran, () => controller.abort(new Error("deadline exceeded"))),
      ],
      signal: controller.signal,
    });
    await graph
      .invoke(
        { messages: [new HumanMessage("marca como qualificado")] },
        { configurable: { thread_id: "deadline-mid-tool" } },
      )
      .catch(() => undefined);
    // The graph returned only after the tool it was running had finished.
    expect(ran).toEqual(["sim"]);
    expect(model.sawAborted).toEqual([false]);
    const state = await graph.getState({
      configurable: { thread_id: "deadline-mid-tool" },
    });
    const messages = (state.values as { messages: BaseMessage[] }).messages;
    expect(unanswered(messages)).toEqual([]);
  });

  test("a tool call reached after the deadline is refused, answered, and the turn ends", async () => {
    const ran: string[] = [];
    const controller = new AbortController();
    const model = new CallsThenAnswers(() =>
      controller.abort(new Error("deadline exceeded")),
    );
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writer(ran)],
      signal: controller.signal,
    });
    const result = await graph
      .invoke(
        { messages: [new HumanMessage("marca como qualificado")] },
        { configurable: { thread_id: "deadline-before-tool" } },
      )
      .catch(async () =>
        graph
          .getState({ configurable: { thread_id: "deadline-before-tool" } })
          .then((st) => st.values as { messages: BaseMessage[] }),
      );
    expect(ran).toEqual([]);
    expect(model.rounds).toBe(1);
    const answers = result.messages.filter((m) => m.getType() === "tool");
    expect(contentToText(answers[0]?.content ?? "")).toBe(
      CALLED_OFF_TOOL_RESULT,
    );
    expect(unanswered(result.messages)).toEqual([]);
  });

  test("a deadline that fires while the tool fence is being read still refuses the call", async () => {
    // The fence's own read is I/O, and the deadline can end during it: the abort is read after the
    // fence answers, so a fence that says "still wanted" does not outvote a job that is already over.
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const controller = new AbortController();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writer(ran)],
      signal: controller.signal,
      stillWanted: async () => {
        controller.abort(new Error("deadline exceeded"));
        return true;
      },
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("marca como qualificado")] },
      { configurable: { thread_id: "deadline-during-fence" } },
    );
    expect(ran).toEqual([]);
    const answers = result.messages.filter((m) => m.getType() === "tool");
    expect(contentToText(answers[0]?.content ?? "")).toBe(
      CALLED_OFF_TOOL_RESULT,
    );
    expect(unanswered(result.messages)).toEqual([]);
  });

  test("a primary ended by the deadline does not hand the turn to the fallback, and the turn fails with the job's own error", async () => {
    // The primary listens and rejects the way the SDKs do on an abort, which the provider layer reads
    // as a timeout, which is what would hand the turn to the fallback.
    const primaryCalled = Promise.withResolvers<void>();
    const primary = {
      async invoke(_m: BaseMessage[], opts?: { signal?: AbortSignal }) {
        await new Promise<void>((_, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("Request was aborted.");
            err.name = "AbortError";
            reject(err);
          });
          primaryCalled.resolve();
        });
        return new AIMessage("never");
      },
      bindTools() {
        return primary;
      },
    };
    let fallbackCalls = 0;
    const fallback = {
      async invoke() {
        fallbackCalls++;
        return new AIMessage("do fallback");
      },
      bindTools() {
        return fallback;
      },
    };
    const controller = new AbortController();
    // No fallback started, so none is reported: the failover and the failed provider would both be
    // lines about a call that was never made.
    const reported: string[] = [];
    const graph = buildAgentGraph({
      model: primary as unknown as BaseChatModel,
      systemPrompt: "s",
      onModelFallback: () => {
        reported.push("fallback");
      },
      onModelFallbackFailed: () => {
        reported.push("fallback-failed");
      },
      primary: { provider: "openai", model: "test-model" },
      fallback: {
        model: fallback as unknown as BaseChatModel,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      signal: controller.signal,
    });
    let thrown: unknown;
    const run = graph
      .invoke({ messages: [new HumanMessage("oi")] })
      .catch((err: unknown) => {
        thrown = err;
      });
    // The deadline lands while the primary's call is in flight.
    await primaryCalled.promise;
    controller.abort(new Error("deadline exceeded after 240s"));
    await run;
    expect(fallbackCalls).toBe(0);
    expect(reported).toEqual([]);
    expect((thrown as Error | undefined)?.message).toBe(
      "deadline exceeded after 240s",
    );
  });

  test("a fallback already running when the deadline fires is ended by it", async () => {
    // The fallback's own call gets the per-call deadline from `runModelCall`; the job's has to be
    // joined to it, or a fallback that started before the deadline runs on for its full 45 s.
    const primary = {
      async invoke() {
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      },
      bindTools() {
        return primary;
      },
    };
    let sawAbort = false;
    const fallbackCalled = Promise.withResolvers<void>();
    const fallback = {
      async invoke(_m: BaseMessage[], opts?: { signal?: AbortSignal }) {
        await new Promise<void>((_, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            sawAbort = true;
            const err = new Error("Request was aborted.");
            err.name = "AbortError";
            reject(err);
          });
          fallbackCalled.resolve();
        });
        return new AIMessage("never");
      },
      bindTools() {
        return fallback;
      },
    };
    const controller = new AbortController();
    const graph = buildAgentGraph({
      model: primary as unknown as BaseChatModel,
      systemPrompt: "s",
      primary: { provider: "openai", model: "test-model" },
      fallback: {
        model: fallback as unknown as BaseChatModel,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      signal: controller.signal,
    });
    const run = graph
      .invoke({ messages: [new HumanMessage("oi")] })
      .catch(() => {});
    // The deadline lands while the fallback's call is in flight, and it is what ends that call.
    await fallbackCalled.promise;
    controller.abort(new Error("deadline exceeded after 240s"));
    await run;
    expect(sawAbort).toBe(true);
  });

  // The handlers are tested by calling them, which skips the registration, and a registration that
  // wraps its handler is where the signal is easiest to drop. Each kind whose handler runs a model
  // turn is driven through its REGISTERED handler with a job context, and the function it delegates
  // to must receive that context's signal; from there each handler's own deadline tests carry it to
  // the turn.
  test.each([
    {
      kind: "FOLLOWUP",
      register: followups.registerFollowUpHandlers,
      spy: () => spyOn(followups, "followUpHandler"),
      signalOf: (args: unknown[]) =>
        (args[3] as JobContext | undefined)?.signal,
    },
    {
      kind: "SNOOZED_FOLLOWUP",
      register: followups.registerFollowUpHandlers,
      spy: () => spyOn(snoozed, "snoozedFollowUpHandler"),
      signalOf: (args: unknown[]) =>
        (args[3] as JobContext | undefined)?.signal,
    },
    {
      kind: "APPOINTMENT_REMINDER",
      register: reminders.registerAppointmentReminderHandler,
      spy: () => spyOn(reminders, "appointmentReminderHandler"),
      signalOf: (args: unknown[]) =>
        (args[3] as JobContext | undefined)?.signal,
    },
    {
      kind: "REDIRECT_FOLLOWUP",
      register: redirect.registerRedirectFollowUpHandlers,
      spy: () => spyOn(redirect, "redirectFollowUpHandler"),
      signalOf: (args: unknown[]) =>
        (args[3] as JobContext | undefined)?.signal,
    },
    {
      kind: "DEBOUNCE",
      register: debounce.registerDebounceHandler,
      spy: () => spyOn(debounce, "flushDebounceJob"),
      signalOf: (args: unknown[]) =>
        (args[0] as { signal?: AbortSignal } | undefined)?.signal,
    },
    {
      kind: "DOCUMENT_APPROVAL_OUTCOME",
      register: approvalOutcome.registerDocumentApprovalOutcomeHandler,
      spy: () => spyOn(approvalOutcome, "runOutcomeJob"),
      signalOf: (args: unknown[]) =>
        (args[3] as JobContext | undefined)?.signal,
    },
  ])(
    "the $kind registration hands its job's signal on",
    async ({ kind, register, spy, signalOf }) => {
      register();
      const handler = getJobHandler(kind);
      if (!handler) throw new Error(`${kind} has no registered handler`);
      const delegate = spy().mockImplementation((async () => ({
        outcome: "done",
      })) as never);
      const signal = new AbortController().signal;
      try {
        await handler({} as never, {} as never, { signal } as JobContext);
        expect(delegate).toHaveBeenCalledTimes(1);
        expect(signalOf(delegate.mock.calls[0] as unknown[])).toBe(signal);
      } finally {
        delegate.mockRestore();
      }
    },
  );
});
