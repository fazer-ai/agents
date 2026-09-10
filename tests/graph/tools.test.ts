import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  applyLabelIntent,
  buildNativeTools,
  type HandoffTurnState,
  handoffAnsweredTheTurn,
  NATIVE_TOOL_NAMES,
} from "@/graph/tools/native";
import { applyToolPreconditions } from "@/graph/tools/precondition";
import type { ChatwootClient } from "@/modules/chatwoot/client";

function recordingClient() {
  const calls: Array<[string, unknown[]]> = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      return {};
    };
  const client = {
    sendMessage: rec("sendMessage"),
    sendPrivateNote: rec("sendPrivateNote"),
    toggleStatus: rec("toggleStatus"),
    setConversationCustomAttributes: rec("setConversationCustomAttributes"),
    moveKanbanTask: rec("moveKanbanTask"),
    updateKanbanTask: rec("updateKanbanTask"),
  } as unknown as ChatwootClient;
  return { client, calls };
}

function byName(tools: StructuredToolInterface[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("native tools", () => {
  test("exposes all tools by default; the allowlist filters (fail-closed)", () => {
    const { client } = recordingClient();
    expect(
      buildNativeTools({ client, conversationId: 1 })
        .map((t) => t.name)
        .sort(),
    ).toEqual([...NATIVE_TOOL_NAMES].sort());

    const only = buildNativeTools({ client, conversationId: 1 }, [
      "private_note",
    ]);
    expect(only.map((t) => t.name)).toEqual(["private_note"]);
  });

  test("react_to_message reacts to the customer's last message when it is not a reaction", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const client = {
      getLatestIncomingMessage: async () => ({ id: 123, isReaction: false }),
      addMessageReaction: async (...args: unknown[]) => {
        calls.push(["addMessageReaction", args]);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({ client, conversationId: 42 });
    const out = await byName(tools, "react_to_message").invoke({ emoji: "👍" });
    expect(calls).toEqual([["addMessageReaction", [42, 123, "👍"]]]);
    expect(String(out)).toContain("Reacted");
  });

  test("react_to_message refuses (no API call) when the customer's last message is a reaction", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const client = {
      getLatestIncomingMessage: async () => ({ id: 124, isReaction: true }),
      addMessageReaction: async (...args: unknown[]) => {
        calls.push(["addMessageReaction", args]);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({ client, conversationId: 42 });
    const out = await byName(tools, "react_to_message").invoke({ emoji: "👍" });
    // The tool must NOT call the reaction API and must tell the model not to react.
    expect(calls).toEqual([]);
    expect(String(out).toLowerCase()).toContain("reaction");
    expect(String(out).toLowerCase()).toContain("do not react");
  });

  test("handoff_to_human posts a private note then sets status open", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 42 });
    const out = await byName(tools, "handoff_to_human").invoke({
      reason: "cliente pediu humano",
    });
    expect(calls).toEqual([
      ["sendPrivateNote", [42, "cliente pediu humano"]],
      ["toggleStatus", [42, "open"]],
    ]);
    expect(String(out)).toContain("human");
  });

  // #160: the tool writes NOTHING to the customer. The closing line is recorded for the caller, which
  // is what puts it through the output guardrail and the shared delivery path.
  test("handoff with customerMessage sends only the note and the transfer", async () => {
    const { client, calls } = recordingClient();
    const handoffState: HandoffTurnState = {
      customerMessage: null,
      completed: false,
    };
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      handoffState,
    });
    await byName(tools, "handoff_to_human").invoke({
      customerMessage: "Vou te transferir para um atendente, um momento.",
      reason: "cliente pediu humano",
    });
    expect(calls).toEqual([
      ["sendPrivateNote", [42, "cliente pediu humano"]],
      ["toggleStatus", [42, "open"]],
    ]);
    expect(handoffState.customerMessage).toBe(
      "Vou te transferir para um atendente, um momento.",
    );
  });

  test("a recorded handoff customerMessage marks the turn as terminal", async () => {
    const { client } = recordingClient();
    const handoffState: HandoffTurnState = {
      customerMessage: null,
      completed: false,
    };
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      handoffState,
    });
    await byName(tools, "handoff_to_human").invoke({
      customerMessage: "Vou te transferir para um atendente, um momento.",
    });
    expect(handoffState.customerMessage).not.toBeNull();
    expect(handoffState.completed).toBe(true);
  });

  // toggleStatus is where the conversation actually leaves `pending`, and it is not best-effort: a
  // throw there means nobody was told about a customer the model was about to promise a human to, so
  // the caller must let the model speak again — and the undelivered promise must NOT go out, which is
  // what recording instead of sending buys.
  //
  // It records NOTHING, and that is the point: the model is handed the error and calls the tool
  // again, so a line left behind by the attempt that failed would be delivered by the attempt that
  // worked, in place of whatever the model decided to say the second time.
  test("a handoff whose toggleStatus throws records nothing at all", async () => {
    const client = {
      sendMessage: async () => ({}),
      sendPrivateNote: async () => ({}),
      toggleStatus: async () => {
        throw new Error("chatwoot 502");
      },
    } as unknown as ChatwootClient;
    const handoffState: HandoffTurnState = {
      customerMessage: null,
      completed: false,
    };
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      handoffState,
    });
    await expect(
      byName(tools, "handoff_to_human").invoke({
        customerMessage: "Um humano já te atende.",
        reason: "cliente pediu humano",
      }),
    ).rejects.toThrow();
    expect(handoffState.customerMessage).toBeNull();
    expect(handoffState.completed).toBe(false);
  });

  test("handoff without a reason only sets status open", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 42 });
    await byName(tools, "handoff_to_human").invoke({});
    expect(calls).toEqual([["toggleStatus", [42, "open"]]]);
  });

  test("transferWithSummary:false suppresses the note even when a reason is given", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      transferWithSummary: false,
    });
    await byName(tools, "handoff_to_human").invoke({ reason: "summary text" });
    expect(calls).toEqual([["toggleStatus", [42, "open"]]]);
  });

  test("transferWithSummary:true (explicit) still posts the note", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      transferWithSummary: true,
    });
    await byName(tools, "handoff_to_human").invoke({ reason: "summary text" });
    expect(calls).toEqual([
      ["sendPrivateNote", [42, "summary text"]],
      ["toggleStatus", [42, "open"]],
    ]);
  });

  const kanbanCtx = {
    taskId: 11,
    boardId: 2,
    boardName: "Vendas SDR",
    currentStepId: 7,
    currentStepName: "Novo Lead",
    steps: [
      { id: 7, name: "Novo Lead" },
      { id: 22, name: "Ganho" },
    ],
    card: {
      title: "Lead 1",
      description: null,
      priority: null,
      status: "open",
      value: null,
      startDate: null,
      dueDate: null,
      attributes: {},
      labels: [],
    },
  };

  test("kanban_move_card moves this conversation's card by step name", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: kanbanCtx,
    });
    const move = byName(tools, "kanban_move_card");
    // The current step + available steps are grounded into the description as an XML block (the agent
    // picks a step name from <available_steps>).
    expect(move.description).toContain('<kanban_card board="Vendas SDR">');
    expect(move.description).toContain(
      "<current_step>Novo Lead</current_step>",
    );
    expect(move.description).toContain("<step>Ganho</step>");
    const out = String(await move.invoke({ targetStep: "Ganho" }));
    expect(calls).toEqual([["moveKanbanTask", [11, 22]]]);
    expect(out).toContain("Ganho");
  });

  test("kanban_move_card without a linked card is a safe no-op", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 7 });
    const out = String(
      await byName(tools, "kanban_move_card").invoke({ targetStep: "Ganho" }),
    );
    expect(out.toLowerCase()).toContain("no linked kanban card");
    expect(calls).toEqual([]);
  });

  test("update_kanban_task patches only the provided scalar fields", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: kanbanCtx,
    });
    const tool = byName(tools, "update_kanban_task");
    // The current card values are grounded into the description as an XML block (element names mirror
    // the args) so the model edits only what changed.
    expect(tool.description).toContain('<current_card board="Vendas SDR">');
    expect(tool.description).toContain("<title>Lead 1</title>");
    const out = String(
      await tool.invoke({
        title: "Maria Souza",
        priority: "high",
        dueDate: "2026-06-20",
      }),
    );
    expect(calls).toEqual([
      [
        "updateKanbanTask",
        [11, { title: "Maria Souza", priority: "high", dueDate: "2026-06-20" }],
      ],
    ]);
    expect(out.toLowerCase()).toContain("updated");
  });

  test("update_kanban_task with no fields makes no call", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: kanbanCtx,
    });
    const out = String(await byName(tools, "update_kanban_task").invoke({}));
    expect(calls).toEqual([]);
    expect(out.toLowerCase()).toContain("at least one");
  });

  test("update_kanban_task without a linked card is a safe no-op", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 7 });
    const out = String(
      await byName(tools, "update_kanban_task").invoke({ title: "x" }),
    );
    expect(out.toLowerCase()).toContain("no linked kanban card");
    expect(calls).toEqual([]);
  });

  test("update_kanban_task appends operator guidance after the base text", () => {
    const { client } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: kanbanCtx,
      toolInstructions: {
        update_kanban_task: "Nunca renomeie o card sem confirmação.",
      },
    });
    const desc = byName(tools, "update_kanban_task").description ?? "";
    expect(desc).toContain(
      "Operator guidance: Nunca renomeie o card sem confirmação.",
    );
    expect(desc.indexOf("Update this conversation")).toBeLessThan(
      desc.indexOf("Operator guidance:"),
    );
  });

  test("set_custom_attribute task scope writes to the linked card", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const client = {
      setKanbanTaskCustomAttributes: async (...args: unknown[]) => {
        calls.push(["setKanbanTaskCustomAttributes", args]);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: kanbanCtx,
    });
    await byName(tools, "set_custom_attribute").invoke({
      key: "ticket_size",
      value: "5000",
      scope: "task",
    });
    expect(calls).toEqual([
      ["setKanbanTaskCustomAttributes", [11, { ticket_size: "5000" }]],
    ]);
  });

  test("private_note / set_custom_attribute / resolve call the right client methods", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 7 });
    await byName(tools, "private_note").invoke({ content: "nota interna" });
    await byName(tools, "set_custom_attribute").invoke({
      key: "stage",
      value: "lead",
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls).toEqual([
      ["sendPrivateNote", [7, "nota interna"]],
      ["setConversationCustomAttributes", [7, { stage: "lead" }]],
      ["toggleStatus", [7, "resolved"]],
    ]);
  });

  test("resolve_conversation with turnState defers (no client call, flags the state)", async () => {
    const { client, calls } = recordingClient();
    const turnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools({ client, conversationId: 7, turnState });
    const out = String(await byName(tools, "resolve_conversation").invoke({}));
    // Idempotent: a second call in the same turn is still a single intent.
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls).toEqual([]);
    expect(turnState.resolveRequested).toBe(true);
    expect(out).toContain("after your final reply");
  });

  describe("applyLabelIntent", () => {
    test("no shown set ⇒ a pure union, whatever the model left out", () => {
      expect(applyLabelIntent(undefined, ["b"], ["a"])).toEqual({
        next: ["a", "b"],
        added: ["b"],
        removed: [],
        visible: ["a", "b"],
      });
    });

    test("only what was SHOWN and left out is removed", () => {
      // `c` is standing but was never shown, so silence about it is not a request to remove it.
      expect(applyLabelIntent(["a", "b"], ["a"], ["a", "b", "c"])).toEqual({
        next: ["a", "c"],
        added: [],
        removed: ["b"],
        visible: ["a", "c"],
      });
    });

    test("a shown label the conversation no longer carries is not reported as removed", () => {
      // Somebody took `b` off between the read and the write. The intent still says "not b", and
      // the answer is the same set — but the report is about what THIS write did, and it did not
      // remove anything.
      expect(applyLabelIntent(["a", "b"], ["a"], ["a"])).toEqual({
        next: ["a"],
        added: [],
        removed: [],
        visible: ["a"],
      });
    });

    test("blank and duplicate entries are dropped, and order is stable", () => {
      expect(
        applyLabelIntent([], ["  vip ", "vip", "", "   ", "lead"], []),
      ).toEqual({
        next: ["vip", "lead"],
        added: ["vip", "lead"],
        removed: [],
        visible: ["vip", "lead"],
      });
    });

    test("repeating a shown label does NOT put it back after somebody removed it", () => {
      // The mirror of the case above, and the one a removals-only diff gets wrong. An operator
      // peeled `vip` off while the model was generating; the model repeats it only because leaving
      // it out would delete it. Read as an addition, the tool undoes the operator — the same harm
      // as erasing a concurrent ADD, in the other direction.
      expect(applyLabelIntent(["vip"], ["vip", "lead"], [])).toEqual({
        next: ["lead"],
        added: ["lead"],
        removed: [],
        visible: ["lead"],
      });
    });

    test("a label shown, kept, and still standing is left exactly alone", () => {
      expect(applyLabelIntent(["vip"], ["vip", "lead"], ["vip"])).toEqual({
        next: ["vip", "lead"],
        added: ["lead"],
        removed: [],
        visible: ["vip", "lead"],
      });
    });

    test("an empty desired list with nothing shown writes nothing at all", () => {
      // The clear-everything call and the never-read case have to be told apart, or an unread
      // context turns every "no labels apply" into wiping the conversation.
      expect(applyLabelIntent(undefined, [], ["a", "b"])).toEqual({
        next: ["a", "b"],
        added: [],
        removed: [],
        visible: ["a", "b"],
      });
    });

    test("a guarded label SHOWN and left out is not removed", () => {
      // The defect this guard exists for, and it is not the concurrent-write one: `agente-off` was
      // standing before the turn, so it WAS shown, and the model leaving it out reads as a request
      // to remove it. Measured on a live fork: asked for `["compra-de-ingresso"]`, the tool answered
      // `removed "cancelamento", "agente-off", "vip"`.
      expect(
        applyLabelIntent(
          ["cancelamento", "agente-off"],
          ["compra-de-ingresso"],
          ["cancelamento", "agente-off"],
          ["agente-off"],
        ),
      ).toEqual({
        next: ["agente-off", "compra-de-ingresso"],
        added: ["compra-de-ingresso"],
        removed: ["cancelamento"],
        visible: ["compra-de-ingresso"],
      });
    });

    test("a guarded label the model ASKS FOR is not added either", () => {
      // The other direction, and the one hiding it from the description does not cover: a model
      // that learned the name from the operator's prompt could otherwise switch the agent off by
      // naming the label, which is the same authority the guard is supposed to deny.
      expect(
        applyLabelIntent([], ["agente-off", "vip"], [], ["agente-off"]),
      ).toEqual({
        next: ["vip"],
        added: ["vip"],
        removed: [],
        visible: ["vip"],
      });
    });

    test("the guard reaches the report, so shown and told stay ONE list", () => {
      // `visible` is what the report states and what recordShown stores. If the guarded label leaked
      // into either, the next call in the turn would be handed a label it is not allowed to keep and
      // would be told it kept it — the same two-views defect this file already carries.
      const out = applyLabelIntent(
        ["vip"],
        ["vip", "lead"],
        ["vip", "testando-agente"],
        ["testando-agente"],
      );
      expect(out.next).toEqual(["vip", "testando-agente", "lead"]);
      expect(out.visible).toEqual(["vip", "lead"]);
      expect(out.removed).toEqual([]);
    });

    test("an empty guard list is the behaviour before the guard", () => {
      expect(applyLabelIntent(["a", "b"], ["a"], ["a", "b"], [])).toEqual({
        next: ["a"],
        added: [],
        removed: ["b"],
        visible: ["a"],
      });
    });
  });

  test("set_labels without a shown set only ADDS (the safe degenerate)", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["vip"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    // No shownLabels: the model never saw what was there, so leaving "vip" out of the list cannot
    // mean "remove it" — the read that would have justified the removal did not happen.
    const tools = buildNativeTools({ client, conversationId: 9 });
    const out = String(
      await byName(tools, "set_labels").invoke({ labels: ["lead"] }),
    );
    expect(setCalls).toEqual([[9, ["vip", "lead"]]]);
    expect(out).toContain("lead");
  });

  test("set_labels removes a label the model was shown and left out", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["vip", "lead"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: ["vip", "lead"] },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({ labels: ["vip"] }),
    );
    expect(setCalls).toEqual([[9, ["vip"]]]);
    expect(out).toContain('removed "lead"');
  });

  test("set_labels does NOT erase a label added while the model was generating", async () => {
    // The whole reason the write is a diff and not the model's list: `agente-off` landed between
    // the turn's read and this call. The model never saw it, so it never asked for it to go — and
    // sending its list verbatim would take it out and put the agent back on a conversation somebody
    // had just switched it off.
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["dúvidas-evento", "agente-off"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: ["dúvidas-evento"] },
    });
    await byName(tools, "set_labels").invoke({ labels: ["cancelamento"] });
    expect(setCalls).toEqual([[9, ["agente-off", "cancelamento"]]]);
  });

  test("set_labels cannot erase a guarded label it was shown", async () => {
    // The concurrent-write case above only protects a label that landed mid-turn. This one was there
    // before the turn started, so it is in `shownLabels`, and only the guard keeps it.
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["dúvidas-evento", "agente-off"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: ["dúvidas-evento"] },
      protectedLabels: ["agente-off"],
    });
    const out = await byName(tools, "set_labels").invoke({
      labels: ["cancelamento"],
    });
    expect(setCalls).toEqual([[9, ["agente-off", "cancelamento"]]]);
    // And the model is never told the label is there, so it cannot act on it next call.
    expect(String(out)).not.toContain("agente-off");
  });

  test("set_labels with an empty list clears what was shown, and nothing else", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["vip", "agente-off"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: ["vip"] },
    });
    await byName(tools, "set_labels").invoke({ labels: [] });
    expect(setCalls).toEqual([[9, ["agente-off"]]]);
  });

  test("set_labels writes nothing when the set already matches", async () => {
    let setCount = 0;
    const client = {
      getConversationLabels: async () => ["vip"],
      setConversationLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: ["vip"] },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({ labels: ["vip"] }),
    );
    expect(setCount).toBe(0);
    expect(out.toLowerCase()).toContain("already as requested");
    // The resulting set is stated even when nothing moved: it is the model's only reading of the
    // scope after its own writes, since the description block is frozen at turn prep.
    expect(out).toContain('Now set: "vip"');
  });

  test("a second call in the same turn can undo what the first one wrote", async () => {
    // The model's visible set is not the turn-prep snapshot for the whole turn: it moves with the
    // model's own writes. Without that, `set_labels(['pending'])` then `set_labels([])` diffs the
    // second call against a snapshot that never held `pending`, leaves it standing, and reports
    // that nothing changed.
    let current: string[] = [];
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        current = [...(args[1] as string[])];
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    });
    const first = String(
      await byName(tools, "set_labels").invoke({ labels: ["pending"] }),
    );
    expect(first).toContain('added "pending"');
    const second = String(
      await byName(tools, "set_labels").invoke({ labels: [] }),
    );
    expect(setCalls).toEqual([
      [9, ["pending"]],
      [9, []],
    ]);
    expect(second).toContain('removed "pending"');
    expect(second).toContain("Now set: (none)");
  });

  test("a label a concurrent writer added becomes removable only once reported", async () => {
    // `urgente` lands between the turn's read and the first call. The first write keeps it (the
    // model never saw it) and the report hands it over; only then may a later call drop it — which
    // is what keeps "shown" meaning shown while still letting the state move.
    let current: string[] = ["urgente"];
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        current = [...(args[1] as string[])];
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    });
    const first = String(
      await byName(tools, "set_labels").invoke({ labels: ["compra"] }),
    );
    expect(setCalls[0]).toEqual([9, ["urgente", "compra"]]);
    expect(first).toContain('Now set: "urgente", "compra"');
    await byName(tools, "set_labels").invoke({ labels: ["compra"] });
    expect(setCalls).toHaveLength(2);
    expect(setCalls[1]).toEqual([9, ["compra"]]);
  });

  test("two calls in ONE batch do not read each other's writes", async () => {
    // LangGraph dispatches a tool-call batch concurrently, and both calls were written by the model
    // from the same snapshot — neither could have read the other's result. If the second one reads
    // the shown set AFTER waiting for the queue, it takes the first one's write for a label it saw
    // and left out, and `["a"]` beside `["b"]` ends as `b` alone.
    let current: string[] = [];
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        current = [...(args[1] as string[])];
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    });
    const tool = byName(tools, "set_labels");
    await Promise.all([
      tool.invoke({ labels: ["a"] }),
      tool.invoke({ labels: ["b"] }),
    ]);
    expect(setCalls).toHaveLength(2);
    expect([...current].sort()).toEqual(["a", "b"]);
  });

  test("a guarded batch shares its baseline, whatever the state reads do", async () => {
    // The precondition wrapper AWAITS the state read before the tool's own handler is entered, so
    // "snapshot at the top of the handler" is not the dispatch point: the second call can arrive
    // after the first has written. The baseline is keyed on LangGraph's batch instead of timed.
    let current: string[] = [];
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        current = [...(args[1] as string[])];
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    });
    // One slow state read and one fast one, so the second call lands after the first has finished.
    let reads = 0;
    const guarded = applyToolPreconditions(
      tools,
      {
        set_labels: { kind: "attribute", scope: "conversation", key: "ok" },
      },
      async () => {
        reads++;
        if (reads === 2) await new Promise((r) => setTimeout(r, 60));
        return {
          conversationAttributes: { ok: "1" },
          contactAttributes: {},
        };
      },
    );
    const tool = byName(guarded, "set_labels");
    // The batch metadata LangGraph itself supplies: one step for both calls (measured — the two
    // calls of a batch carry the same `langgraph_step`, the next batch a different one).
    const batch = {
      metadata: {
        thread_id: "t",
        langgraph_checkpoint_ns: "",
        langgraph_step: 2,
      },
    };
    await Promise.all([
      tool.invoke({ labels: ["a"] }, batch),
      tool.invoke({ labels: ["b"] }, batch),
    ]);
    expect([...current].sort()).toEqual(["a", "b"]);
  });

  test("set_labels refuses to write when the fence is withdrawn inside the queue", async () => {
    // `/reset` clears the episode's labels in this very queue, so the ask at the tool boundary is
    // not the last word: the wait for the queue comes after it.
    let setCount = 0;
    const client = {
      getConversationLabels: async () => ["vip"],
      setConversationLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: ["vip"] },
      stillWanted: async () => false,
    });
    const out = String(
      await byName(tools, "set_labels").invoke({ labels: ["cancelamento"] }),
    );
    expect(setCount).toBe(0);
    expect(out).toContain("called off");
  });

  test("set_labels task scope writes the card's labels (snapshot read + write)", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      setKanbanTaskLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      kanban: kanbanCtx, // card.labels: []
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        labels: ["quente"],
        scope: "task",
      }),
    );
    expect(setCalls).toEqual([[11, ["quente"]]]);
    expect(out.toLowerCase()).toContain("card");
  });

  test("set_labels task scope is offered only when a card is linked", () => {
    const { client } = recordingClient();
    const withCard = byName(
      buildNativeTools({ client, conversationId: 9, kanban: kanbanCtx }),
      "set_labels",
    ).description;
    const without = byName(
      buildNativeTools({ client, conversationId: 9 }),
      "set_labels",
    ).description;
    expect(withCard).toContain("kanban card");
    expect(without ?? "").not.toContain("kanban card");
  });

  test("set_labels contact scope without a contact in ctx → safe message (no write)", async () => {
    let setCount = 0;
    const client = {
      getContactLabels: async () => [],
      setContactLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({ client, conversationId: 9 });
    const out = String(
      await byName(tools, "set_labels").invoke({
        labels: ["lead"],
        scope: "contact",
      }),
    );
    expect(setCount).toBe(0);
    expect(out.toLowerCase()).toContain("contact");
  });

  test("the description shows the labels standing now, and omits a scope it could not read", () => {
    const { client } = recordingClient();
    const desc =
      byName(
        buildNativeTools({
          client,
          conversationId: 9,
          shownLabels: { conversation: ["vip", "aguardando-cliente"] },
        }),
        "set_labels",
      ).description ?? "";
    expect(desc).toContain("<current_labels>");
    expect(desc).toContain("vip, aguardando-cliente");
    // The contact was not read, so it is absent rather than empty: `<contact empty="true"/>` would
    // tell the model the contact has no labels, which is what makes a model clear them.
    expect(desc).not.toContain("<contact");
  });

  test("a scope read as EMPTY is shown as empty, which is not the same as unread", () => {
    const { client } = recordingClient();
    const desc =
      byName(
        buildNativeTools({
          client,
          conversationId: 9,
          shownLabels: { conversation: [] },
        }),
        "set_labels",
      ).description ?? "";
    expect(desc).toContain('<conversation empty="true"/>');
  });

  test("operator guidance reaches set_custom_attribute + set_labels descriptions", () => {
    const { client } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      toolInstructions: {
        set_custom_attribute: "Sempre grave a etapa do funil em lead_stage.",
        set_labels: "Use 'vip' só para clientes premium.",
      },
    });
    expect(byName(tools, "set_custom_attribute").description ?? "").toContain(
      "Operator guidance: Sempre grave a etapa do funil em lead_stage.",
    );
    expect(byName(tools, "set_labels").description ?? "").toContain(
      "Operator guidance: Use 'vip' só para clientes premium.",
    );
  });

  test("vocab grounds the set_labels + set_custom_attribute descriptions", () => {
    const { client } = recordingClient();
    const vocab = {
      labels: ["lead", "vip"],
      attributes: [
        {
          key: "lead_stage",
          displayName: "Lead stage",
          model: "conversation_attribute",
          displayType: "list",
          values: ["new", "qualified"],
        },
        {
          key: "plano",
          displayName: "Plano",
          model: "contact_attribute",
          displayType: "text",
          values: [],
        },
      ],
    };
    const tools = buildNativeTools({ client, conversationId: 7, vocab });
    const label = byName(tools, "set_labels").description ?? "";
    expect(label).toContain("<label>lead</label>");
    expect(label).toContain("<label>vip</label>");
    const attr = byName(tools, "set_custom_attribute").description ?? "";
    // Conversation list attribute lists its allowed values; contact attribute key is shown too. Both
    // are rendered as XML <attribute> elements whose `key` mirrors the tool's key arg.
    expect(attr).toContain(
      '<attribute key="lead_stage" values="new|qualified"/>',
    );
    expect(attr).toContain('<attribute key="plano"/>');
  });

  test("set_custom_attribute contact scope without a contact in ctx → safe message", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 7 });
    const out = String(
      await byName(tools, "set_custom_attribute").invoke({
        key: "plano",
        value: "Pro",
        scope: "contact",
      }),
    );
    expect(out.toLowerCase()).toContain("no contact in scope");
    // Nothing was written (no base/contact wired in this pure ctx).
    expect(calls).toEqual([]);
  });
});

describe("handoff targeting", () => {
  function targetingClient(
    agents: Array<{ id: number; name: string }> = [],
    teams: Array<{ id: number; name: string }> = [],
  ) {
    const calls: Array<[string, unknown[]]> = [];
    const rec =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, args]);
        return {};
      };
    const client = {
      sendPrivateNote: rec("sendPrivateNote"),
      toggleStatus: rec("toggleStatus"),
      assignToAgent: rec("assignToAgent"),
      assignTeam: rec("assignTeam"),
      listAgents: async () => agents,
      listTeams: async () => teams,
    } as unknown as ChatwootClient;
    return { client, calls };
  }

  test("route mode opens but does not assign (Chatwoot routes)", async () => {
    const { client, calls } = targetingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "route",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
    });
    await byName(tools, "handoff_to_human").invoke({});
    expect(calls.map((c) => c[0])).toEqual(["toggleStatus"]);
  });

  test("pinned mode assigns the configured agent", async () => {
    const { client, calls } = targetingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "pinned",
        targetAgentId: 7,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
    });
    await byName(tools, "handoff_to_human").invoke({});
    expect(calls).toContainEqual(["assignToAgent", [5, 7]]);
  });

  test("pinned mode assigns the configured team when no agent is set", async () => {
    const { client, calls } = targetingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "pinned",
        targetAgentId: null,
        targetTeamId: 3,
        targetInstanceId: null,
        instructions: null,
      },
    });
    await byName(tools, "handoff_to_human").invoke({});
    expect(calls).toContainEqual(["assignTeam", [5, 3]]);
  });

  test("agent_choice resolves the model's name to an agent", async () => {
    const { client, calls } = targetingClient(
      [{ id: 9, name: "Maria" }],
      [{ id: 2, name: "Vendas" }],
    );
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "agent_choice",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
    });
    await byName(tools, "handoff_to_human").invoke({ assignTo: "maria" });
    expect(calls).toContainEqual(["assignToAgent", [5, 9]]);
  });

  test("agent_choice resolves the model's name to a team", async () => {
    const { client, calls } = targetingClient(
      [{ id: 9, name: "Maria" }],
      [{ id: 2, name: "Vendas" }],
    );
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "agent_choice",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
    });
    await byName(tools, "handoff_to_human").invoke({ assignTo: "Vendas" });
    expect(calls).toContainEqual(["assignTeam", [5, 2]]);
  });

  test("agent_choice with an unknown name does not assign", async () => {
    const { client, calls } = targetingClient([{ id: 9, name: "Maria" }]);
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "agent_choice",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
    });
    await byName(tools, "handoff_to_human").invoke({ assignTo: "Ninguém" });
    expect(
      calls.some((c) => c[0] === "assignToAgent" || c[0] === "assignTeam"),
    ).toBe(false);
  });

  test("agent_choice lists the grounded target names in the tool description", () => {
    const { client } = targetingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "agent_choice",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
      handoffTargets: {
        agents: [{ id: 9, name: "Maria" }],
        teams: [{ id: 2, name: "Vendas" }],
      },
    });
    const desc = byName(tools, "handoff_to_human").description ?? "";
    // The targets are surfaced as an XML block (valid values for the assignTo arg).
    expect(desc).toContain("<handoff_targets>");
    expect(desc).toContain("<agent>Maria</agent>");
    expect(desc).toContain("<team>Vendas</team>");
  });

  test("agent_choice resolves from pre-fetched targets without a live fetch", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const rec =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, args]);
        return {};
      };
    const client = {
      sendPrivateNote: rec("sendPrivateNote"),
      toggleStatus: rec("toggleStatus"),
      assignToAgent: rec("assignToAgent"),
      assignTeam: rec("assignTeam"),
      // Must NOT be hit when targets are pre-resolved — throwing makes a regression fail loudly.
      listAgents: async () => {
        throw new Error("listAgents should not be called when pre-resolved");
      },
      listTeams: async () => {
        throw new Error("listTeams should not be called when pre-resolved");
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "agent_choice",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
      handoffTargets: { agents: [{ id: 9, name: "Maria" }], teams: [] },
    });
    await byName(tools, "handoff_to_human").invoke({ assignTo: "maria" });
    expect(calls).toContainEqual(["assignToAgent", [5, 9]]);
  });

  test("agent_choice with an unknown name posts a private note (no silent no-op)", async () => {
    const { client, calls } = targetingClient([{ id: 9, name: "Maria" }]);
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "agent_choice",
        targetAgentId: null,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
      handoffTargets: { agents: [{ id: 9, name: "Maria" }], teams: [] },
    });
    await byName(tools, "handoff_to_human").invoke({ assignTo: "Ninguém" });
    expect(
      calls.some((c) => c[0] === "assignToAgent" || c[0] === "assignTeam"),
    ).toBe(false);
    expect(calls.some((c) => c[0] === "sendPrivateNote")).toBe(true);
  });

  const guidanceKanban = {
    taskId: 11,
    boardId: 2,
    boardName: "Vendas SDR",
    currentStepId: 7,
    currentStepName: "Novo Lead",
    steps: [
      { id: 7, name: "Novo Lead" },
      { id: 22, name: "Ganho" },
    ],
    card: {
      title: "Lead 1",
      description: null,
      priority: null,
      status: "open",
      value: null,
      startDate: null,
      dueDate: null,
      attributes: {},
      labels: [],
    },
  };

  test("description order is base text → operator guidance → XML context block", () => {
    const { client } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: guidanceKanban,
      toolInstructions: {
        handoff_to_human: "Transfira só após 2 tentativas frustradas.",
        kanban_move_card: "Só mova para Ganho com pagamento confirmado.",
      },
    });
    const handoff = byName(tools, "handoff_to_human").description ?? "";
    const kanban = byName(tools, "kanban_move_card").description ?? "";
    expect(handoff).toContain(
      "Operator guidance: Transfira só após 2 tentativas frustradas.",
    );
    expect(kanban).toContain(
      "Operator guidance: Só mova para Ganho com pagamento confirmado.",
    );
    // The note never shadows the core capability: the base text precedes it.
    expect(handoff.indexOf("Escalate")).toBeLessThan(
      handoff.indexOf("Operator guidance:"),
    );
    expect(kanban.indexOf("Move this conversation")).toBeLessThan(
      kanban.indexOf("Operator guidance:"),
    );
    // ...and the live XML context block comes LAST, after the operator guidance.
    expect(kanban.indexOf("Operator guidance:")).toBeLessThan(
      kanban.indexOf("<kanban_card"),
    );
  });

  test("no operator guidance leaves the descriptions free of the marker", () => {
    const { client } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      kanban: guidanceKanban,
    });
    expect(byName(tools, "handoff_to_human").description ?? "").not.toContain(
      "Operator guidance:",
    );
    expect(byName(tools, "kanban_move_card").description ?? "").not.toContain(
      "Operator guidance:",
    );
  });
});

// NOTE: A side effect that fails INSIDE a tool that still returns success (issue #46) must reach
// ctx.onSideEffectError so prepare.ts can surface it as a flowlog warn — while the tool's return
// value (what the model sees) stays a success.
describe("swallowed side effects reach onSideEffectError (issue #46)", () => {
  type SideEffect = {
    tool: string;
    phase: string;
    detail?: Record<string, unknown>;
    err: unknown;
  };

  test("handoff assignment failure reports phase assign and still hands off", async () => {
    const calls: string[] = [];
    const client = {
      toggleStatus: async () => {
        calls.push("toggleStatus");
        return {};
      },
      assignToAgent: async () => {
        throw new Error("Chatwoot 500 on assign");
      },
    } as unknown as ChatwootClient;
    const effects: SideEffect[] = [];
    const tools = buildNativeTools({
      client,
      conversationId: 5,
      handoff: {
        mode: "pinned",
        targetAgentId: 7,
        targetTeamId: null,
        targetInstanceId: null,
        instructions: null,
      },
      onSideEffectError: (e) => effects.push(e),
    });
    const out = String(await byName(tools, "handoff_to_human").invoke({}));
    expect(out).toContain("Handed off to a human");
    expect(calls).toContain("toggleStatus");
    expect(effects).toHaveLength(1);
    expect(effects[0]?.tool).toBe("handoff_to_human");
    expect(effects[0]?.phase).toBe("assign");
    expect(effects[0]?.err).toBeInstanceOf(Error);
  });

  test("set_custom_attribute mirror write-through failure reports phase mirror_write after the Chatwoot write", async () => {
    const { client, calls } = recordingClient();
    const effects: SideEffect[] = [];
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      tenantId: 1n,
      // A garbage base makes the scoped write-through throw — the exact swallowed path.
      base: {} as unknown as PrismaClient,
      conversationDbId: 5n,
      onSideEffectError: (e) => effects.push(e),
    });
    const out = String(
      await byName(tools, "set_custom_attribute").invoke({
        key: "plano",
        value: "Pro",
        scope: "conversation",
      }),
    );
    expect(out).toBe("Conversation attribute plano set.");
    expect(calls.map((c) => c[0])).toEqual(["setConversationCustomAttributes"]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      tool: "set_custom_attribute",
      phase: "mirror_write",
      detail: { scope: "conversation", key: "plano" },
    });
  });

  test("kanban_move_card outbound-emit failure reports phase outbound_emit and the move sticks", async () => {
    const { client, calls } = recordingClient();
    const effects: SideEffect[] = [];
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      tenantId: 1n,
      base: {} as unknown as PrismaClient,
      kanban: {
        taskId: 11,
        boardId: 2,
        boardName: "Vendas SDR",
        currentStepId: 7,
        currentStepName: "Novo Lead",
        steps: [
          { id: 7, name: "Novo Lead" },
          { id: 22, name: "Ganho" },
        ],
        card: {
          title: "Lead 1",
          description: null,
          priority: null,
          status: "open",
          value: null,
          startDate: null,
          dueDate: null,
          attributes: {},
          labels: [],
        },
      },
      onSideEffectError: (e) => effects.push(e),
    });
    const out = String(
      await byName(tools, "kanban_move_card").invoke({ targetStep: "Ganho" }),
    );
    expect(out).toBe('Moved the card to "Ganho".');
    expect(calls.map((c) => c[0])).toEqual(["moveKanbanTask"]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      tool: "kanban_move_card",
      phase: "outbound_emit",
    });
  });
});

// Two facts, two fields, and the predicate needs both. They happen to be written in the same block
// today, which is exactly why the table exists: the block that writes them was MOVED here by review
// (the line used to be recorded on the way into the tool, so a first attempt that threw left its
// promise behind for the retry to deliver in place of the recovery text the model wrote instead).
// A caller that reads only "there is a line" would deliver that promise again.
describe("handoffAnsweredTheTurn", () => {
  const rows: [string, HandoffTurnState | undefined, boolean][] = [
    ["no handoff state at all", undefined, false],
    [
      "a transfer that promised nothing",
      { customerMessage: null, completed: true } as HandoffTurnState,
      false,
    ],
    [
      "a promise whose transfer never completed",
      {
        customerMessage: "já te encaminho",
        completed: false,
      } as HandoffTurnState,
      false,
    ],
    [
      "a completed transfer that promised a line",
      {
        customerMessage: "já te encaminho",
        completed: true,
      } as HandoffTurnState,
      true,
    ],
  ];
  for (const [name, state, expected] of rows) {
    test(`${name} → ${expected}`, () => {
      expect(handoffAnsweredTheTurn(state)).toBe(expected);
    });
  }
});

// The design line drawn after PR #485: the model never authors code. Computation it must not redo
// is an operator-authored code tool (tools/code.ts), so no native tool may take a `code` argument —
// the shape a "run this snippet" tool has, whatever it is called.
describe("no native tool takes code from the model", () => {
  test("every native tool's schema is free of a `code` field, and no native is named run_code", () => {
    const tools = buildNativeTools({
      client: recordingClient().client,
      conversationId: 1,
    });
    expect(tools.map((t) => t.name)).not.toContain("run_code");
    for (const t of tools) {
      const shape =
        (t.schema as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape), t.name).not.toContain("code");
    }
    expect(NATIVE_TOOL_NAMES).not.toContain("run_code");
  });
});
