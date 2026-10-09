import { expect, test } from "bun:test";
import { alertLinks, buildAlertBody } from "@/modules/flowlog/alert-send";
import { turnLimitLogMessage } from "@/modules/turn-limit/service";

// A tripped turn limit during legitimate use must not leave the operator guessing: the alert names
// the limit and the count, and links to the conversation and to the setting that raises it.

const tripped = {
  type: "discord",
  stage: "turn_limit",
  level: "error",
  summary: `[turn_limit] ${turnLimitLogMessage(3, 3, true)}`,
  count: 1,
  tenantId: 4n,
  turnId: "t1",
  conversationId: 77n,
  causeKey: null,
  agentId: 12n,
} as const;

test("a turn limit alert links to the conversation and to the agent's limit", () => {
  const links = alertLinks(tripped);
  expect(links.map((l) => l.label)).toEqual([
    "View log",
    "View conversation",
    "Change the limit",
  ]);
  expect(links[1]?.url).toContain("/conversations/77");
  expect(links[2]?.url).toContain(
    "/agents/12/behavior?focus=limits&switchTenant=4",
  );
});

test("the link to the setting is only for the turn limit, and only with an agent", () => {
  expect(
    alertLinks({ ...tripped, stage: "spend_ceiling" }).map((l) => l.label),
  ).not.toContain("Change the limit");
  expect(
    alertLinks({ ...tripped, agentId: null }).map((l) => l.label),
  ).not.toContain("Change the limit");
});

test("the body names the limit and the count", () => {
  const { rawBody } = buildAlertBody(tripped);
  expect(rawBody).toContain("Turn limit reached");
  expect(rawBody).toContain("replied 3 times");
  expect(rawBody).toContain("limit 3");
  expect(rawBody).toContain("/agents/12/behavior?focus=limits");
});

// The generic webhook is the other channel the alert goes through, and a receiver that forwards it to
// a person needs the same places to act.
test("the generic webhook carries the same links", () => {
  const body = JSON.parse(
    buildAlertBody({ ...tripped, type: "webhook" }).rawBody,
  ) as { links: { label: string; url: string }[] };
  expect(body.links).toEqual(alertLinks(tripped));
  expect(body.links.map((l) => l.url).join(" ")).toContain(
    "/agents/12/behavior?focus=limits&switchTenant=4",
  );
});
