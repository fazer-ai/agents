import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import { modelVisibleLabels, SHOWN_LABELS_MAX } from "@/graph/tools/label-view";
import {
  applyLabelDelta,
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

// A base whose only answer is the contact row the contact scope looks up: runScopedOn calls
// `$extends` and then `$transaction`, and nothing here touches Postgres.
function fakeContactDb(chatwootContactId: number): PrismaClient {
  const tx = {
    $executeRaw: async () => 0,
    contact: { findUnique: async () => ({ chatwootContactId }) },
  };
  return {
    $extends: () => ({
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    }),
  } as unknown as PrismaClient;
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

  // ISSUE #662. The tool used to accept a transfer with nothing to say AND tell the model, in the
  // same breath, that the bot would stay silent now. So the one case the runtime's own fallback
  // exists for — `handoffAnsweredTheTurn` requires a line AND a completed transfer, precisely so the
  // model's next hop can speak when there is no line — was the case where the tool told the model
  // not to speak. Measured by the reporter on an email inbox: 2 of 130 turns ended with the
  // conversation transferred, a note filed, and nothing at all for the customer.
  //
  // Two halves, and the second is what makes the first provable: the argument is REQUIRED, so
  // forgetting it is not a way to reach silence, and an empty string is how silence is DECLARED —
  // which is also the only way an operator can tell a decision from an oversight, since the tool's
  // log line reports `string(0)` for a declared empty and nothing at all for an omitted argument.
  test("a transfer cannot be silent by omission, and says what it will do in each case", async () => {
    const { client } = recordingClient();
    const speaking = byName(
      buildNativeTools({ client, conversationId: 42 }),
      "handoff_to_human",
    );
    // REQUIRED on the speaking branch. The schema is the fence; the refusal text below is what the
    // model actually reads, and it has to name the argument rather than just say "invalid input".
    await expect(
      speaking.invoke({ reason: "cliente pediu humano" }),
    ).rejects.toThrow(/customerMessage/);

    const withLine = String(
      await speaking.invoke({ customerMessage: "Um humano continua daqui." }),
    );
    const declaredSilent = String(
      await speaking.invoke({ customerMessage: "" }),
    );
    // Neither branch may carry an instruction to stay silent: that sentence is what the model obeyed.
    for (const out of [withLine, declaredSilent])
      expect(out.toLowerCase()).not.toContain("stay silent");
    // And each says what actually happens to the customer, so the model does not have to guess
    // whether its own next line is wanted.
    expect(withLine).toContain("will be delivered to the customer");
    expect(declaredSilent).toContain("No message will be sent");

    // The muted branch has no argument at all, so its note is not about a decision the model made:
    // it states the topology. Same requirement, though, that it does not read as an instruction.
    const muted = byName(
      buildNativeTools({
        client: { ...client, muted: true } as unknown as ChatwootClient,
        conversationId: 42,
      }),
      "handoff_to_human",
    );
    const silentTurn = String(await muted.invoke({}));
    expect(silentTurn.toLowerCase()).not.toContain("stay silent");
    expect(silentTurn).toContain("nothing is sent to them");

    // And on the OTHER shape, the one that carries `assignTo`. The field is defined once for both,
    // but it was written twice first, and a mutation restoring `.optional()` on this copy survived
    // the whole suite because nothing exercised this branch.
    const routing = byName(
      buildNativeTools({
        client,
        conversationId: 42,
        handoff: {
          mode: "agent_choice",
          targetAgentId: null,
          targetTeamId: null,
          targetInstanceId: null,
          instructions: null,
        },
      }),
      "handoff_to_human",
    );
    expect(Object.keys((routing.schema as { shape: object }).shape)).toContain(
      "assignTo",
    );
    await expect(
      routing.invoke({ reason: "cliente pediu humano" }),
    ).rejects.toThrow(/customerMessage/);
  });

  test("a MUTED turn is not told to write a message the transfer will not send", () => {
    // The line is RECORDED on `handoffState` for the caller to deliver, and an observation has no
    // `handoffState` and throws its final output away: the transfer happens and the customer hears
    // nothing. Promising otherwise makes the model hand over believing they were answered
    // (review round 35).
    const { client } = recordingClient();
    const speaking = byName(
      buildNativeTools({ client, conversationId: 1 }),
      "handoff_to_human",
    );
    expect(speaking.description).toContain("customerMessage");
    expect(Object.keys((speaking.schema as { shape: object }).shape)).toContain(
      "customerMessage",
    );
    const muted = byName(
      buildNativeTools({
        client: { ...client, muted: true } as unknown as ChatwootClient,
        conversationId: 1,
      }),
      "handoff_to_human",
    );
    expect(muted.description).not.toContain("customerMessage");
    expect(muted.description).toContain("silent to them");
    expect(
      Object.keys((muted.schema as { shape: object }).shape),
    ).not.toContain("customerMessage");
  });

  test("the delta names the scope's own labels, not the conversation's", () => {
    // The delta applies to the SCOPE the call chooses, so a description that always named the
    // conversation's labels would show a `contact` call the wrong list — and copying them onto the
    // contact is the move that invites (review round 35). Under #695 the listing is per scope and
    // labelled with it, and the prose around it never says "conversation".
    const { client } = recordingClient();
    const tool = byName(
      buildNativeTools({
        client,
        conversationId: 1,
        shownLabels: { conversation: ["vip"], contact: [] },
      }),
      "set_labels",
    );
    const shape = (
      tool.schema as {
        shape: {
          add: { description?: string };
          remove: { description?: string };
        };
      }
    ).shape;
    expect(shape.add.description).toContain("conversation: vip");
    expect(shape.add.description).toContain("contact: (none)");
    // The scope that was never read is not reported as empty: absent is not none.
    expect(shape.add.description).not.toContain("task");
    // Scope-neutral: what stays is "already on the scope", never "on the conversation".
    expect(shape.add.description).toContain("already on the scope stays");
    expect(shape.remove.description).toContain(
      "a label you do not name here is kept",
    );
  });

  test("a ONE-SHOT allowlist grants what it names, not what the first candidate leaves", () => {
    // The parameter is an `Iterable<string>`, and a generator is spent by whoever reads it first.
    // Read once per candidate, it would be exhausted while testing a tool nobody granted, and the
    // agent would come up with an empty toolset — silently, with every grant in place
    // (review round 30).
    const { client } = recordingClient();
    function* granted(): Generator<string> {
      yield "private_note";
      yield "set_labels";
    }
    const tools = buildNativeTools(
      { client, conversationId: 1 },
      granted(),
    ).map((t) => t.name);
    expect(tools.sort()).toEqual(["private_note", "set_labels"]);
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
      customerMessage: "",
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
    await byName(tools, "handoff_to_human").invoke({ customerMessage: "" });
    expect(calls).toEqual([["toggleStatus", [42, "open"]]]);
  });

  test("transferWithSummary:false suppresses the note even when a reason is given", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      transferWithSummary: false,
    });
    await byName(tools, "handoff_to_human").invoke({
      reason: "summary text",
      customerMessage: "",
    });
    expect(calls).toEqual([["toggleStatus", [42, "open"]]]);
  });

  test("transferWithSummary:true (explicit) still posts the note", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 42,
      transferWithSummary: true,
    });
    await byName(tools, "handoff_to_human").invoke({
      reason: "summary text",
      customerMessage: "",
    });
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
      // The third argument carries the fence the client asks INSIDE its queue (round 25); this ctx
      // has none to offer, so it arrives undefined and the write proceeds.
      [
        "setConversationCustomAttributes",
        [7, { stage: "lead" }, { stillWanted: undefined }],
      ],
      ["toggleStatus", [7, "resolved"]],
    ]);
  });

  test("a /reset landing while resolve_conversation reads does NOT close the conversation", async () => {
    // The close reads the live status first (a WAIT), and the graph's ask at the tool boundary
    // happened before it. An observation holds no thread claim, so `/reset` can land in that window
    // — and a close is not something a later turn undoes. Same rule set_labels applies inside its
    // queue, asked in the one other place that waits before writing (round 17).
    const { client, calls } = recordingClient();
    let asked = 0;
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      tenantId: 1n,
      conversationDbId: 5n,
      observed: { status: "open", statusAt: null },
      // Wanted when the graph asked; withdrawn by the time the read came back.
      stillWanted: async () => {
        asked++;
        return false;
      },
    });
    const out = String(await byName(tools, "resolve_conversation").invoke({}));
    expect(asked).toBe(1);
    expect(out).toContain("called off");
    expect(calls.map((c) => c[0])).not.toContain("toggleStatus");
  });

  test("a /reset landing while the handoff note is in flight stops the routing change", async () => {
    // The third handler in this file that waits before writing. The note is already filed and stays
    // filed; what the fence stops is the pair after it — the status change out of `pending` and the
    // assignment — which is a routing change on an episode the operator was just told was cleared.
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      stillWanted: async () => false,
    });
    const out = String(
      await byName(tools, "handoff_to_human").invoke({
        reason: "resumo",
        customerMessage: "",
      }),
    );
    expect(calls.map((c) => c[0])).toEqual(["sendPrivateNote"]);
    expect(out).toContain("called off");
    expect(out).toContain("already filed");
  });

  test("without a note there is no wait, so the handoff is unchanged", async () => {
    // The fence is asked only where a wait happened. A handoff with no summary writes straight
    // through, exactly as before.
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      stillWanted: async () => false,
    });
    await byName(tools, "handoff_to_human").invoke({ customerMessage: "" });
    expect(calls.map((c) => c[0])).toContain("toggleStatus");
  });

  test("a fence that cannot answer is not a withdrawal, and the close proceeds", async () => {
    // Only an explicit `false` stops it: an unreadable fence is not the operator saying no, and
    // treating it as one would throw away a turn already paid for.
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      stillWanted: async () => true,
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls.map((c) => c[0])).toContain("toggleStatus");
  });

  // ISSUE #671. The tool has two modes and the rule was written in only one of them: with a
  // `turnState` the intent is deferred and the reactive runtime drops it when a transfer completed
  // ("a conversation the human queue now owns is not ours to close", #159), and WITHOUT one the tool
  // closes inside the call, which is every proactive turn and every observation. Asked here, on the
  // tool, because that is the one place both modes pass through, and because the observer builds its
  // own toolset: a guard written in either runtime would leave it out.
  //
  // Both directions matter. A transfer that completed blocks the close AND says so, so the model
  // reads what happened; a turn with no transfer at all still closes, which is the ordinary case and
  // what a guard written too wide would break.
  test("resolve_conversation refuses to close what this turn transferred", async () => {
    const { client, calls } = recordingClient();
    const handoffState = {
      customerMessage: null as string | null,
      completed: false,
      declinedToSpeak: false,
    };
    const tools = buildNativeTools({ client, conversationId: 7, handoffState });
    // No transfer yet: the legacy immediate close is untouched.
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls.map((c) => c[0])).toContain("toggleStatus");

    calls.length = 0;
    await byName(tools, "handoff_to_human").invoke({ customerMessage: "" });
    expect(handoffState.completed).toBe(true);
    calls.length = 0;
    const out = String(await byName(tools, "resolve_conversation").invoke({}));
    expect(calls).toEqual([]);
    expect(out).toMatch(/[Dd]id not resolve/);
    expect(out).toContain("transferred");
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

  // REWRITTEN, NOT DELETED (issue #695). Every case below is the counterpart of one that proved the
  // replace contract: what each of those proved about a diff against `shown`, its counterpart proves
  // about a delta the model names. Two of them INVERT, and those are the ones worth reading.
  describe("applyLabelDelta", () => {
    test("only what is NAMED in remove is removed", () => {
      // The counterpart of "only what was SHOWN and left out is removed". `c` survives here for a
      // stronger reason than it did there: not because it was unseen, but because nobody named it.
      expect(applyLabelDelta([], ["b"], ["a", "b", "c"])).toEqual({
        next: ["a", "c"],
        added: [],
        removed: ["b"],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("removing a label the conversation no longer carries reports nothing removed", () => {
      // Somebody took `b` off between the read and the write. The report is about what THIS write
      // did, and it did not remove anything.
      expect(applyLabelDelta([], ["b"], ["a"])).toEqual({
        next: ["a"],
        added: [],
        removed: [],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("blank and duplicate entries are dropped, and order is stable", () => {
      expect(
        applyLabelDelta(["  vip ", "vip", "", "   ", "lead"], [], []),
      ).toEqual({
        next: ["vip", "lead"],
        added: ["vip", "lead"],
        removed: [],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("INVERTED: naming a label in add DOES put it back after somebody removed it", () => {
      // The case that flips. Under the replace contract the model repeated `vip` only because
      // leaving it out would delete it, so treating the repeat as an addition undid an operator who
      // had just peeled it off — and the tool deliberately did not. Under the delta contract nothing
      // forces the model to mention a label it does not mean, so naming one in `add` IS a request to
      // have it, and honouring that is correct. The cost moved to the operator's prose: a prompt
      // that still says "repeat the labels that are already there" now asks for exactly this
      // (holdout s14), which is why the old shape is refused by name rather than best-effort.
      expect(applyLabelDelta(["vip", "lead"], [], [])).toEqual({
        next: ["vip", "lead"],
        added: ["vip", "lead"],
        removed: [],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("naming nothing changes nothing, whatever is standing", () => {
      // The counterpart of "an empty desired list with nothing shown writes nothing at all". There
      // the clear-everything call and the never-read case had to be told apart, because `[]` could
      // mean either; here `[]` can only mean "I name nothing", and wiping a conversation requires
      // naming every label on it.
      expect(applyLabelDelta([], [], ["a", "b"])).toEqual({
        next: ["a", "b"],
        added: [],
        removed: [],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("INVERTED: a guarded label is no longer removed by silence, because silence removes nothing", () => {
      // The defect the guard was built for does not exist under this contract. Measured on a live
      // fork under the old one: asked for `["compra-de-ingresso"]`, the tool answered
      // `removed "cancelamento", "agente-off", "vip"` — three labels the model never mentioned. Here
      // the same intent leaves every one of them standing without the guard doing anything at all,
      // which is why the guard's remaining job is the two directions below.
      expect(
        applyLabelDelta(
          ["compra-de-ingresso"],
          [],
          ["cancelamento", "agente-off"],
        ),
      ).toEqual({
        next: ["cancelamento", "agente-off", "compra-de-ingresso"],
        added: ["compra-de-ingresso"],
        removed: [],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("a guarded label the model ASKS FOR is not added, and the refusal is named", () => {
      // The half the issue's own first draft dropped. A model that learned the name from the
      // operator's prompt could otherwise switch the agent off by naming the label, which is the
      // authority the guard denies — and now that it can SEE the label, it will ask.
      expect(
        applyLabelDelta(["agente-off", "vip"], [], [], ["agente-off"]),
      ).toEqual({
        next: ["vip"],
        added: ["vip"],
        removed: [],
        refusedAdd: ["agente-off"],
        refusedRemove: [],
        heldRemove: [],
      });
    });

    test("a guarded label the model asks to REMOVE is not removed, and the refusal is named", () => {
      expect(
        applyLabelDelta(
          [],
          ["agente-off"],
          ["agente-off", "vip"],
          ["agente-off"],
        ),
      ).toEqual({
        next: ["agente-off", "vip"],
        added: [],
        removed: [],
        refusedAdd: [],
        refusedRemove: ["agente-off"],
        heldRemove: [],
      });
    });

    test("a guarded label standing on the scope is KEPT in next, and is no longer hidden", () => {
      // `next` carries it because it is on the conversation; there is no `visible` projection any
      // more, because the model is shown everything. That is the change: one list, not two.
      const out = applyLabelDelta(
        ["lead"],
        [],
        ["vip", "testando-agente"],
        ["testando-agente"],
      );
      expect(out.next).toEqual(["vip", "testando-agente", "lead"]);
      expect(out.removed).toEqual([]);
    });

    test("an empty guard list is the behaviour before the guard", () => {
      expect(applyLabelDelta([], ["b"], ["a", "b"], [])).toEqual({
        next: ["a"],
        added: [],
        removed: ["b"],
        refusedAdd: [],
        refusedRemove: [],
        heldRemove: [],
      });
    });
  });

  test("an add-only call never removes anything", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["vip"],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    // Under the delta there is nothing to leave out: `vip` is not named, so it is not touched,
    // and no snapshot of what the model saw has to be consulted to know that.
    const tools = buildNativeTools({ client, conversationId: 9 });
    const out = String(
      await byName(tools, "set_labels").invoke({ add: ["lead"] }),
    );
    expect(setCalls).toEqual([[9, ["vip", "lead"]]]);
    expect(out).toContain("lead");
  });

  test("set_labels removes exactly what `remove` names", async () => {
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
      await byName(tools, "set_labels").invoke({ remove: ["lead"] }),
    );
    expect(setCalls).toEqual([[9, ["vip"]]]);
    expect(out).toContain('removed "lead"');
  });

  test("set_labels does NOT erase a label added while the model was generating", async () => {
    // The whole reason the model names a delta: `agente-off` landed between the turn's read and
    // this call. The model never saw it and never named it, so it stays — with no snapshot, no
    // diff and no window in which a complete list could have taken it out and put the agent back
    // on a conversation somebody had just switched it off. The swap is named on both sides, which
    // is how the tool description tells the model to change a value.
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
    await byName(tools, "set_labels").invoke({
      add: ["cancelamento"],
      remove: ["dúvidas-evento"],
    });
    expect(setCalls).toEqual([[9, ["agente-off", "cancelamento"]]]);
  });

  test("set_labels refuses to remove a guarded label, and names the refusal", async () => {
    // The case above protects a label the model never named. This one it names explicitly, and only
    // the guard keeps it. Under the delta the model SEES the guarded label, so it will ask; an
    // answer that stayed silent would be a false statement the model reads back out of its own
    // transcript one call later, which is why the report says which one it refused.
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
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["dúvidas-evento", "agente-off"],
      }),
    );
    expect(setCalls).toEqual([[9, ["agente-off", "cancelamento"]]]);
    // Told, by name, which one did not move and why — the opposite of the old contract, where the
    // label was hidden and the silence is what made a fenced agent invent a name for it.
    expect(out).toContain('cannot be removed: "agente-off"');
    expect(out).toContain('removed "dúvidas-evento"');
  });

  test("a call that names neither side is refused, and writes nothing", async () => {
    // Under the replace contract an empty list was a MEANING — "clear the scope" — so it had to be
    // honoured. Under the delta it is the absence of a request, and honouring it would be inventing
    // one. The refusal is what tells the model to name what it wants.
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
    const out = String(
      await byName(tools, "set_labels").invoke({ add: [], remove: [] }),
    );
    expect(setCalls).toEqual([]);
    expect(out).toContain("neither `add` nor `remove`");
  });

  test("the retired `labels` list is refused BY NAME, not silently dropped", async () => {
    // Operator prose in five free-text fields still describes the replace contract on every tenant
    // that has not rewritten it, and a model following that prose sends `{labels: [...]}`. A strict
    // schema would strip the key and leave an empty delta, so the call would answer "already as
    // requested" and the model would record a classification that was never written.
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["vip"],
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
    const out = String(
      await byName(tools, "set_labels").invoke({ labels: ["cancelamento"] }),
    );
    expect(setCalls).toEqual([]);
    expect(out).toContain("no longer takes a complete `labels` list");
    expect(out.toLowerCase()).not.toContain("already as requested");
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
      await byName(tools, "set_labels").invoke({ add: ["vip"] }),
    );
    expect(setCount).toBe(0);
    expect(out.toLowerCase()).toContain("already as requested");
    // The resulting set is stated even when nothing moved: it is the model's only reading of the
    // scope after its own writes, since the description block is frozen at turn prep.
    expect(out).toContain('Now set: "vip"');
  });

  test("a second call in the same turn can undo what the first one wrote", async () => {
    // Each call names its own delta, so the second one does not depend on the first being
    // reflected back into any snapshot: it removes what it names off whatever is standing when the
    // queue lets it through.
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
      await byName(tools, "set_labels").invoke({ add: ["pending"] }),
    );
    expect(first).toContain('added "pending"');
    const second = String(
      await byName(tools, "set_labels").invoke({ remove: ["pending"] }),
    );
    expect(setCalls).toEqual([
      [9, ["pending"]],
      [9, []],
    ]);
    expect(second).toContain('removed "pending"');
    expect(second).toContain("Now set: (none)");
  });

  test("a label the model was never shown is removable the moment it names it", async () => {
    // `urgente` lands between the turn's read and the first call. Under the replace contract it had
    // to survive one write and be handed over by the report before it could be dropped, because
    // "shown" was what licensed a removal. Naming the delta retires that ceremony: not naming it
    // keeps it, naming it removes it, and neither answer depends on what the model was shown.
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
      await byName(tools, "set_labels").invoke({ add: ["compra"] }),
    );
    expect(setCalls[0]).toEqual([9, ["urgente", "compra"]]);
    expect(first).toContain('Now set: "urgente", "compra"');
    await byName(tools, "set_labels").invoke({ remove: ["urgente"] });
    expect(setCalls).toHaveLength(2);
    expect(setCalls[1]).toEqual([9, ["compra"]]);
  });

  test("two calls in ONE batch do not read each other's writes", async () => {
    // LangGraph dispatches a tool-call batch concurrently, and the write is still a full PUT of the
    // resulting list, so the queue is what makes the second call read the first one's result. Drop
    // the serialisation and both read the empty scope, both PUT a one-item list, and `["a"]` beside
    // `["b"]` ends as whichever landed last.
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
      tool.invoke({ add: ["a"] }),
      tool.invoke({ add: ["b"] }),
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
      tool.invoke({ add: ["a"] }, batch),
      tool.invoke({ add: ["b"] }, batch),
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
      await byName(tools, "set_labels").invoke({ add: ["cancelamento"] }),
    );
    expect(setCount).toBe(0);
    expect(out).toContain("called off");
  });

  test("set_labels task scope reads the card fresh and writes it", async () => {
    const setCalls: unknown[][] = [];
    const client = {
      getKanbanTask: async () => ({ labels: [] }),
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
        add: ["quente"],
        scope: "task",
      }),
    );
    expect(setCalls).toEqual([[11, ["quente"]]]);
    expect(out.toLowerCase()).toContain("card");
  });

  test("a label added to the card mid-turn survives, like in the other two scopes", async () => {
    // ISSUE #695 HOLDOUT s6. The card used to be the turn-prep snapshot, so "not named, not
    // touched" was a statement about that snapshot and not about the card: a label somebody put on
    // it while the model was generating was erased by the next write. It is the one scope where the
    // promise the whole change is built on was false, and one GET by id closes it — the id is in
    // hand here, unlike at prep, where the card has to be resolved from the conversation.
    const setCalls: unknown[][] = [];
    const client = {
      // The card moved after prep: `externa` is on it now and the snapshot never saw it.
      getKanbanTask: async () => ({ labels: ["fila-1", "externa"] }),
      setKanbanTaskLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      kanban: { ...kanbanCtx, card: { ...kanbanCtx.card, labels: ["fila-1"] } },
    });
    await byName(tools, "set_labels").invoke({
      add: ["urgente"],
      scope: "task",
    });
    expect(setCalls).toEqual([[11, ["fila-1", "externa", "urgente"]]]);
  });

  test("a card that cannot be read refuses the write instead of using the snapshot", async () => {
    // Falling back to the snapshot would reintroduce the erasure silently, on the one path where
    // nobody is looking. The conversation scope answers an unreadable state the same way.
    let setCount = 0;
    const client = {
      getKanbanTask: async () => {
        throw new Error("chatwoot 500");
      },
      setKanbanTaskLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      kanban: kanbanCtx,
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["quente"],
        scope: "task",
      }),
    );
    expect(setCount).toBe(0);
    expect(out).toContain("could not be read");
  });

  test("a card write withdrawn during the fresh read does not land", async () => {
    // The fresh read this PR added to the task scope is a WAIT, exactly like the GET the other two
    // scopes do: `/reset` can retire the run while it is in flight, and until this recheck the
    // task scope was the only one that wrote anyway, because the graph's dispatch check was the
    // last word before its POST. The fence is asked AFTER the read, not before it.
    let setCount = 0;
    let asked = 0;
    const client = {
      getKanbanTask: async () => ({ labels: ["fila-1"] }),
      setKanbanTaskLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      kanban: kanbanCtx,
      stillWanted: async () => {
        asked++;
        return false;
      },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["quente"],
        scope: "task",
      }),
    );
    expect(asked).toBe(1);
    expect(setCount).toBe(0);
    expect(out).toContain("called off");
  });

  test("a card write with nothing to change never reaches the fence", async () => {
    // Same rule the contact scope states: the fence guards a WRITE, and a call whose delta is
    // empty writes nothing, so withdrawing the run must not turn it into a refusal.
    let asked = 0;
    const client = {
      getKanbanTask: async () => ({ labels: ["fila-1"] }),
      setKanbanTaskLabels: async () => ({}),
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      kanban: kanbanCtx,
      stillWanted: async () => {
        asked++;
        return false;
      },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["fila-1"],
        scope: "task",
      }),
    );
    expect(asked).toBe(0);
    expect(out).not.toContain("called off");
  });

  test("a swap whose add is guarded writes NOTHING, and says the removal was held", async () => {
    // Issue #712, and the decision it asked for: A REMOVAL IS NOT APPLIED WHEN THE GUARD REFUSED
    // ANY ADDITION OF THE SAME CALL. Until this commit the removal landed alone, so a mutually
    // exclusive taxonomy ended the turn with NO category — measured identical on 5ae9af39, so the
    // delta contract did not introduce it, it made it routine by showing the model the guarded
    // label it now asks for.
    //
    // ONLY REMOVALS ARE HELD, never additions, which is what keeps this compatible with the two
    // sealed scenarios of #695 that a fully atomic call would have reversed: s8 (`add:
    // ["cancelamento", "reembolso"]` with `cancelamento` guarded must still write `reembolso`) and
    // s9 (a guarded REMOVE must still let its addition through, so the "both categories" direction
    // stays on purpose — see the sibling test below, which is not a bug this issue closes).
    const posts: unknown[][] = [];
    const client = {
      getConversationLabels: async () => [
        "compra-de-ingresso",
        "agente-off",
        "testando-agente",
      ],
      setConversationLabels: async (...a: unknown[]) => {
        posts.push(a);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["cancelamento"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(posts).toEqual([]);
    expect(out).toContain("cannot be added");
    expect(out).toContain("cancelamento");
    // The report is the second statement about the same fact and can lie on its own: the model
    // records it and decides the next turn from it. It must NOT read as a removal that happened.
    expect(out).not.toContain('removed "compra-de-ingresso"');
    expect(out.toLowerCase()).not.toContain("already as requested");
    // Named, because the model asked for this label and cannot guess where it ended up.
    expect(out).toContain('"compra-de-ingresso" stays');
  });

  test("a swap whose remove is guarded lands the addition alone, and says so", async () => {
    // The mirror, and the other state the single write exists to prevent: both categories at
    // once. Also identical on 5ae9af39 (POST carried all four).
    const posts: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["compra-de-ingresso", "agente-off"],
      setConversationLabels: async (...a: unknown[]) => {
        posts.push(a);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["compra-de-ingresso"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(posts).toEqual([
      [9, ["compra-de-ingresso", "agente-off", "cancelamento"]],
    ]);
    expect(out).toContain("cannot be removed");
    expect(out).toContain('added "cancelamento"');
  });

  test("a guard that holds the whole taxonomy refuses both halves and writes nothing", async () => {
    // The configuration that is actually correct: every mutually-exclusive value guarded. Both
    // halves fall, no POST goes out, and the two refusals are reported. The half-write lives in
    // the INCOMPLETE list, which is the condition of the 2026-09-17 incident.
    let posts = 0;
    const client = {
      getConversationLabels: async () => ["compra-de-ingresso", "agente-off"],
      setConversationLabels: async () => {
        posts++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["compra-de-ingresso", "cancelamento", "outros"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(posts).toBe(0);
    expect(out).toContain("cannot be added");
    expect(out).toContain("cannot be removed");
  });

  test("a free addition alongside a refused one lands, and the removal is STILL held", async () => {
    // The hole the issue's own proposal left open, and the reason this PR states the rule over ANY
    // refused addition rather than over a wholly refused `add`. "Classify it and mark it urgent"
    // is how an instruction produces `add: [category, "urgente"]`, and under the narrow rule the
    // guard would catch only the category, the `add` would not have fallen ENTIRELY, and the
    // removal would land alone — the same conversation with no category, reached by a call the
    // issue's table does not contain.
    const posts: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["compra-de-ingresso", "agente-off"],
      setConversationLabels: async (...a: unknown[]) => {
        posts.push(a);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["cancelamento"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento", "urgente"],
        remove: ["compra-de-ingresso"],
      }),
    );
    // `urgente` lands: only removals are held, so a free addition is never lost to a guarded one.
    expect(posts).toEqual([
      [9, ["compra-de-ingresso", "agente-off", "urgente"]],
    ]);
    expect(out).toContain('added "urgente"');
    expect(out).toContain('"compra-de-ingresso" stays');
    expect(out).not.toContain('removed "compra-de-ingresso"');
  });

  test("a call with no refused addition removes normally, including when it has no `add` at all", async () => {
    // THE CHEAPEST REGRESSION TO CAUSE AND THE MOST EXPENSIVE TO FIND. Written as "every label in
    // `add` was refused", the rule fires on an empty `add` — `[].every(…)` is true — and swallows
    // the removal of every remove-only call, which is the most common use of the tool and the one
    // an operator's prompt uses to take a wrong label off. The rule is over what the guard
    // REFUSED, so an empty `add` refuses nothing and holds nothing.
    for (const call of [
      { remove: ["compra-de-ingresso"] },
      { add: [], remove: ["compra-de-ingresso"] },
      { add: ["reembolso"], remove: ["compra-de-ingresso"] },
    ]) {
      const posts: unknown[][] = [];
      const client = {
        getConversationLabels: async () => ["compra-de-ingresso", "agente-off"],
        setConversationLabels: async (...a: unknown[]) => {
          posts.push(a);
          return {};
        },
      } as unknown as ChatwootClient;
      const tools = buildNativeTools({
        client,
        conversationId: 9,
        protectedLabels: ["cancelamento"],
      });
      const out = String(await byName(tools, "set_labels").invoke(call));
      expect(posts.length).toBe(1);
      expect(posts[0]?.[1]).not.toContain("compra-de-ingresso");
      expect(out).toContain('removed "compra-de-ingresso"');
      expect(out).not.toContain("stays");
    }
  });

  test("the same guarded label on both sides is refused once, and the report does not contradict itself", async () => {
    let posts = 0;
    const client = {
      getConversationLabels: async () => ["compra-de-ingresso", "agente-off"],
      setConversationLabels: async () => {
        posts++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["cancelamento"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["cancelamento"],
      }),
    );
    expect(posts).toBe(0);
    expect(out).toContain("cannot be added");
    expect(out).toContain("cannot be removed");
    // Nothing was held: the removal it names was refused by the guard on its own terms, so
    // claiming it "stays" because of the addition would be a second, wrong reason for the same
    // fact.
    expect(out).not.toContain("stays");
  });

  test("the rule is about the guard REFUSING an addition, not about the addition having no effect", async () => {
    // `add: ["a"]` where `a` is already standing asks for something and moves nothing, and #695's
    // s14 settled that naming a label already present is a legitimate request. Conditioning the
    // hold on "nothing was actually added" instead of "the guard refused an addition" would turn
    // that redundant request into a block on every removal beside it.
    const posts: unknown[][] = [];
    const client = {
      getConversationLabels: async () => ["a", "compra-de-ingresso"],
      setConversationLabels: async (...x: unknown[]) => {
        posts.push(x);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({ client, conversationId: 9 });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["a"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(posts).toEqual([[9, ["a"]]]);
    expect(out).toContain('removed "compra-de-ingresso"');
  });

  test("a held call holds its WHOLE removal, guarded half and free half alike", async () => {
    // The edge the issue raises and leaves open, decided here: the free half goes nowhere either.
    // The removal was asked for as one request, and applying the part of it the guard happens not
    // to cover would leave the conversation in a state nobody asked for — which is the thing the
    // rule exists to stop, not a smaller version of it. Both labels are named back, because the
    // model wrote both and cannot guess where either ended up.
    let posts = 0;
    const client = {
      getConversationLabels: async () => [
        "x",
        "compra-de-ingresso",
        "agente-off",
      ],
      setConversationLabels: async () => {
        posts++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["cancelamento", "x"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["x", "compra-de-ingresso"],
      }),
    );
    expect(posts).toBe(0);
    expect(out).toContain('cannot be removed: "x"');
    expect(out).toContain('"compra-de-ingresso" stays');
  });

  test("the hold belongs to the call that carried the refusal, and does not outlive it", async () => {
    // The cost of this design, stated rather than hidden: reading the refusal, the model can still
    // reach the no-category state with a second, removal-only call. What the rule buys is that it
    // never gets there WITHOUT asking, which is why the refusal names the label and gives the
    // reason. A hold that survived into the next call would be a different tool: the model would
    // lose removals it never tied to a guarded addition.
    let current = ["compra-de-ingresso", "agente-off"];
    const posts: unknown[][] = [];
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...a: unknown[]) => {
        posts.push(a);
        current = a[1] as string[];
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["cancelamento"],
    });
    await byName(tools, "set_labels").invoke({
      add: ["cancelamento"],
      remove: ["compra-de-ingresso"],
    });
    expect(posts).toEqual([]);
    await byName(tools, "set_labels").invoke({
      remove: ["compra-de-ingresso"],
    });
    await byName(tools, "set_labels").invoke({ add: ["urgente"] });
    expect(current).toEqual(["agente-off", "urgente"]);
  });

  test("the description states the hold, and only where there is a guard to hold for", () => {
    // The model has two places to learn this rule and must find it in one of them: here, before it
    // writes, or in the refusal after it (which carries the whole explanation either way). It is
    // stated here because the alternative is the model planning a swap it cannot complete and
    // paying a call to be told. It is NOT stated on an agent with no guard, where the rule can
    // never fire and the sentence would be context spent on nothing, every turn.
    const { client } = recordingClient();
    const guarded = byName(
      buildNativeTools({
        client,
        conversationId: 9,
        protectedLabels: ["agente-off"],
      }),
      "set_labels",
    ).description as string;
    expect(guarded).toContain("the call's `remove` is not applied either");
    const free = byName(
      buildNativeTools({ client, conversationId: 9 }),
      "set_labels",
    ).description as string;
    expect(free).not.toContain("is not applied either");
  });

  test("a hold names only what was actually standing", async () => {
    // The report claims an effect, so it is read off the scope rather than off the request. A
    // label the model asked to remove that is not there was going nowhere either way, and saying
    // it "stays" because of the hold would be the same lie as claiming a removal that never
    // happened, pointing the other way.
    const client = {
      getConversationLabels: async () => ["agente-off"],
      setConversationLabels: async () => ({}),
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["cancelamento"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento"],
        remove: ["nunca-esteve-aqui"],
      }),
    );
    expect(out).toContain("cannot be added");
    expect(out).not.toContain("stays");
  });

  test("a held call does not hold the OTHER call of the same batch", async () => {
    // The hold is a property of the call that carried the refused addition, and the queue is what
    // makes the other call of the batch read a world the first one did not change. Ten runs,
    // because a result that oscillates between runs means the serialisation stopped closing and
    // would read here as a flaky test rather than as the defect it is.
    for (let i = 0; i < 10; i++) {
      let current = ["compra-de-ingresso", "base"];
      const client = {
        getConversationLabels: async () => [...current],
        setConversationLabels: async (...args: unknown[]) => {
          current = [...(args[1] as string[])];
          return {};
        },
      } as unknown as ChatwootClient;
      const tool = byName(
        buildNativeTools({
          client,
          conversationId: 9,
          protectedLabels: ["cancelamento"],
        }),
        "set_labels",
      );
      await Promise.all([
        tool.invoke({ add: ["cancelamento"], remove: ["compra-de-ingresso"] }),
        tool.invoke({ add: ["urgente"], remove: ["base"] }),
      ]);
      expect([...current].sort()).toEqual(["compra-de-ingresso", "urgente"]);
    }
  });

  test("the hold applies in the contact scope too", async () => {
    let setCount = 0;
    const client = {
      getContactLabels: async () => ["compra-de-ingresso", "vip"],
      setContactLabels: async () => {
        setCount++;
        return {};
      },
      setConversationLabels: async () => {
        throw new Error(
          "a contact-scope call must never write the conversation",
        );
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      tenantId: 1n,
      contactDbId: 3n,
      base: fakeContactDb(55),
      protectedLabels: ["cancelamento"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        scope: "contact",
        add: ["cancelamento"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(setCount).toBe(0);
    expect(out).toContain('"compra-de-ingresso" stays');
  });

  test("the hold applies in the task scope, and leaves the card snapshot standing", async () => {
    let setCount = 0;
    const client = {
      getKanbanTask: async () => ({ labels: ["compra-de-ingresso", "fila-1"] }),
      setKanbanTaskLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const kanban = {
      ...kanbanCtx,
      card: { ...kanbanCtx.card, labels: ["compra-de-ingresso", "fila-1"] },
    };
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      kanban,
      protectedLabels: ["cancelamento"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        scope: "task",
        add: ["cancelamento"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(setCount).toBe(0);
    expect(out).toContain('"compra-de-ingresso" stays');
    // A second call in the same turn must start from the world that exists, not from the one the
    // refused call asked for.
    expect(kanban.card.labels).toEqual(["compra-de-ingresso", "fila-1"]);
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
        add: ["lead"],
        scope: "contact",
      }),
    );
    expect(setCount).toBe(0);
    expect(out.toLowerCase()).toContain("contact");
  });

  test("a /reset landing while the contact labels are read stops the contact write", async () => {
    // The FOURTH handler that waits before writing: the GET above is a wait exactly like the queue
    // the conversation scope waits on, and this scope has no queue to ask inside. A contact label
    // outlives the conversation it was written from, so a write admitted at the tool boundary and
    // landing after `/reset` is the one that survives longest (round 21).
    let setCount = 0;
    let asked = 0;
    const client = {
      getContactLabels: async () => ["vip"],
      setContactLabels: async () => {
        setCount++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      tenantId: 1n,
      contactDbId: 3n,
      base: fakeContactDb(55),
      stillWanted: async () => {
        asked++;
        return false;
      },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["lead"],
        scope: "contact",
      }),
    );
    expect(asked).toBe(1);
    expect(setCount).toBe(0);
    expect(out).toContain("called off");
  });

  test("a contact write with nothing to change never reaches the fence", async () => {
    // The fence guards a WRITE. A call whose diff is empty writes nothing, so withdrawing the run
    // must not turn it into a refusal — the model asked for the state that already stands.
    let asked = 0;
    const client = {
      getContactLabels: async () => ["vip"],
      setContactLabels: async () => ({}),
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      tenantId: 1n,
      contactDbId: 3n,
      base: fakeContactDb(55),
      shownLabels: { contact: ["vip"] },
      stillWanted: async () => {
        asked++;
        return false;
      },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["vip"],
        scope: "contact",
      }),
    );
    expect(asked).toBe(0);
    expect(out).not.toContain("called off");
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
    await byName(tools, "handoff_to_human").invoke({ customerMessage: "" });
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
    await byName(tools, "handoff_to_human").invoke({ customerMessage: "" });
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
    await byName(tools, "handoff_to_human").invoke({ customerMessage: "" });
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
    await byName(tools, "handoff_to_human").invoke({
      assignTo: "maria",
      customerMessage: "",
    });
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
    await byName(tools, "handoff_to_human").invoke({
      assignTo: "Vendas",
      customerMessage: "",
    });
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
    await byName(tools, "handoff_to_human").invoke({
      assignTo: "Ninguém",
      customerMessage: "",
    });
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
    await byName(tools, "handoff_to_human").invoke({
      assignTo: "maria",
      customerMessage: "",
    });
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
    await byName(tools, "handoff_to_human").invoke({
      assignTo: "Ninguém",
      customerMessage: "",
    });
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
    const out = String(
      await byName(tools, "handoff_to_human").invoke({ customerMessage: "" }),
    );
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

// EVERY handler that waits before writing has to ask the fence again, and this battery is what says
// so — three review rounds found three separate handlers breaking the rule one at a time (17, 21,
// 22), which is what a rule kept by reading rather than by a test looks like.
//
// THE RULE, in the form the trace below can check: the graph asks `stillWanted` at DISPATCH, so the
// first outward effect of a handler is covered by that ask. Everything after it happened AFTER a
// wait, and a write there must be fenced. With a fence that says no from the first wait onward, a
// correct handler makes at most one outward effect and it is never a write that came second.
//
// The client is a proxy over a classification rather than a stub: a method that is neither a read
// nor a write is recorded as UNKNOWN and fails the battery, so a client call added to a handler
// later cannot join the trace silently. Same for the tool table — it is asked to cover every name in
// the catalog, so a tool added later arrives with an entry or the suite says which one is missing.
describe("what the model is shown has a ceiling", () => {
  // Every other model-facing list in the file is capped; a conversation's own set was not, and it is
  // the one an automation can grow without an operator looking. Uncapped it lands in the observer's
  // prompt and TWICE in this tool's description, so a bulk-labelled conversation can push the whole
  // tick past the provider's context limit — and every retry of it fails the same way.
  const many = Array.from({ length: 90 }, (_, i) => `etq-${i}`);

  test("the description shows the ceiling, not the whole set", () => {
    const { client } = recordingClient();
    const desc =
      byName(
        buildNativeTools({
          client,
          conversationId: 9,
          shownLabels: { conversation: modelVisibleLabels(many) },
        }),
        "set_labels",
      ).description ?? "";
    expect(desc).toContain("etq-0");
    expect(desc).toContain(`etq-${SHOWN_LABELS_MAX - 1}`);
    expect(desc).not.toContain(`etq-${SHOWN_LABELS_MAX}`);
  });

  test("what falls off the end is untouched, because nothing unnamed is touched", async () => {
    // Why a ceiling is safe here, and the reason got SIMPLER with the delta (issue #695). It used to
    // rest on the diff: a label past the cut was not shown, so it could not be "shown and left out",
    // so it survived. Now it rests on the contract itself — a label the call does not name is not
    // touched — and the cut is a display decision with no reach into the write at all.
    const setCalls: unknown[][] = [];
    const client = {
      getConversationLabels: async () => many,
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: modelVisibleLabels(many) },
    });
    await byName(tools, "set_labels").invoke({ add: ["resolvido"] });
    const next = (setCalls[0]?.[1] ?? []) as string[];
    // All 90 stand — the 40 it was shown as much as the 50 it never saw — plus the new one. Under
    // the replace contract this same call deleted the 40 it had been shown and left out.
    expect(next).toContain("etq-0");
    expect(next).toContain(`etq-${SHOWN_LABELS_MAX}`);
    expect(next).toContain("etq-89");
    expect(next).toContain("resolvido");
    expect(next.length).toBe(many.length + 1);
  });

  test("the report is capped too, and says how many it left out", async () => {
    // The report is the third statement about the same list. Uncapped it would hand back the very
    // text the ceiling exists to keep out of the context, and a silent cut would present a partial
    // set as the whole truth.
    const client = {
      getConversationLabels: async () => many,
      setConversationLabels: async () => ({}),
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    });
    const out = String(
      await byName(tools, "set_labels").invoke({ add: ["resolvido"] }),
    );
    expect(out).toContain(`etq-${SHOWN_LABELS_MAX - 1}`);
    expect(out).not.toContain(`"etq-${SHOWN_LABELS_MAX}"`);
    expect(out).toContain("more)");
  });

  test("what is recorded for the next call is capped too", async () => {
    // `recordShown` stores what the model was HANDED, ceiling included. This is informational under
    // the delta rather than load-bearing — a stale entry costs a redundant `add`, not a deletion —
    // but it is still the text the next call reads, and it is capped like every other list the
    // model is given.
    const client = {
      getConversationLabels: async () => many,
      setConversationLabels: async () => ({}),
    } as unknown as ChatwootClient;
    const ctx: Record<string, unknown> = {
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    };
    const tools = buildNativeTools(ctx as never);
    await byName(tools, "set_labels").invoke({ add: ["resolvido"] });
    const shown = (ctx.shownLabels as { conversation: string[] }).conversation;
    expect(shown.length).toBe(SHOWN_LABELS_MAX);
  });
});

describe("a muted turn is not offered what it cannot complete", () => {
  // The observer runs the ordinary toolset now (issue #568), and two of those tools are entirely
  // customer-facing: the reaction's POST is refused at the muted transport, and the image is
  // delivered by a turn an observation does not have. Each costs a model round and answers with a
  // failure the operator reads as a broken integration.
  function clientWithMute(muted: boolean) {
    return { muted } as unknown as ChatwootClient;
  }

  test("the reaction and the image are gone; everything else stands", () => {
    const names = buildNativeTools({
      client: clientWithMute(true),
      conversationId: 7,
    }).map((t) => t.name);
    expect(names).not.toContain("react_to_message");
    expect(names).not.toContain("send_image");
    // The private note is the mute's own isention: it is the one thing an observer writes where a
    // person reads it, so hiding it would take the watcher's voice away entirely.
    expect(names).toContain("private_note");
    expect(names).toContain("set_labels");
    expect(names).toContain("resolve_conversation");
  });

  test("an ordinary turn keeps both", () => {
    // The negative above is worth nothing without this: a filter that dropped them always would
    // pass it and take the two tools away from every responder.
    const names = buildNativeTools({
      client: clientWithMute(false),
      conversationId: 7,
    }).map((t) => t.name);
    expect(names).toContain("react_to_message");
    expect(names).toContain("send_image");
  });

  test("the grant is still fail-closed under a mute", () => {
    // The two filters compose in one direction only: a mute may take a granted tool away, and it
    // may never hand back one the operator did not grant.
    const names = buildNativeTools(
      { client: clientWithMute(true), conversationId: 7 },
      ["set_labels", "react_to_message"],
    ).map((t) => t.name);
    expect(names).toEqual(["set_labels"]);
  });
});

describe("the fence rule, over every native tool", () => {
  const CLIENT_READS = [
    "getConversation",
    "getConversationLabels",
    "getContactLabels",
    "getLatestIncomingMessage",
  ];
  const CLIENT_WRITES = [
    "sendMessage",
    "sendPrivateNote",
    "toggleStatus",
    "assignConversation",
    "setConversationCustomAttributes",
    "setContactCustomAttributes",
    "setKanbanTaskCustomAttributes",
    "setConversationLabels",
    "setContactLabels",
    "setKanbanTaskLabels",
    "moveKanbanTask",
    "updateKanbanTask",
    "addMessageReaction",
    "toggleTyping",
    "markRead",
  ];

  function tracingCtx() {
    const trace: string[] = [];
    // The fence answers TRUE until something has been awaited, and false from then on: that is the
    // operator acting inside the wait, which is the only window the boundary ask cannot cover.
    let waited = false;
    const stillWanted = async () => !waited;
    // Handed out so the precondition battery below can stand for the operator acting INSIDE the
    // state read, which is a wait this tracing client never sees.
    const stillWantedFlip = () => {
      waited = true;
    };
    const client = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "muted") return false;
          if (typeof prop !== "string") return undefined;
          const kind = CLIENT_READS.includes(prop)
            ? "read"
            : CLIENT_WRITES.includes(prop)
              ? "write"
              : "unknown";
          return async (...args: unknown[]) => {
            trace.push(`client:${kind}:${prop}`);
            waited = true;
            if (prop === "getLatestIncomingMessage")
              return { id: 99, isReaction: false };
            if (prop === "getConversation")
              return { status: "open", meta: { assignee: null } };
            if (prop === "getConversationLabels" || prop === "getContactLabels")
              return ["ja-existente"];
            return args.length >= 0 ? {} : {};
          };
        },
      },
    ) as unknown as ChatwootClient;
    // The database is a wait like any other — `set_custom_attribute` and `set_labels` reach their
    // contact scope through one, and it is the wait that round 22 found unfenced.
    const tx = {
      // The scoped transaction opens with a `set_config` of its own; it is plumbing every scoped
      // access pays, not the handler awaiting something, so it neither counts as an effect nor
      // starts the window. Any other raw statement is a real write.
      $executeRaw: async (q: { raw?: string[] } | TemplateStringsArray) => {
        const sql = Array.isArray((q as TemplateStringsArray).raw)
          ? (q as TemplateStringsArray).raw.join("")
          : String(q);
        if (sql.includes("set_config")) {
          trace.push("db:scope");
          return 0;
        }
        trace.push("db:write");
        waited = true;
        return 0;
      },
      contact: {
        findUnique: async () => {
          trace.push("db:read");
          waited = true;
          return { chatwootContactId: 55 };
        },
        updateMany: async () => {
          trace.push("db:write");
          waited = true;
          return { count: 1 };
        },
      },
      outboundEvent: {
        create: async () => {
          trace.push("db:write");
          waited = true;
          return {};
        },
      },
    };
    const base = {
      $extends: () => ({
        $transaction: (fn: (t: unknown) => unknown) => fn(tx),
      }),
    } as unknown as PrismaClient;
    const turnState = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const ctx = {
      client,
      conversationId: 7,
      tenantId: 1n,
      base,
      contactDbId: 3n,
      conversationDbId: 5n,
      observed: { status: "open" as const, statusAt: null },
      turnState,
      stillWanted,
      kanban: {
        taskId: 11,
        boardId: 2,
        boardName: "Vendas",
        currentStepId: 7,
        currentStepName: "Novo",
        steps: [
          { id: 7, name: "Novo" },
          { id: 22, name: "Ganho" },
        ],
        card: {
          title: "Lead",
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
      sendImage: { allowedHosts: ["imgs.example"], maxBytes: 1_000_000 },
      fetchImpl: (async () => {
        trace.push("fetch");
        waited = true;
        // A real PNG signature: the tool sniffs the bytes, and a body it rejects would make this
        // case prove nothing about what happens AFTER the download.
        return new Response(
          new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
          {
            headers: { "content-type": "image/png" },
          },
        );
      }) as unknown as typeof fetch,
      assertSafe: async () => {},
      stillWantedFlip,
    };
    return { ctx, trace };
  }

  // One entry per native tool, and where a tool takes a scope, one per scope: the arguments that
  // make it actually try to write. A name missing here fails the coverage test below.
  const CASES: Array<{
    tool: string;
    label: string;
    args: object;
    ctx?: Record<string, unknown>;
  }> = [
    {
      tool: "handoff_to_human",
      label: "com nota",
      args: { reason: "resumo", customerMessage: "" },
    },
    { tool: "private_note", label: "", args: { content: "nota" } },
    {
      tool: "set_custom_attribute",
      label: "conversa",
      args: { key: "stage", value: "lead" },
    },
    {
      tool: "set_custom_attribute",
      label: "contato",
      args: { key: "stage", value: "lead", scope: "contact" },
    },
    {
      tool: "set_custom_attribute",
      label: "card",
      args: { key: "stage", value: "lead", scope: "task" },
    },
    { tool: "set_labels", label: "conversa", args: { labels: ["nova"] } },
    {
      tool: "set_labels",
      label: "contato",
      args: { labels: ["nova"], scope: "contact" },
    },
    {
      tool: "set_labels",
      label: "card",
      args: { labels: ["nova"], scope: "task" },
    },
    {
      tool: "resolve_conversation",
      label: "imediato",
      args: {},
      // WITHOUT a turnState, which is the path that closes the conversation itself: with one the
      // tool only records the intent and the runtime toggles after the reply, and the battery would
      // be watching a handler that writes nothing.
      ctx: { turnState: undefined },
    },
    { tool: "kanban_move_card", label: "", args: { targetStep: "Ganho" } },
    { tool: "update_kanban_task", label: "", args: { title: "outro" } },
    { tool: "set_voice_preference", label: "", args: { preference: "audio" } },
    { tool: "react_to_message", label: "", args: { emoji: "👍" } },
    {
      tool: "send_image",
      label: "",
      args: { url: "https://imgs.example/x.png" },
    },
    { tool: "skip_reply", label: "", args: {} },
    { tool: "calculator", label: "", args: { expression: "1+1" } },
    { tool: "get_current_time", label: "", args: {} },
  ];

  test("the table covers every native tool", () => {
    // The point of the battery is the rule, and a rule only holds over what it was asked about. A
    // tool added to the catalog without an entry would otherwise pass by not being tested.
    expect([...new Set(CASES.map((c) => c.tool))].sort()).toEqual(
      [...NATIVE_TOOL_NAMES].sort(),
    );
  });

  // THE SAME RULE THROUGH THE PRECONDITION WRAPPER, which is where round 24 found it broken. A
  // configured precondition puts a database read between the graph's ask at dispatch and the call it
  // authorises, so a handler whose FIRST act is a write — a private note, a status toggle — loses
  // the cover that ask gave it. Here the fence is already withdrawn when the tool is invoked, so a
  // correct wrapper lets NOTHING through: not even the first effect.
  for (const c of CASES) {
    const name = c.label ? `${c.tool} (${c.label})` : c.tool;
    test(`${name}: a precondition read is a wait, and nothing runs after it`, async () => {
      const { ctx, trace } = tracingCtx();
      const tools = applyToolPreconditions(
        buildNativeTools({ ...ctx, ...(c.ctx ?? {}) } as never),
        {
          [c.tool]: {
            kind: "attribute" as const,
            scope: "conversation" as const,
            key: "vip",
            equals: "sim",
          },
        },
        async () => {
          // The read itself is the wait: the operator acts inside it. The condition is MET, so what
          // stops the call can only be the fence.
          (ctx as { stillWantedFlip: () => void }).stillWantedFlip();
          return {
            conversationAttributes: { vip: "sim" },
            contactAttributes: {},
          };
        },
        undefined,
        undefined,
        ctx.stillWanted,
      );
      await byName(tools, c.tool).invoke(c.args as never);
      expect(trace.filter((e) => e.startsWith("client:write"))).toEqual([]);
    });
  }

  for (const c of CASES) {
    const name = c.label ? `${c.tool} (${c.label})` : c.tool;
    test(`${name}: no write lands after a wait once the run is called off`, async () => {
      const { ctx, trace } = tracingCtx();
      const tools = buildNativeTools({ ...ctx, ...(c.ctx ?? {}) } as never);
      await byName(tools, c.tool).invoke(c.args as never);
      const offenders = trace
        .map((e, i) => ({ e, i }))
        .filter(({ e, i }) => i > 0 && e.startsWith("client:write"));
      expect({ trace, offenders }).toEqual({ trace, offenders: [] });
      expect(trace.filter((e) => e.includes("unknown"))).toEqual([]);
    });
  }
});
