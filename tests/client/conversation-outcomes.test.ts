import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Two conversation endpoints answer with an OUTCOME rather than with a failure: `/return` can come
// back "taken-over" and `/reengage` can come back "gate-closed" (among others). Both return HTTP
// success in those cases, on purpose — the call did what it could, and what is being reported is the
// state it ended in — so a handler that checks `error` alone shows a success toast that says the
// opposite of what the row now reads. `/return` shipped exactly that: the outcome was added on the
// server, threaded through the API and the MCP tool, and the first-party console kept destructuring
// only `error`, telling the operator the AI had a conversation a person had just claimed.
//
// Checked on the source because rendering this page pulls auth, theme, toast, realtime and a live
// conversation, and the branch under test is one `if`. The outcomes themselves are covered by
// tests/modules/tier3.test.ts; what is left here is that nobody writes a new action that drops them.
const SRC = readFileSync("src/client/pages/ConversationDetailPage.tsx", "utf8");

// Endpoint -> the outcome value whose whole point is that it is NOT a success.
const OUTCOME_ENDPOINTS = [
  { call: ".return.post(", handler: "returnToAi", notSuccess: "taken-over" },
  { call: ".reengage.post(", handler: "reengage", notSuccess: "gate-closed" },
];

function handlerBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("\n  }", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("conversation actions report their outcome", () => {
  for (const { call, handler, notSuccess } of OUTCOME_ENDPOINTS) {
    test(`${handler} branches on the outcome instead of on the error alone`, () => {
      const body = handlerBody(handler);
      // It is the handler for that endpoint, so a rename cannot quietly empty this test.
      expect(body).toContain(call);
      // It reads the payload at all — `const { error: err } = ...` is the shape that loses it.
      expect(body).toContain("data");
      expect(body).toContain("data.outcome");
      // And names the value that means "not what you asked for".
      expect(body).toContain(notSuccess);
    });
  }

  // The half a toast cannot fix. "Respond now" makes the agent post into the conversation, so
  // offering it after a takeover invites the operator to talk over the person who just claimed it.
  //
  // Asserted as PRESENCE of the false write, not as absence of the true one. The first version of
  // this test checked only that the arm does not raise the offer, and it passed over the defect it
  // was written for: the offer is page state that outlives the action that raised it, so "does not
  // raise it" and "takes it down" are different facts and only the second one is safe. The server
  // leaves the status at `pending` here, so the JSX gate that hides the button after a handoff does
  // not close on this path.
  test("a taken-over return takes the re-engage offer down", () => {
    const body = handlerBody("returnToAi");
    const takeover = body.indexOf('"taken-over"');
    expect(takeover).toBeGreaterThan(-1);
    const elseAt = body.indexOf("} else {", takeover);
    expect(elseAt).toBeGreaterThan(takeover);
    const arm = body.slice(takeover, elseAt);
    expect(arm).toContain("setOfferReengage(false)");
    expect(arm).not.toContain("setOfferReengage(true)");
    // And the ordinary return still raises it, so the assertion above is about the takeover rather
    // than about an offer nobody makes any more.
    expect(body.slice(elseAt)).toContain("setOfferReengage(true)");
  });
});
