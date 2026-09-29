import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Two conversation endpoints answer with an OUTCOME rather than a failure: `/return` can come back
// "taken-over" and `/reengage` "gate-closed" (among others), both with HTTP success on purpose. A
// handler that checks `error` alone shows a success toast that contradicts what the row now reads.
// Checked on the source because rendering this page pulls auth, theme, toast, realtime and a live
// conversation, and the branch under test is one `if`. The outcomes themselves are covered by
// tests/modules/tier3.test.ts; this fences new actions that drop them.
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

  // NOTE: an outcome that is neither a success nor a silence: `posted-partial` means the customer got part
  // of the answer, and the chain's final `else` says "The AI produced no reply", inviting a
  // re-engage that sends the part again. Asserted as PRESENCE of the arm, not absence from the
  // fallback: only "has its own branch" survives someone reordering the chain.
  test("a partial reply gets its own arm instead of the no-reply fallback", () => {
    const body = handlerBody("reengage");
    const arm = body.indexOf('"posted-partial"');
    expect(arm).toBeGreaterThan(-1);
    // NOTE: its own branch, and BEFORE the fallback: the chain is ordered, so an arm added after the
    // final `else` is unreachable.
    const fallback = body.indexOf("reengage.noReply");
    expect(fallback).toBeGreaterThan(arm);
    // And it says something about the partial delivery rather than reusing the success string.
    expect(body.slice(arm, fallback)).toContain("reengage.postedPartial");
  });

  // NOTE: the half a toast cannot fix: "Respond now" after a takeover invites the operator to talk over
  // the person who claimed it. Asserted as PRESENCE of the false write, not absence of the true one:
  // the offer is page state that outlives the action that raised it, so only "takes it down" is
  // safe. The server leaves the status `pending` here, so the JSX gate that hides the button after a
  // handoff does not close on this path.
  test("a taken-over return takes the re-engage offer down", () => {
    const body = handlerBody("returnToAi");
    const takeover = body.indexOf('"taken-over"');
    expect(takeover).toBeGreaterThan(-1);
    const elseAt = body.indexOf("} else {", takeover);
    expect(elseAt).toBeGreaterThan(takeover);
    const arm = body.slice(takeover, elseAt);
    expect(arm).toContain("setOfferReengage(false)");
    expect(arm).not.toContain("setOfferReengage(true)");
    // NOTE: the ordinary return still raises it, so the assertion above is about the takeover.
    expect(body.slice(elseAt)).toContain("setOfferReengage(true)");
  });

  // NOTE: the operator must still be able to RETRY: a takeover leaves the conversation `pending` with a
  // human on it, so buttons keyed on status alone would offer "Handoff to human" and hide "Return to
  // AI". The holder is the SERVER's answer, not `assigneeType === "User"`: a conversation assigned
  // to another persona's agent bot is equally out of this agent's hands, and only the server can
  // compare the bot id.
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

    // NOTE: it does not overlap "Reopen", which runs the SAME operation: keying the holder clause on
    // every status would show two differently labelled buttons for one action.
    expect(SRC.slice(returnGate, returnCall)).toContain('!== "resolved"');
    expect(SRC.slice(returnGate, returnCall)).toContain("heldByOther");

    // NOTE: "Respond now" asks the agent to speak, so it asks the same question. Read from the gate
    // to the LABEL rather than over a fixed window, since the gate has more than one clause.
    const reengageGate = SRC.indexOf("{mayReengage &&");
    expect(reengageGate).toBeGreaterThan(-1);
    const reengageLabel = SRC.indexOf(
      't("conversation.respondNow"',
      reengageGate,
    );
    expect(reengageLabel).toBeGreaterThan(reengageGate);
    expect(SRC.slice(reengageGate, reengageLabel)).toContain("!heldByOther");

    // NOTE: none of the three settles for the browser-side approximation. `isHuman` still exists for the
    // header's assignee line, so its presence in the file is not the thing being forbidden, only
    // its presence in these three gates.
    for (const gate of [
      SRC.slice(handoffGate, handoff),
      SRC.slice(returnGate, returnCall),
      SRC.slice(reengageGate, reengageLabel),
    ]) {
      expect(gate).not.toContain("isHuman");
    }
  });

  // NOTE: all three that hand the conversation TO the agent ask whether anything answers the inbox: a
  // responder bound, switched on, not in monitoring mode. Otherwise "Return to AI" would unassign
  // the person and nothing would pick it up; the server refuses it, and the console does not offer
  // it. "Handoff to human" needs no agent, so it is left out on purpose.
  test("handing the conversation to the agent is offered only when a responder answers the inbox", () => {
    const gateDef = SRC.indexOf("const responderAnswers =");
    expect(gateDef).toBeGreaterThan(-1);
    expect(SRC.slice(gateDef, gateDef + 200)).toContain(
      "agentEnabled === true",
    );
    expect(SRC.slice(gateDef, gateDef + 200)).toContain(
      'agentMode !== "monitoring"',
    );
    // NOTE: ...and the bot row behind the binding: without it the server refuses the return with a
    // 409 and the re-engage cannot load the agent.
    expect(SRC.slice(gateDef, gateDef + 200)).toContain("agentHasBot === true");
    // NOTE: ...and a `test` agent only where `/teste` activated it (the server answers
    // `errors.returnAgentTestSilent` otherwise). Read off the EPISODE's activation,
    // `testActivatedAt` on the detail, the same question the server asks.
    expect(SRC.slice(gateDef, gateDef + 900)).toContain(
      'conv.agentMode !== "test" || conv.testActivatedAt != null',
    );
    // NOTE: ...and when it hides them it SAYS SO: otherwise the operator cannot tell a rule from a
    // bug, and this predicate reads the mirror, so where it is wrong they would have nothing to go on.
    expect(SRC).toContain(
      "const noResponder: { label: string; detail: string } | null =",
    );
    for (const key of [
      "conversation.responderOff",
      "conversation.responderObserves",
      "conversation.responderNoBot",
      "conversation.responderTestSilent",
      // NOTE: ...including the inbox with NO responder at all: the panel above prints the generic
      // "AI" label (or a person's name), which does not explain why the three actions vanished.
      "conversation.responderNone",
    ]) {
      expect(SRC).toContain(key);
    }
    // NOTE: ...each with a SHORT label in the action row and the sentence behind the row's `?`: a
    // sentence in a flex line of buttons wraps and moves the navigation.
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

    const reengageGate = SRC.indexOf("{mayReengage &&");
    expect(reengageGate).toBeGreaterThan(-1);
    const reengageLabel = SRC.indexOf(
      't("conversation.respondNow"',
      reengageGate,
    );
    expect(SRC.slice(reengageGate, reengageLabel)).toContain(
      "responderAnswers",
    );

    const handoff = SRC.indexOf(".handoff.post(");
    const handoffGate = SRC.lastIndexOf("{conv.status ===", handoff);
    expect(SRC.slice(handoffGate, handoff)).not.toContain("responderAnswers");

    // NOTE: ...including the failure card's own button. It calls the same endpoint, which answers
    // `no-agent` on an inbox nothing answers, and a conversation keeps its `lastError` long after its
    // responder was unbound.
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
