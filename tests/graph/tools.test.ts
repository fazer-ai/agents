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
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";

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
    // NOTE: `open_case_in_inbox` and `update_contact` are the natives that need their config to
    // exist: with no destination inbox, or no writable contact field, there is nothing they could do.
    expect(
      buildNativeTools({ client, conversationId: 1 })
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      NATIVE_TOOL_NAMES.filter(
        (n) => n !== "open_case_in_inbox" && n !== "update_contact",
      ).sort(),
    );
    expect(
      buildNativeTools({
        client,
        conversationId: 1,
        crossInboxCase: {
          config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 9 },
          contactId: 55,
        },
        contactFields: { context: ["name"], writable: ["name"] },
      })
        .map((t) => t.name)
        .sort(),
    ).toEqual([...NATIVE_TOOL_NAMES].sort());

    const only = buildNativeTools({ client, conversationId: 1 }, [
      "private_note",
    ]);
    expect(only.map((t) => t.name)).toEqual(["private_note"]);
  });

  // NOTE: `handoffAnsweredTheTurn` requires a line AND a completed transfer so the model's next hop
  // can speak when there is no line; a tool that told the model to stay silent there would leave the
  // customer with nothing. The argument is REQUIRED, so forgetting it is not a way to reach silence,
  // and an empty string is how silence is DECLARED: the log line reports `string(0)` for a declared
  // empty and nothing for an omitted argument, which is how an operator tells the two apart.
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
    // NOTE: neither branch may carry an instruction to stay silent: the model obeys that sentence.
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

    // And on the OTHER shape, the one that carries `assignTo`, so a mutation making the field
    // optional on this branch alone cannot survive the suite.
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
    // The line is RECORDED on `handoffState` for the caller to deliver, and an observation
    // has no `handoffState` and throws its final output away: the transfer happens and the customer
    // hears nothing. Promising otherwise makes the model hand over believing they were answered.
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
    // conversation's labels would show a `contact` call the wrong list, and invite copying them onto
    // the contact. The listing is per scope and labelled with it, and the prose never says
    // "conversation".
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
    // The parameter is an `Iterable<string>`, and a generator is spent by whoever reads it
    // first. Read once per candidate, it would be exhausted while testing a tool nobody granted,
    // and the agent would come up with an empty toolset, silently, with every grant in place.
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

  // NOTE: the tool writes NOTHING to the customer. The closing line is recorded for the caller, which
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
      // NOTE: the third argument carries the fence the client asks INSIDE its queue; this ctx
      // has none to offer, so it arrives undefined and the write proceeds.
      [
        "setConversationCustomAttributes",
        [7, { stage: "lead" }, { stillWanted: undefined }],
      ],
      ["toggleStatus", [7, "resolved"]],
    ]);
  });

  // Chatwoot renders a private note as Liquid too, so the model's text goes escaped (the
  // wire shape is pinned in chatwoot-liquid.test.ts). Without it `{{contact.phone_number}}` in a note
  // comes out as the contact's phone number.
  test("private_note and the handoff note carry the model's text literally", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({ client, conversationId: 7 });
    await byName(tools, "private_note").invoke({
      content: "cliente pediu {{contact.phone_number}} e {{foo}}",
    });
    await byName(tools, "handoff_to_human").invoke({
      reason: "motivo {% if true %}x{% endif %}",
      customerMessage: "",
    });
    expect(calls.filter((c) => c[0] === "sendPrivateNote")).toEqual([
      [
        "sendPrivateNote",
        [7, "cliente pediu {{ '{{' }}contact.phone_number}} e {{ '{{' }}foo}}"],
      ],
      [
        "sendPrivateNote",
        [7, "motivo {{ '{%' }} if true %}x{{ '{%' }} endif %}"],
      ],
    ]);
  });

  test("a /reset landing while resolve_conversation reads does NOT close the conversation", async () => {
    // The close reads the live status first (a WAIT), and the graph's ask at the tool
    // boundary happened before it. An observation holds no thread claim, so `/reset` can land in
    // that window, and a close is not something a later turn undoes. Same rule set_labels applies
    // in its queue.
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
    // through.
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

  // NOTE: a conversation the human queue now owns is not ours to close. With a `turnState` the
  // intent is deferred and the reactive runtime drops it; WITHOUT one (every proactive turn and every
  // observation) the tool closes inside the call. Asked on the tool because both modes pass through
  // it and the observer builds its own toolset, so a guard in either runtime would miss it. A
  // completed transfer blocks the close AND says so; a turn with no transfer still closes, which a
  // guard written too wide would break.
  test("resolve_conversation refuses to close what this turn transferred", async () => {
    const { client, calls } = recordingClient();
    const handoffState = {
      customerMessage: null as string | null,
      completed: false,
      declinedToSpeak: false,
    };
    const tools = buildNativeTools({ client, conversationId: 7, handoffState });
    // NOTE: no transfer yet: the immediate close is untouched.
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

  // The operator's fixed labels ride the close the agent asked for, whatever the model
  // did with set_labels.
  test("resolve_conversation with turnState hands the configured labels to the deferred close", async () => {
    const { client, calls } = recordingClient();
    const turnState: {
      resolveRequested: boolean;
      resolveLabels?: string[];
      pendingAttachments: never[];
      imagesInFlight: number;
      documentsInFlight: number;
      attachmentsSeq: number;
    } = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      turnState,
      resolveLabels: ["resolvido-pela-ia"],
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls).toEqual([]);
    expect(turnState.resolveRequested).toBe(true);
    expect(turnState.resolveLabels).toEqual(["resolvido-pela-ia"]);
  });

  test("resolve_conversation on a proactive turn writes the configured labels, then closes", async () => {
    const calls: Array<[string, unknown[]]> = [];
    let current: string[] = ["vip"];
    const client = {
      listLabels: async () => {
        calls.push(["listLabels", []]);
        return ["vip", "resolvido-pela-ia"];
      },
      getConversationLabels: async (id: number) => {
        calls.push(["getConversationLabels", [id]]);
        return [...current];
      },
      setConversationLabels: async (id: number, labels: string[]) => {
        calls.push(["setConversationLabels", [id, labels]]);
        current = [...labels];
        return {};
      },
      toggleStatus: async (...args: unknown[]) => {
        calls.push(["toggleStatus", args]);
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      resolveLabels: ["resolvido-pela-ia"],
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls.map((c) => c[0])).toEqual([
      "listLabels",
      "getConversationLabels",
      "setConversationLabels",
      "toggleStatus",
    ]);
    expect([...current].sort()).toEqual(["resolvido-pela-ia", "vip"]);
  });

  // A contact still waiting on a case in the agent's case inbox gets the close and not the labels a
  // survey keys on.
  test("resolve_conversation on a proactive turn closes without the labels while the contact waits on a case", async () => {
    const calls: string[] = [];
    const client = {
      listLabels: async () => ["resolvido-pela-ia"],
      getConversation: async (id: number) => ({ id, inbox_id: 1 }),
      listContactConversations: async () => [
        { id: 80, inboxId: 9, status: "pending", canReply: true },
      ],
      getConversationLabels: async () => [],
      setConversationLabels: async () => {
        calls.push("setConversationLabels");
        return {};
      },
      toggleStatus: async () => {
        calls.push("toggleStatus");
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      resolveLabels: ["resolvido-pela-ia"],
      resolveCaseHold: {
        targetInboxId: 9,
        caseAttributeKey: CROSS_INBOX_CASE_DEFAULTS.caseAttributeKey,
        contactId: 55,
      },
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls).toEqual(["toggleStatus"]);
  });

  test("what the close could not do with the labels reaches the operator, not the model", async () => {
    const reported: Array<{ phase: string; detail?: unknown; level?: string }> =
      [];
    const client = {
      listLabels: async () => ["resolvido-pela-ia"],
      getConversation: async () => {
        throw new Error("503");
      },
      listContactConversations: async () => [],
      getConversationLabels: async () => [],
      setConversationLabels: async () => ({}),
      toggleStatus: async () => ({}),
    } as unknown as ChatwootClient;
    const build = (cic: boolean, labels: string[]) =>
      buildNativeTools({
        client,
        conversationId: 7,
        resolveLabels: labels,
        onSideEffectError: (e) =>
          reported.push({ phase: e.phase, detail: e.detail, level: e.level }),
        ...(cic
          ? {
              resolveCaseHold: {
                targetInboxId: 9,
                caseAttributeKey: CROSS_INBOX_CASE_DEFAULTS.caseAttributeKey,
                contactId: 55,
              },
            }
          : {}),
      });
    await byName(
      build(false, ["resolvido-pela-ia", "nao-existe"]),
      "resolve_conversation",
    ).invoke({});
    await byName(
      build(true, ["resolvido-pela-ia"]),
      "resolve_conversation",
    ).invoke({});
    // NOTE: Labels held back because the case could not be read are `info` (the conversation
    // closed, the customer was answered); a label write that failed keeps the default `warn`.
    expect(reported).toEqual([
      {
        phase: "resolve_labels_unknown",
        detail: { labels: ["nao-existe"] },
        level: undefined,
      },
      { phase: "resolve_labels", detail: undefined, level: "info" },
    ]);
    reported.length = 0;
    (client as unknown as Record<string, unknown>).setConversationLabels =
      async () => {
        throw new Error("Chatwoot answered 500");
      };
    await byName(
      build(false, ["resolvido-pela-ia"]),
      "resolve_conversation",
    ).invoke({});
    expect(reported).toEqual([
      { phase: "resolve_labels", detail: undefined, level: undefined },
    ]);
  });

  test("resolve_conversation with turnState hands the case inbox to the deferred close", async () => {
    const { client } = recordingClient();
    const turnState: Record<string, unknown> & {
      resolveRequested: boolean;
      pendingAttachments: never[];
      imagesInFlight: number;
      documentsInFlight: number;
      attachmentsSeq: number;
    } = {
      resolveRequested: false,
      pendingAttachments: [],
      imagesInFlight: 0,
      documentsInFlight: 0,
      attachmentsSeq: 0,
    };
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      turnState,
      resolveLabels: ["resolvido-pela-ia"],
      resolveCaseHold: {
        targetInboxId: 9,
        caseAttributeKey: CROSS_INBOX_CASE_DEFAULTS.caseAttributeKey,
        contactId: 55,
      },
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(turnState.resolveCaseHold).toEqual({
      targetInboxId: 9,
      caseAttributeKey: CROSS_INBOX_CASE_DEFAULTS.caseAttributeKey,
      contactId: 55,
    });
  });

  // A conversation someone else already closed is not the agent's close: the toggle is a no-op, and a
  // label written anyway would mark a human's resolution as the AI's.
  test("resolve_conversation on a conversation already resolved writes no resolve label", async () => {
    const calls: string[] = [];
    const client = {
      getConversation: async (id: number) => ({
        id,
        status: "resolved",
        updated_at: 1_700_000_000,
        meta: { assignee_type: null, assignee: null },
      }),
      listLabels: async () => ["resolvido-pela-ia"],
      getConversationLabels: async () => [],
      setConversationLabels: async () => {
        calls.push("setConversationLabels");
        return {};
      },
      toggleStatus: async () => {
        calls.push("toggleStatus");
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      tenantId: 1n,
      conversationDbId: 1n,
      resolveLabels: ["resolvido-pela-ia"],
    } as never);
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls).not.toContain("setConversationLabels");
  });

  // Whatever the labels came to, the close asks the fence again right before it: a withdrawal during
  // a held label, an all-unknown catalog or the label POST itself must not still close.
  test.each([
    ["held by an open case", "held"],
    ["all unknown", "unknown"],
    ["written, then withdrawn during the POST", "written"],
    ["sent, the POST's answer lost, then withdrawn", "lost"],
  ])(
    "a run called off while the labels were %s does not close",
    async (_n, kind) => {
      const calls: string[] = [];
      const noEffect: string[] = [];
      let wanted = true;
      const client = {
        listLabels: async () =>
          kind === "unknown" ? [] : ["resolvido-pela-ia"],
        getConversation: async (id: number) => ({ id, inbox_id: 1 }),
        listContactConversations: async () => {
          wanted = false;
          return [{ id: 80, inboxId: 9, status: "pending", canReply: true }];
        },
        getConversationLabels: async () => [],
        setConversationLabels: async () => {
          calls.push("setConversationLabels");
          wanted = false;
          if (kind === "lost") throw new Error("timeout");
          return {};
        },
        toggleStatus: async () => {
          calls.push("toggleStatus");
          return {};
        },
      } as unknown as ChatwootClient;
      if (kind === "unknown") {
        (client as unknown as Record<string, unknown>).listLabels =
          async () => {
            wanted = false;
            return [];
          };
      }
      const tools = buildNativeTools({
        client,
        conversationId: 7,
        resolveLabels: ["resolvido-pela-ia"],
        stillWanted: async () => wanted,
        onNoEffect: (t: string) => noEffect.push(t),
        ...(kind === "held"
          ? {
              resolveCaseHold: {
                targetInboxId: 9,
                caseAttributeKey: CROSS_INBOX_CASE_DEFAULTS.caseAttributeKey,
                contactId: 55,
              },
            }
          : {}),
      });
      const out = await byName(tools, "resolve_conversation").invoke({});
      expect(calls).not.toContain("toggleStatus");
      expect(String(out)).toContain("Did not resolve");
      // A POST that went out may have landed, answer or not: only a close that sent no label
      // reports no effect.
      expect(noEffect).toEqual(
        kind === "written" || kind === "lost" ? [] : ["resolve_conversation"],
      );
    },
  );

  // The label read is one more wait before the close: a /reset landing in it withdraws the close
  // too, not just the label.
  test("a run called off while the resolve labels were read does not close", async () => {
    const calls: string[] = [];
    let asked = 0;
    const client = {
      listLabels: async () => ["resolvido-pela-ia"],
      getConversationLabels: async () => {
        calls.push("getConversationLabels");
        return [];
      },
      setConversationLabels: async () => {
        calls.push("setConversationLabels");
        return {};
      },
      toggleStatus: async () => {
        calls.push("toggleStatus");
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      resolveLabels: ["resolvido-pela-ia"],
      stillWanted: async () => ++asked < 2,
    });
    const out = await byName(tools, "resolve_conversation").invoke({});
    expect(calls).toEqual(["getConversationLabels"]);
    expect(String(out)).toContain("Did not resolve");
  });

  test("a close this turn's transfer refused writes no resolve label either", async () => {
    const { client, calls } = recordingClient();
    const tools = buildNativeTools({
      client,
      conversationId: 7,
      handoffState: { completed: true } as never,
      resolveLabels: ["resolvido-pela-ia"],
    });
    await byName(tools, "resolve_conversation").invoke({});
    expect(calls).toEqual([]);
  });

  // NOTE: the call names a delta; nothing is diffed against what the model was `shown`.
  describe("applyLabelDelta", () => {
    test("only what is NAMED in remove is removed", () => {
      // NOTE: `c` survives because nobody named it, not because it was unseen.
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
      // NOTE: nothing forces the model to mention a label it does not mean, so naming one in `add`
      // IS a request to have it, and honouring that is correct. Operator prose that says "repeat the
      // labels that are already there" asks for exactly this, which is why the retired `labels`
      // shape is refused by name rather than best-effort.
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
      // NOTE: `[]` can only mean "I name nothing", and wiping a conversation requires naming every
      // label on it.
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
      // NOTE: labels the call does not name stay standing without the guard doing anything at all,
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
      // NOTE: a model that learned the name from the operator's prompt could otherwise switch the
      // agent off by naming the label, which is the authority the guard denies; and since it SEES the
      // label, it will ask.
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
      // `next` carries it because it is on the conversation. There is no separate `visible`
      // projection: the model is shown everything, one list.
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
    // `vip` is not named, so it is not touched, and no snapshot of what the model saw has to
    // be consulted to know that.
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
    // The case above protects a label the model never named. This one it names explicitly,
    // and only the guard keeps it. The model SEES the guarded label, so it will ask; an answer that
    // stayed silent would be a false statement the model reads back out of its own transcript one
    // call later, which is why the report says which one it refused.
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
    // NOTE: told, by name, which one did not move and why. Hiding the label instead is what makes a
    // fenced agent invent a name for it.
    expect(out).toContain('cannot be removed: "agente-off"');
    expect(out).toContain('removed "dúvidas-evento"');
  });

  test("a call that names neither side is refused, and writes nothing", async () => {
    // An empty delta is the absence of a request, and honouring it would be inventing one.
    // The refusal is what tells the model to name what it wants.
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
    // Operator prose in five free-text fields can still describe the retired full-list shape,
    // and a model following that prose sends `{labels: [...]}`. A strict
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
    // `urgente` lands between the turn's read and the first call. Not naming it keeps it,
    // naming it removes it, and neither answer depends on what the model was shown.
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
    // resulting list. The calls that arrive together are applied to ONE read, one delta after the
    // other, and go out as one PUT of the set they add up to. Drop that and both read the empty
    // scope, both PUT a one-item list, and `["a"]` beside `["b"]` ends as whichever landed last.
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
    const reports = await Promise.all([
      tool.invoke({ add: ["a"] }),
      tool.invoke({ add: ["b"] }),
    ]);
    expect(setCalls).toEqual([[9, ["a", "b"]]]);
    expect([...current].sort()).toEqual(["a", "b"]);
    // Each call still answers for its own delta, with the set as it stood after it.
    expect(String(reports[0])).toContain('Now set: "a"');
    expect(String(reports[0])).not.toContain('"b"');
    expect(String(reports[1])).toContain('Now set: "a", "b"');
  });

  test("a call that arrives after the write has gone out reads what it left", async () => {
    let current: string[] = [];
    const setCalls: unknown[][] = [];
    let release!: () => void;
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...args: unknown[]) => {
        setCalls.push(args);
        current = [...(args[1] as string[])];
        // Held, so the second call joins the queue while this write is out.
        if (setCalls.length === 1)
          await new Promise<void>((r) => (release = r));
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      shownLabels: { conversation: [] },
    });
    const tool = byName(tools, "set_labels");
    const first = tool.invoke({ add: ["a"] });
    while (setCalls.length === 0) await new Promise((r) => setTimeout(r, 1));
    const second = tool.invoke({ add: ["b"] });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([first, second]);
    expect(setCalls).toEqual([
      [9, ["a"]],
      [9, ["a", "b"]],
    ]);
  });

  test("a failed write fails every call that rode on it, and the next call starts clean", async () => {
    let current: string[] = [];
    let fail = true;
    const client = {
      getConversationLabels: async () => [...current],
      setConversationLabels: async (...args: unknown[]) => {
        if (fail) throw new Error("chatwoot down");
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
    const settled = await Promise.allSettled([
      tool.invoke({ add: ["a"] }),
      tool.invoke({ add: ["b"] }),
    ]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    await tool.invoke({ add: ["c"] });
    expect(current).toEqual(["c"]);
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
    // The batch metadata LangGraph itself supplies: the two calls of a batch carry the same
    // `langgraph_step`, the next batch a different one.
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
    // "not named, not touched" has to hold for the card itself, not for a turn-prep snapshot
    // of it, or a label put on it while the model was generating is erased by the next write. One
    // GET by id at write time covers it: the id is in hand here, unlike at prep.
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
    // Falling back to the snapshot would erase such a label silently, on the one path where
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
    // The task scope's fresh read is a WAIT, exactly like the GET the other two scopes do:
    // `/reset` can retire the run while it is in flight, so the graph's dispatch check cannot be the
    // last word before the POST. The fence is asked AFTER the read, not before it.
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
    // A REMOVAL IS NOT APPLIED WHEN THE GUARD REFUSED ANY ADDITION OF THE SAME CALL, or a
    // mutually exclusive taxonomy ends the turn with NO category. ONLY REMOVALS ARE HELD: a fully
    // atomic call would stop `add: ["cancelamento", "reembolso"]` (with `cancelamento` guarded) from
    // writing `reembolso`, and a guarded REMOVE from letting its addition through. So the "both
    // categories" direction stays on purpose (the sibling test below).
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
    // once.
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
    // The configuration that is actually correct: every mutually-exclusive value guarded.
    // Both halves fall, no POST goes out, and the two refusals are reported. The half-write lives in
    // an INCOMPLETE list.
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
    // The rule is over ANY refused addition, not a wholly refused `add`. "Classify it and
    // mark it urgent" produces `add: [category, "urgente"]`; under the narrow rule the guard would
    // catch only the category, the `add` would not fall ENTIRELY, and the removal would land alone,
    // leaving the conversation with no category.
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
    // NOTE: the cheapest regression to cause and the most expensive to find. Written as "every label
    // in `add` was refused", the rule fires on an empty `add` (`[].every(…)` is true) and swallows
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
    // `add: ["a"]` where `a` is already standing asks for something and moves nothing, and
    // naming a label already present is a legitimate request. Conditioning the hold on "nothing was
    // actually added" instead of "the guard refused an addition" would turn that redundant request
    // into a block on every removal beside it.
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
    // The free half goes nowhere either. The removal was asked for as one request, and
    // applying the part the guard happens not to cover would leave the conversation in a state
    // nobody asked for, which is what the rule exists to stop. Both labels are named back, because
    // the model wrote both and cannot guess where either ended up.
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
    expect(guarded).toContain("when it is not already there");
    expect(guarded).toContain("holds the call's `remove`");
    const free = byName(
      buildNativeTools({ client, conversationId: 9 }),
      "set_labels",
    ).description as string;
    expect(free).not.toContain("holds the call's `remove`");
  });

  test("reaffirming a guarded label that is already there does not hold the swap", async () => {
    // A guarded label that is already standing (an observer's `agente-off`) is visible, so a
    // model may reaffirm it beside an ordinary swap. Holding the removal there would end the turn
    // with BOTH categories. The refused addition asked for nothing: naming a present label moves
    // nothing under the delta, so there is no exchange for the removal to be in service of.
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
      protectedLabels: ["agente-off"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["cancelamento", "agente-off"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(posts).toEqual([[9, ["agente-off", "cancelamento"]]]);
    expect(out).toContain('removed "compra-de-ingresso"');
    expect(out).not.toContain("stays");
    // The refusal is still reported: the model asked for something it may not have.
    expect(out).toContain("cannot be added");
  });

  test("a guarded label that is NOT standing still holds the swap", async () => {
    // The other side of the same line, so the refinement above cannot be widened into "a refused
    // addition never holds anything". Same call, same guard, and the only difference is that the
    // guarded label the model named is not on the conversation, so asking for it was a real
    // request and the removal did come with it.
    let posts = 0;
    const client = {
      getConversationLabels: async () => ["compra-de-ingresso"],
      setConversationLabels: async () => {
        posts++;
        return {};
      },
    } as unknown as ChatwootClient;
    const tools = buildNativeTools({
      client,
      conversationId: 9,
      protectedLabels: ["agente-off"],
    });
    const out = String(
      await byName(tools, "set_labels").invoke({
        add: ["agente-off"],
        remove: ["compra-de-ingresso"],
      }),
    );
    expect(posts).toBe(0);
    expect(out).toContain('"compra-de-ingresso" stays');
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
    // NOTE: the hold is a property of the call that carried the refused addition, and the queue is
    // what makes the other call of the batch read a world the first one did not change. Ten runs,
    // because a result that oscillates between runs means the serialisation stopped closing.
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
    // The GET above is a wait exactly like the queue the conversation scope waits on, and
    // this scope has no queue to ask inside. A contact label outlives the conversation it was
    // written from, so a write admitted at the tool boundary and landing after `/reset` is the one
    // that survives longest.
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

  // The name the model asked for is quoted in a note, which Chatwoot renders as Liquid.
  test("agent_choice with no match quotes the model's name literally", async () => {
    const { client, calls } = targetingClient([], []);
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
      assignTo: "{{contact.name}}",
      customerMessage: "",
    });
    const notes = calls
      .filter((c) => c[0] === "sendPrivateNote")
      .map((c) => String(c[1][1]));
    expect(notes.some((n) => n.includes("\"{{ '{{' }}contact.name}}\""))).toBe(
      true,
    );
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

// A side effect that fails INSIDE a tool that still returns success must reach
// ctx.onSideEffectError so src/graph/prepare.ts can surface it as a flowlog warn, while the tool's
// return value (what the model sees) stays a success.
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

// Two facts, two fields, and the predicate needs both, even though one block writes them together.
// A line recorded by an attempt that threw must not be delivered by the retry in place of the
// recovery text the model wrote, so a caller that reads only "there is a line" is wrong.
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

// The model never authors code. Computation it must not redo is an operator-authored code tool
// (src/graph/tools/code.ts), so no native tool may take a `code` argument, the shape a "run this
// snippet" tool has, whatever it is called.
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

describe("what the model is shown has a ceiling", () => {
  // A conversation's own label set is the one list an automation can grow without an
  // operator looking. Uncapped it lands in the observer's prompt and TWICE in this tool's
  // description, so a bulk-labelled conversation can push the whole tick past the provider's
  // context limit, and every retry of it fails the same way.
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
    // A ceiling is safe because a label the call does not name is not touched: the cut is a
    // display decision with no reach into the write at all.
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
    // NOTE: all 90 stand (the 40 it was shown as much as the 50 it never saw), plus the new one.
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
  // The observer runs the ordinary toolset, and two of those tools are entirely
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
    // NOTE: The private note is the mute's own exception: it is the one thing an observer writes where a
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

// EVERY handler that waits before writing has to ask the fence again, and a rule kept by reading
// breaks one handler at a time. The graph asks `stillWanted` at DISPATCH, which covers a handler's
// first outward effect; with a fence that says no from the first wait onward, a correct handler
// makes at most one outward effect and never a write that came second. The client is a proxy over a
// read/write classification (an UNKNOWN method fails), and the tool table must cover every name in
// the catalog, so a new client call or tool cannot join silently. See docs/chatwoot.md.
describe("the fence rule, over every native tool", () => {
  const CLIENT_READS = [
    "getInbox",
    "getContact",
    "getMessages",
    "listContactConversations",
    "findContactIdByEmail",
    "getConversation",
    "getConversationLabels",
    "getContactLabels",
    "getLatestIncomingMessage",
  ];
  const CLIENT_WRITES = [
    "updateContact",
    "mergeContacts",
    "createConversation",
    "sendMessageAsAdmin",
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
          // Pure string building, not a call to Chatwoot.
          if (prop === "conversationUrl")
            return (id: number) => `https://cw.example/conversations/${id}`;
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
            if (prop === "getInbox")
              return { name: "E-mail", channel_type: "Channel::Api" };
            if (prop === "getConversationLabels" || prop === "getContactLabels")
              return ["ja-existente"];
            return args.length >= 0 ? {} : {};
          };
        },
      },
    ) as unknown as ChatwootClient;
    // The database is a wait like any other: `set_custom_attribute` and `set_labels` reach
    // their contact scope through one.
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
    {
      tool: "update_contact",
      label: "",
      args: { name: "Mariana Almeida" },
      ctx: { contactFields: { context: ["name"], writable: ["name"] } },
    },
    { tool: "react_to_message", label: "", args: { emoji: "👍" } },
    {
      tool: "send_image",
      label: "",
      args: { url: "https://imgs.example/x.png" },
    },
    {
      tool: "open_case_in_inbox",
      label: "",
      args: { reason: "cliente pediu atendente" },
      ctx: {
        crossInboxCase: {
          config: { ...CROSS_INBOX_CASE_DEFAULTS, targetInboxId: 9 },
          contactId: 55,
        },
      },
    },
    { tool: "skip_reply", label: "", args: { reason: "acknowledged" } },
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

  // NOTE: the same rule through the precondition wrapper. A configured precondition puts a database
  // read between the graph's ask at dispatch and the call it authorises, so a handler whose FIRST
  // act is a write (a private note, a status toggle) loses the cover that ask gave it. Here the
  // fence is already withdrawn when the tool is invoked, so a correct wrapper lets NOTHING through.
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
