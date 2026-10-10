import { expect, test } from "bun:test";
import { alertLinks, buildAlertBody } from "@/modules/flowlog/alert-send";

// A tripped account breaker stops every agent's proactive messages until someone acts, so its alert
// goes straight to the card that resumes it, raises the limit or turns it off.

const tripped = {
  type: "discord",
  stage: "proactive_breaker",
  level: "error",
  summary:
    "[proactive_breaker] Proactive messages paused for the whole account: 3 proactive messages were delivered in the last 24 hours (limit 3).",
  count: 1,
  tenantId: 4n,
  turnId: "t1",
  conversationId: 77n,
  causeKey: null,
  agentId: null,
} as const;

test("the trip links to the breaker's card, with or without an agent", () => {
  for (const agentId of [null, 12n]) {
    const links = alertLinks({ ...tripped, agentId });
    expect(links.at(-1)?.label).toBe("Resume or change the limit");
    expect(links.at(-1)?.url).toContain(
      "/resources/advanced?section=proactive-breaker&switchTenant=4",
    );
  }
  const { rawBody } = buildAlertBody(tripped);
  expect(rawBody).toContain("limit 3");
  expect(rawBody).toContain("/resources/advanced?section=proactive-breaker");
});

test("the card link is only for the breaker", () => {
  expect(
    alertLinks({ ...tripped, stage: "proactive_limit" }).map((l) => l.label),
  ).not.toContain("Resume or change the limit");
});
