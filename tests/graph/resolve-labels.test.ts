import { describe, expect, test } from "bun:test";
import { applyResolveLabels, resolveLabelsFor } from "@/graph/resolve-labels";
import type { ChatwootClient } from "@/modules/chatwoot/client";

// A Chatwoot whose labels behave like the real endpoint: the catalog is the account's, the
// conversation's set is REPLACED by the POST, and every call is recorded in order.
function fakeChatwoot(opts: {
  catalog?: string[] | "unreadable";
  current?: string[];
  // The contact's conversations, as `/contacts/:id/conversations` lists them.
  contactConversations?: Array<{ id: number; inboxId: number; status: string }>;
  // Conversations by number, as `/conversations/:id` answers.
  conversations?: Record<number, Record<string, unknown>>;
  unreadableCases?: boolean;
}) {
  const calls: Array<[string, unknown]> = [];
  let current = [...(opts.current ?? [])];
  const client = {
    listLabels: async () => {
      calls.push(["listLabels", null]);
      if (opts.catalog === "unreadable") throw new Error("503");
      return opts.catalog ?? [];
    },
    getConversationLabels: async (id: number) => {
      calls.push(["getConversationLabels", id]);
      return [...current];
    },
    setConversationLabels: async (id: number, labels: string[]) => {
      calls.push(["setConversationLabels", [id, labels]]);
      current = [...labels];
      return {};
    },
    listContactConversations: async (id: number) => {
      calls.push(["listContactConversations", id]);
      if (opts.unreadableCases) throw new Error("503");
      return (opts.contactConversations ?? []).map((c) => ({
        ...c,
        canReply: true,
      }));
    },
    getConversation: async (id: number) => {
      calls.push(["getConversation", id]);
      if (opts.unreadableCases) throw new Error("503");
      return opts.conversations?.[id] ?? { id, inbox_id: 1, status: "open" };
    },
  } as unknown as ChatwootClient;
  return { client, calls, labels: () => current };
}

describe("applyResolveLabels", () => {
  test("adds the configured label to a conversation that has none", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
    });
    expect(out.outcome).toBe("written");
    expect(cw.labels()).toEqual(["resolvido-pela-ia"]);
  });

  test("merges: the labels already on the conversation stay", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia", "vip", "compra-de-ingresso"],
      current: ["compra-de-ingresso", "vip"],
    });
    await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
    });
    expect([...cw.labels()].sort()).toEqual([
      "compra-de-ingresso",
      "resolvido-pela-ia",
      "vip",
    ]);
  });

  test("a label the model already set is not written twice", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      current: ["resolvido-pela-ia"],
    });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
    });
    expect(out.outcome).toBe("unchanged");
    expect(cw.calls.map((c) => c[0])).not.toContain("setConversationLabels");
    expect(cw.labels()).toEqual(["resolvido-pela-ia"]);
  });

  test("a label the account does not have is left off and reported, the known ones are written", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia", "etiqueta-inexistente-919"],
    });
    expect(out.unknown).toEqual(["etiqueta-inexistente-919"]);
    expect(cw.labels()).toEqual(["resolvido-pela-ia"]);
  });

  test("an unreadable catalog does not cost the label: it is written as configured", async () => {
    const cw = fakeChatwoot({ catalog: "unreadable" });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
    });
    expect(out.outcome).toBe("written");
    expect(out.unknown).toEqual([]);
    expect(cw.labels()).toEqual(["resolvido-pela-ia"]);
  });

  test("the catalog is compared case-insensitively", async () => {
    const cw = fakeChatwoot({ catalog: ["Resolvido-Pela-IA"] });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
    });
    expect(out.unknown).toEqual([]);
    expect(cw.labels()).toEqual(["resolvido-pela-ia"]);
  });

  test("a run called off during the read writes nothing", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
      stillWanted: async () => false,
    });
    expect(out.outcome).toBe("called_off");
    expect(cw.calls.map((c) => c[0])).not.toContain("setConversationLabels");
  });

  test("no configured label makes no Chatwoot call at all", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: [],
    });
    expect(out.outcome).toBe("none");
    expect(cw.calls).toEqual([]);
  });

  test("a write that fails is reported, not thrown: the close still has to happen", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    (cw.client as unknown as Record<string, unknown>).setConversationLabels =
      async () => {
        throw new Error("boom");
      };
    const out = await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
    });
    expect(out.outcome).toBe("failed");
  });
});

// A CONTACT WAITING ON A CASE IS NOT SURVEYED. The close of the chat they came back to ("ok, I'll
// wait") is not the end of their request: the case in the destination inbox is, so the labels a
// survey keys on stay off while that case is open or pending.
describe("applyResolveLabels with an open case", () => {
  const hold = {
    targetInboxId: 9,
    caseAttributeKey: "case_conversation_id",
    contactId: 55,
  };
  const apply = (
    cw: ReturnType<typeof fakeChatwoot>,
    labels = ["resolvido-pela-ia"],
  ) =>
    applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels,
      caseHold: hold,
    });

  test("the contact has a pending conversation in the case inbox: no label", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      contactConversations: [
        { id: 7, inboxId: 1, status: "open" },
        { id: 80, inboxId: 9, status: "pending" },
      ],
    });
    const out = await apply(cw);
    expect(out.outcome).toBe("held");
    expect(out.heldBy).toBe(80);
    expect(cw.calls.map((c) => c[0])).not.toContain("setConversationLabels");
  });

  test("an open one holds too", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      contactConversations: [{ id: 80, inboxId: 9, status: "open" }],
    });
    expect((await apply(cw)).outcome).toBe("held");
  });

  test("a resolved or snoozed case, or one in another inbox, does not hold", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      contactConversations: [
        { id: 80, inboxId: 9, status: "resolved" },
        { id: 81, inboxId: 4, status: "open" },
        { id: 82, inboxId: 9, status: "snoozed" },
      ],
    });
    expect((await apply(cw)).outcome).toBe("written");
    expect(cw.labels()).toEqual(["resolvido-pela-ia"]);
  });

  test("the conversation being closed is not its own case", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      contactConversations: [{ id: 7, inboxId: 9, status: "pending" }],
      conversations: { 7: { id: 7, inbox_id: 9, status: "pending" } },
    });
    expect((await apply(cw)).outcome).toBe("written");
  });

  test("the case this conversation opened on another contact holds, found by its attribute", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      conversations: {
        7: {
          id: 7,
          inbox_id: 1,
          status: "open",
          custom_attributes: { case_conversation_id: 90 },
        },
        90: { id: 90, inbox_id: 9, status: "open" },
      },
    });
    const out = await apply(cw);
    expect(out.outcome).toBe("held");
    expect(out.heldBy).toBe(90);
  });

  test("a case that could not be read holds the label, and says why", async () => {
    const cw = fakeChatwoot({
      catalog: ["resolvido-pela-ia"],
      unreadableCases: true,
    });
    const out = await apply(cw);
    expect(out.outcome).toBe("held");
    expect(out.heldBy).toBe("unread");
    expect(out.error).toBeDefined();
  });

  test("no case inbox configured reads no conversation", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    await applyResolveLabels({
      client: cw.client,
      tenantId: 1n,
      conversationId: 7,
      labels: ["resolvido-pela-ia"],
      caseHold: null,
    });
    expect(cw.calls.map((c) => c[0])).toEqual([
      "listLabels",
      "getConversationLabels",
      "setConversationLabels",
    ]);
  });

  test("no label configured reads nothing, case inbox or not", async () => {
    const cw = fakeChatwoot({ catalog: ["resolvido-pela-ia"] });
    await apply(cw, []);
    expect(cw.calls).toEqual([]);
  });
});

// Which labels a deferred close carries. Only the agent's own `resolve_conversation` puts them in
// the turn, and a case opened in the same turn takes them away whatever the order of the two calls:
// the conversation went to the team, so it was not resolved by the AI.
describe("resolveLabelsFor", () => {
  const base = {
    resolveRequested: true,
    pendingAttachments: [],
    imagesInFlight: 0,
    documentsInFlight: 0,
    attachmentsSeq: 0,
  };
  test.each([
    [
      "no intent",
      { ...base, resolveRequested: false, resolveLabels: ["x"] },
      [],
    ],
    ["the tool asked, no case", { ...base, resolveLabels: ["x"] }, ["x"]],
    ["a close no tool labelled (a case, a reopen)", { ...base }, []],
    [
      "the tool asked and a case was opened",
      { ...base, resolveLabels: ["x"], caseClosing: true },
      [],
    ],
  ])("%s", (_name, state, expected) => {
    expect(resolveLabelsFor(state)).toEqual(expected);
  });
});
