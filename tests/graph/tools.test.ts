import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  buildNativeTools,
  type HandoffTurnState,
  handoffAnsweredTheTurn,
  NATIVE_TOOL_NAMES,
} from "@/graph/tools/native";
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

  test("assign_label appends to the existing labels (read-modify-write)", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["vip"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({ client, conversationId: 9 });
    const out = String(
      await byName(tools, "assign_label").invoke({ label: "lead" }),
    );
    expect(setCalls).toEqual([[9, ["vip", "lead"]]]);
    expect(out).toContain("lead");
  });

  test("assign_label is a no-op when the label is already present", async () => {
    let setCount = 0;
    const client = {
      getConversationLabels: async () => ["vip"],
      setConversationLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({ client, conversationId: 9 });
    await byName(tools, "assign_label").invoke({ label: "vip" });
    expect(setCount).toBe(0);
  });

  test("assign_label task scope appends to the card's labels (snapshot read + write)", async () => {
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
      await byName(tools, "assign_label").invoke({
        label: "quente",
        scope: "task",
      }),
    );
    expect(setCalls).toEqual([[11, ["quente"]]]);
    expect(out.toLowerCase()).toContain("card");
  });

  test("assign_label task scope is offered only when a card is linked", () => {
    const { client } = recordingClient();
    const withCard = byName(
      buildNativeTools({ client, conversationId: 9, kanban: kanbanCtx }),
      "assign_label",
    ).description;
    const without = byName(
      buildNativeTools({ client, conversationId: 9 }),
      "assign_label",
    ).description;
    expect(withCard).toContain("kanban card");
    expect(without ?? "").not.toContain("kanban card");
  });

  test("assign_label contact scope without a contact in ctx → safe message (no write)", async () => {
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
      await byName(tools, "assign_label").invoke({
        label: "lead",
        scope: "contact",
      }),
    );
    expect(setCount).toBe(0);
    expect(out.toLowerCase()).toContain("contact");
  });

  test("operator guidance reaches set_custom_attribute + assign_label descriptions", () => {
    const { client } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      toolInstructions: {
        set_custom_attribute: "Sempre grave a etapa do funil em lead_stage.",
        assign_label: "Use 'vip' só para clientes premium.",
      },
    });
    expect(byName(tools, "set_custom_attribute").description ?? "").toContain(
      "Operator guidance: Sempre grave a etapa do funil em lead_stage.",
    );
    expect(byName(tools, "assign_label").description ?? "").toContain(
      "Operator guidance: Use 'vip' só para clientes premium.",
    );
  });

  test("vocab grounds the assign_label + set_custom_attribute descriptions", () => {
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
    const label = byName(tools, "assign_label").description ?? "";
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
