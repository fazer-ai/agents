import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { inCallScope } from "@/graph/tools/call-scope";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  buildNativeTools,
  buildSimulatedNativeTools,
  declaresOutcome,
} from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";

// What a turn review rule's `unlessTool` reads: whether a native tool's call acted or did nothing
// (call-scope.ts, `Outcome`). The handlers say it in their return type, and these tests hold the
// two ends of that: every native is built the way that enforces it, and the answers a model reads
// as an ordinary result while nothing was done are said as such.

type Ctx = Parameters<typeof buildNativeTools>[0];
const client = (over: Record<string, unknown> = {}) =>
  ({
    getConversationLabels: async () => ["urgente"],
    setConversationLabels: async () => ({}),
    getLatestIncomingMessage: async () => ({ id: 1, isReaction: true }),
    addMessageReaction: async () => ({}),
    moveKanbanTask: async () => ({}),
    updateKanbanTask: async () => ({}),
    sendPrivateNote: async () => ({}),
    ...over,
  }) as unknown as ChatwootClient;

// A context that offers every native of the catalog.
const everything = (): Ctx =>
  ({
    client: client(),
    conversationId: 7,
    kanban: {
      taskId: 3,
      currentStepId: 1,
      boardName: "Funil",
      card: {},
      steps: [
        { id: 1, name: "Novo" },
        { id: 2, name: "Fechado" },
      ],
    },
    contactFields: { writable: ["name"] },
    crossInboxCase: {
      config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 9 },
      contactId: 55,
    },
  }) as unknown as Ctx;

const run = async (t: StructuredToolInterface | undefined, args: object) => {
  const { value, didNothing } = await inCallScope(async () =>
    (t as StructuredToolInterface).invoke(args),
  );
  return { text: String(value), didNothing };
};
const named = (ctx: Ctx, name: string) =>
  buildNativeTools(ctx).find((t) => t.name === name);

describe("native tools say whether the call acted", () => {
  // The bug it catches: a native added with `tool()` or `failableTool()` directly, whose answers
  // nothing obliges to pick a side, so its refusals read as a call that acted.
  test("every native of the catalog is built by the wrappers that type its answers", () => {
    for (const build of [buildNativeTools, buildSimulatedNativeTools]) {
      const tools = build(everything());
      const names = tools.map((t) => t.name).sort();
      if (build === buildNativeTools)
        expect(names).toEqual([...NATIVE_TOOL_NAMES].sort());
      expect(
        tools.filter((t) => !declaresOutcome(t)).map((t) => t.name),
      ).toEqual([]);
    }
  });

  // The bug it catches: each of these answered ordinary text while doing nothing, and none said so,
  // so a rule against "I sent the image" was excused by the call that sent none.
  test("a refusal in ordinary text is said as a call that did nothing", async () => {
    const ctx = everything();
    const refused = [
      // No host is allowed for images.
      await run(
        named(
          {
            ...ctx,
            turnState: {
              pendingAttachments: [],
              imagesInFlight: 0,
              attachmentsSeq: 0,
            },
          } as unknown as Ctx,
          "send_image",
        ),
        {
          url: "https://exemplo.test/a.png",
        },
      ),
      // No turn to queue the image into.
      await run(named(ctx, "send_image"), {
        url: "https://exemplo.test/a.png",
      }),
      // The customer's last message is a reaction.
      await run(named(ctx, "react_to_message"), { emoji: "👍" }),
      await run(named(ctx, "kanban_move_card"), { targetStep: "Inexistente" }),
      await run(named(ctx, "update_kanban_task"), {}),
      await run(named(ctx, "set_voice_preference"), { preference: "audio" }),
      await run(named(ctx, "update_contact"), { name: "Maria" }),
      await run(named({ ...ctx, protectedLabels: ["vip"] }, "set_labels"), {
        add: ["vip"],
      }),
      await run(
        named(
          { ...ctx, handoffState: { completed: true } } as unknown as Ctx,
          "resolve_conversation",
        ),
        {},
      ),
      await run(named(ctx, "calculator"), { expression: "2 +" }),
    ];
    expect(refused.filter((r) => !r.didNothing).map((r) => r.text)).toEqual([]);
  });

  // The other side: a call that did it, or found the state already as it asked, is not marked.
  // Marking the second would send back, attempt after attempt, a reply that says what is true.
  test("a call that acted, or found things already as asked, is not marked", async () => {
    const ctx = everything();
    const acted = [
      await run(named(ctx, "kanban_move_card"), { targetStep: "Fechado" }),
      await run(named(ctx, "kanban_move_card"), { targetStep: "Novo" }),
      await run(named(ctx, "update_kanban_task"), { title: "Novo título" }),
      await run(named(ctx, "set_labels"), { add: ["urgente"] }),
      await run(named(ctx, "set_labels"), { add: ["financeiro"] }),
      await run(named(ctx, "private_note"), { content: "nota" }),
      await run(named(ctx, "calculator"), { expression: "2 + 2" }),
      await run(
        named(
          {
            ...ctx,
            client: client({
              getLatestIncomingMessage: async () => ({
                id: 1,
                isReaction: false,
              }),
            }),
          },
          "react_to_message",
        ),
        { emoji: "👍" },
      ),
    ];
    expect(acted.filter((r) => r.didNothing).map((r) => r.text)).toEqual([]);
  });
});
