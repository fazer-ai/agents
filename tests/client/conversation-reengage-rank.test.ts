import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  renderConversation,
  stubConversationApi,
} from "../utils/conversation-page";

// The buttons that ask for a rank. `POST /v1/conversations/:id/reengage` requires `TENANT_ADMIN`,
// and this page is deliberately NOT admin-gated (`docs/ui.md`): it is the attendant's screen. So both
// re-engage doors, the header's "Respond now" and the failure card's "Re-engage", are off for a rank
// the route will refuse, while the other actions stay. The rank itself is covered against the real
// route in tests/api/v1/reengage-role-gate.test.ts.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const HELD = {
  status: "pending",
  assigneeType: "User",
  assigneeId: 5,
  assigneeName: "Ana",
  heldByAnotherParty: true,
  lastError: "the model did not answer",
  lastErrorAt: "2026-01-01T00:00:00.000Z",
};

const FREE = {
  heldByAnotherParty: false,
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
};

// Opens the page as the role, and raises the header offer the way an operator does: a return.
async function doorsFor(role: string) {
  const stub = stubConversationApi(HELD, role);
  await renderConversation(stub);
  stub.conversation = { ...stub.conversation, ...FREE };
  fireEvent.click(screen.getByRole("button", { name: "Return to AI" }));
  await screen.findByText("Returned to the AI.");
  await screen.findByRole("button", { name: "Handoff to human" });
  return {
    respondNow: screen.queryByRole("button", { name: "Respond now" }) !== null,
    reengage: screen.queryByRole("button", { name: "Re-engage" }) !== null,
  };
}

describe("the re-engage buttons follow the role hierarchy", () => {
  // `isAdminRole` is `roleAtLeast(role, "TENANT_ADMIN")`: SUPER_ADMIN passes, and a role the console
  // does not know is not an admin.
  for (const [role, offered] of [
    ["AGENT", false],
    ["SOMETHING_NEW", false],
    ["TENANT_ADMIN", true],
    ["SUPER_ADMIN", true],
  ] as const) {
    test(`${role}: both doors are ${offered ? "offered" : "not offered"}`, async () => {
      expect(await doorsFor(role)).toEqual({
        respondNow: offered,
        reengage: offered,
      });
    });
  }

  test("Respond now waits for the offer and for a pending conversation", async () => {
    // No return made yet: the offer is not raised.
    await renderConversation(stubConversationApi({ status: "pending" }));
    expect(screen.queryByRole("button", { name: "Respond now" })).toBeNull();
    cleanup();
    // Raised, then the conversation is reported open: still not offered.
    const stub = stubConversationApi(HELD);
    await renderConversation(stub);
    stub.conversation = { ...stub.conversation, ...FREE, status: "open" };
    fireEvent.click(screen.getByRole("button", { name: "Return to AI" }));
    await screen.findByText("Returned to the AI.");
    // The page re-reads the conversation after the return; asked once that answer is on screen.
    await waitFor(() =>
      expect(
        stub.requests.filter(
          (r) => r === `GET /api/v1/conversations/${stub.conversation.id}`,
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Respond now" })).toBeNull();
  });
});
