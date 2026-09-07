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

  // AN OUTCOME THAT IS NEITHER A SUCCESS NOR A SILENCE (issue #429). `posted-partial` says the
  // customer got part of the answer, and the handler's chain ends in an `else` that says "The AI
  // produced no reply" — so a new outcome lands there by default and tells the operator the exact
  // opposite of what happened. Worse than a wrong word: it invites them to re-engage again, which
  // re-runs the turn and sends the part they already have a second time.
  //
  // Asserted as PRESENCE of the arm rather than absence from the fallback, for the reason the test
  // below states about the offer: "does not reach the else" is not the same fact as "has its own
  // branch", and only the second one survives someone reordering the chain.
  test("a partial reply gets its own arm instead of the no-reply fallback", () => {
    const body = handlerBody("reengage");
    const arm = body.indexOf('"posted-partial"');
    expect(arm).toBeGreaterThan(-1);
    // Its own branch, and BEFORE the fallback — the chain is ordered, so an arm added after the
    // final `else` is unreachable.
    const fallback = body.indexOf("reengage.noReply");
    expect(fallback).toBeGreaterThan(arm);
    // And it says something about the partial delivery rather than reusing the success string.
    expect(body.slice(arm, fallback)).toContain("reengage.postedPartial");
  });

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

  // Taking the offer down is not enough on its own: the operator still has to be able to RETRY. A
  // takeover leaves the conversation `pending` with a human on it, and the two ownership buttons used
  // to key on status alone — so that state showed "Handoff to human" (to a conversation a human
  // already had) and hid "Return to AI" (the only action that helps). An operator with no way to act
  // on a conversation a human is holding is issue #198 itself, restated inside our own console.
  //
  // And the holder is the SERVER's answer, not `assigneeType === "User"`. A conversation assigned to
  // another persona's agent bot is equally out of this agent's hands — the ownership gate compares the
  // bot id, which the browser cannot do — so a User-only test reads that case backwards and offers
  // exactly the wrong button on it.
  test("the ownership buttons key on the holder, not on the status", () => {
    // The gates live in JSX, so they are read as source for the same reason the handlers are.
    const handoff = SRC.indexOf(".handoff.post(");
    expect(handoff).toBeGreaterThan(-1);
    // Look back from the call to the condition that renders its button.
    const handoffGate = SRC.lastIndexOf("{conv.status ===", handoff);
    expect(handoffGate).toBeGreaterThan(-1);
    expect(SRC.slice(handoffGate, handoff)).toContain("!heldByOther");

    // And the return is offered whenever a human holds it, whatever the status says.
    const returnCall = SRC.indexOf('"conversation.returned"');
    expect(returnCall).toBeGreaterThan(-1);
    const returnGate = SRC.lastIndexOf(
      '{conv.status !== "resolved" &&',
      returnCall,
    );
    expect(returnGate).toBeGreaterThan(-1);
    expect(returnGate).toBeLessThan(returnCall);

    // And it does not overlap "Reopen", which runs the SAME operation: two differently labelled
    // buttons for one action is what keying the holder clause on every status produced.
    expect(SRC.slice(returnGate, returnCall)).toContain('!== "resolved"');
    expect(SRC.slice(returnGate, returnCall)).toContain("heldByOther");

    // "Respond now" asks the agent to speak, so it asks the same question.
    const reengageGate = SRC.indexOf("{offerReengage &&");
    expect(reengageGate).toBeGreaterThan(-1);
    expect(SRC.slice(reengageGate, reengageGate + 120)).toContain(
      "!heldByOther",
    );

    // None of the three settles for the browser-side approximation. `isHuman` still exists for the
    // header's assignee line, so its presence in the file is not the thing being forbidden — its
    // presence in these three gates is.
    for (const gate of [
      SRC.slice(handoffGate, handoff),
      SRC.slice(returnGate, returnCall),
      SRC.slice(reengageGate, reengageGate + 120),
    ]) {
      expect(gate).not.toContain("isHuman");
    }
  });

  // And all three that hand the conversation TO the agent ask whether anything answers the inbox
  // (issue #495): a responder bound, switched on, not in monitoring mode. On an inbox an observer
  // only watches, "Return to AI" set the conversation pending and unassigned the person who had it,
  // and nothing ever picked it up. The server refuses now; the console does not offer it first.
  // "Handoff to human" is the one action that needs no agent, so it is left out on purpose.
  test("handing the conversation to the agent is offered only when a responder answers the inbox", () => {
    const gateDef = SRC.indexOf("const responderAnswers =");
    expect(gateDef).toBeGreaterThan(-1);
    expect(SRC.slice(gateDef, gateDef + 200)).toContain(
      "agentEnabled === true",
    );
    expect(SRC.slice(gateDef, gateDef + 200)).toContain(
      'agentMode !== "monitoring"',
    );
    // ...and the bot row behind the binding (issue #495 review, round 2): without it the server
    // refuses the return with a 409 and the re-engage cannot load the agent.
    expect(SRC.slice(gateDef, gateDef + 200)).toContain("agentHasBot === true");
    // ...and a `test` agent only where `/teste` activated it (issue #495 review, round 11). The
    // server answers `errors.returnAgentTestSilent` there, so the button would be a 409 with a
    // click on it. Read off the EPISODE's activation, which is what `testActivatedAt` on the detail
    // already carries (issue #261) and the same question the server asks.
    expect(SRC.slice(gateDef, gateDef + 900)).toContain(
      'conv.agentMode !== "test" || conv.testActivatedAt != null',
    );
    // ...and when it hides them it SAYS SO (issue #495 review, round 13). Hiding on its own leaves
    // the operator looking for a button that is not there, unable to tell a rule from a bug — and
    // this predicate reads the mirror, so on the one conversation where it is wrong they had nothing
    // to go on at all.
    expect(SRC).toContain(
      "const noResponder: { label: string; detail: string } | null =",
    );
    for (const key of [
      "conversation.responderOff",
      "conversation.responderObserves",
      "conversation.responderNoBot",
      "conversation.responderTestSilent",
      // ...and the inbox with NO responder at all, which round 13 excluded on the theory that the
      // panel above already says it (issue #495 review, round 16). It does not: with nobody
      // assigned that line prints the generic "AI" label, which names an answerer this inbox does
      // not have, and with a person on it it prints their name — either way the three actions
      // vanish with nothing on screen saying why.
      "conversation.responderNone",
    ]) {
      expect(SRC).toContain(key);
    }
    // ...each with a SHORT label beside it, which is what sits in the action row; the sentence is
    // behind the row's `?` (issue #494 manual test). A sentence dropped into a flex line of buttons
    // wraps and moves the navigation, and the condition is three words even when the remediation is
    // not.
    for (const key of [
      "conversation.responderNoneShort",
      "conversation.responderOffShort",
      "conversation.responderObservesShort",
      "conversation.responderNoBotShort",
      "conversation.responderTestSilentShort",
    ]) {
      expect(SRC).toContain(key);
    }
    expect(SRC.replace(/\s+/g, " ")).toContain(
      "<HelpPopover content={noResponder.detail} label={noResponder.label} />",
    );
    // The exclusion itself, and not merely the key: the guard that short-circuits this chain must
    // no longer name `agentId == null`, or the string above is dead code.
    const reasonDef = SRC.indexOf(
      "const noResponder: { label: string; detail: string } | null =",
    );
    expect(
      SRC.slice(reasonDef, SRC.indexOf("? null", reasonDef)),
    ).not.toContain("conv.agentId == null");

    const returnCall = SRC.indexOf('"conversation.returned"');
    const returnGate = SRC.lastIndexOf(
      '{conv.status !== "resolved" &&',
      returnCall,
    );
    expect(SRC.slice(returnGate, returnCall)).toContain("responderAnswers");

    const reopenCall = SRC.indexOf('"conversation.reopened"');
    expect(reopenCall).toBeGreaterThan(-1);
    const reopenGate = SRC.lastIndexOf(
      '{conv.status === "resolved" &&',
      reopenCall,
    );
    expect(reopenGate).toBeGreaterThan(-1);
    expect(SRC.slice(reopenGate, reopenCall)).toContain("responderAnswers");

    const reengageGate = SRC.indexOf("{offerReengage &&");
    expect(SRC.slice(reengageGate, reengageGate + 160)).toContain(
      "responderAnswers",
    );

    const handoff = SRC.indexOf(".handoff.post(");
    const handoffGate = SRC.lastIndexOf("{conv.status ===", handoff);
    expect(SRC.slice(handoffGate, handoff)).not.toContain("responderAnswers");

    // ...INCLUDING THE FAILURE CARD'S OWN BUTTON (issue #495 review, round 1). It calls the same
    // endpoint, which answers `no-agent` on an inbox nothing answers, and a conversation keeps its
    // `lastError` long after its responder was unbound — so it outlives the header offer it was
    // gated beside.
    const failureCard = SRC.indexOf("conversation.reengage.failedTitle");
    expect(failureCard).toBeGreaterThan(-1);
    const failureAction = SRC.indexOf(
      '"conversation.reengage.action"',
      failureCard,
    );
    expect(failureAction).toBeGreaterThan(-1);
    expect(SRC.slice(failureCard, failureAction)).toContain("responderAnswers");
  });
});
