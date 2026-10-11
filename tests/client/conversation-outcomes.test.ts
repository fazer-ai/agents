import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  renderConversation,
  stubConversationApi,
} from "../utils/conversation-page";

// Two conversation endpoints answer with an OUTCOME rather than a failure: `/return` can come back
// "taken-over" and `/reengage` "gate-closed" (among others), both with HTTP success on purpose. A
// handler that checks `error` alone shows a success toast that contradicts what the row now reads.
// The page is rendered against a stubbed API and each action is clicked.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const HELD_BY_A_PERSON = {
  status: "open",
  assigneeType: "User",
  assigneeId: 5,
  assigneeName: "Ana",
  heldByAnotherParty: true,
};
const WITH_A_FAILED_TURN = {
  lastError: "the model did not answer",
  lastErrorAt: "2026-01-01T00:00:00.000Z",
};

const button = (name: string) => screen.queryByRole("button", { name });

async function flush() {
  await act(async () => {});
}

describe("conversation actions report their outcome", () => {
  test("a return a person overtook says so, and not that it returned", async () => {
    const stub = stubConversationApi(HELD_BY_A_PERSON);
    stub.returnOutcome = "taken-over";
    await renderConversation(stub);
    fireEvent.click(button("Return to AI") as HTMLElement);
    await screen.findByText(
      "Someone took the conversation while it was being returned, so it stays with them.",
    );
    expect(screen.queryByText("Returned to the AI.")).toBeNull();
  });

  test("an ordinary return says it returned", async () => {
    const stub = stubConversationApi(HELD_BY_A_PERSON);
    await renderConversation(stub);
    fireEvent.click(button("Return to AI") as HTMLElement);
    await screen.findByText("Returned to the AI.");
  });

  for (const [outcome, said, notSaid] of [
    [
      "gate-closed",
      "A human owns this conversation; return it to the AI first.",
      "The AI replied.",
    ],
    ["posted", "The AI replied.", "The AI produced no reply."],
    [
      "posted-partial",
      "The AI replied, but part of the answer did not reach the customer.",
      "The AI produced no reply.",
    ],
  ] as const) {
    test(`a re-engage answered "${outcome}" says what happened`, async () => {
      const stub = stubConversationApi(WITH_A_FAILED_TURN);
      stub.reengageOutcome = outcome;
      await renderConversation(stub);
      fireEvent.click(button("Re-engage") as HTMLElement);
      await screen.findByText(said);
      expect(screen.queryByText(notSaid)).toBeNull();
      expect(screen.queryByText("The AI replied.") !== null).toBe(
        outcome === "posted",
      );
    });
  }

  // The offer is page state that outlives the action that raised it. Here the server still reports
  // the conversation held after the first return, so "Return to AI" stays; the overtaken second
  // return comes back with the conversation pending and free, where a stale offer would show.
  test("a taken-over return takes the re-engage offer down", async () => {
    const stub = stubConversationApi({
      ...HELD_BY_A_PERSON,
      status: "pending",
    });
    await renderConversation(stub);
    fireEvent.click(button("Return to AI") as HTMLElement);
    await screen.findByText("Returned to the AI.");
    stub.returnOutcome = "taken-over";
    stub.conversation = {
      ...stub.conversation,
      heldByAnotherParty: false,
      assigneeType: null,
      assigneeId: null,
      assigneeName: null,
    };
    fireEvent.click(button("Return to AI") as HTMLElement);
    await screen.findByText(
      "Someone took the conversation while it was being returned, so it stays with them.",
    );
    await screen.findByRole("button", { name: "Handoff to human" });
    await flush();
    expect(button("Respond now")).toBeNull();
  });

  test("and an ordinary return raises it", async () => {
    const stub = stubConversationApi({
      ...HELD_BY_A_PERSON,
      status: "pending",
    });
    await renderConversation(stub);
    stub.conversation = {
      ...stub.conversation,
      heldByAnotherParty: false,
      assigneeType: null,
      assigneeId: null,
      assigneeName: null,
    };
    fireEvent.click(button("Return to AI") as HTMLElement);
    await screen.findByRole("button", { name: "Respond now" });
  });

  // Who HOLDS it, answered by the server, not the status: `pending` is also what a takeover leaves.
  test("the ownership buttons key on the holder, not on the status", async () => {
    for (const held of [
      HELD_BY_A_PERSON,
      // Another persona's bot: not a person, and just as out of this agent's hands.
      {
        assigneeType: "AgentBot",
        assigneeId: 31,
        assigneeName: null,
        heldByAnotherParty: true,
      },
    ]) {
      const stub = stubConversationApi({ ...held, status: "pending" });
      await renderConversation(stub);
      expect(button("Return to AI")).not.toBeNull();
      expect(button("Handoff to human")).toBeNull();
      cleanup();
    }
    await renderConversation(stubConversationApi({ status: "pending" }));
    expect(button("Handoff to human")).not.toBeNull();
    expect(button("Return to AI")).toBeNull();
    cleanup();
    await renderConversation(stubConversationApi({ status: "resolved" }));
    expect(button("Reopen")).not.toBeNull();
    expect(button("Return to AI")).toBeNull();
    expect(button("Handoff to human")).toBeNull();
  });

  // All three that hand the conversation TO the agent ask whether anything answers the inbox;
  // "Handoff to human" needs no agent and stays. When they are hidden the row says why.
  test("handing the conversation to the agent is offered only when a responder answers the inbox", async () => {
    const unavailable: Array<[string, Record<string, unknown>]> = [
      ["No agent bound", { agentId: null, agentName: null }],
      ["Agent switched off", { agentEnabled: false }],
      ["Agent only observes", { agentMode: "monitoring" }],
      ["Agent has no bot", { agentHasBot: false }],
      [
        "Agent not activated here",
        { agentMode: "test", testActivatedAt: null },
      ],
    ];
    for (const [reason, responder] of unavailable) {
      for (const status of ["open", "resolved"]) {
        await renderConversation(
          stubConversationApi({ ...responder, ...WITH_A_FAILED_TURN, status }),
        );
        expect([reason, status, button("Return to AI")]).toEqual([
          reason,
          status,
          null,
        ]);
        expect([reason, status, button("Reopen")]).toEqual([
          reason,
          status,
          null,
        ]);
        expect([reason, status, button("Re-engage")]).toEqual([
          reason,
          status,
          null,
        ]);
        expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
        cleanup();
      }
      await renderConversation(
        stubConversationApi({ ...responder, status: "pending" }),
      );
      expect(button("Handoff to human")).not.toBeNull();
      cleanup();
    }
    // The controls: an answering responder, and a test agent this conversation activated.
    for (const responder of [
      {},
      { agentMode: "test", testActivatedAt: "2026-01-01T00:00:00.000Z" },
    ]) {
      await renderConversation(
        stubConversationApi({
          ...responder,
          ...WITH_A_FAILED_TURN,
          status: "open",
        }),
      );
      expect(button("Return to AI")).not.toBeNull();
      expect(button("Re-engage")).not.toBeNull();
      cleanup();
      await renderConversation(
        stubConversationApi({ ...responder, status: "resolved" }),
      );
      expect(button("Reopen")).not.toBeNull();
      cleanup();
    }
  });
});
