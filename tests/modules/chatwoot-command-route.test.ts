// WHICH DELIVERY RUNS THE COMMAND: the decision table.
//
// Chatwoot fans one command out to the conversation's assigned bot AND the inbox's, so the same
// `/teste` arrives twice with two route ids and exactly one delivery may run it. The fence fails
// CLOSED on an unresolvable identity on either side, and the two closed answers mean different
// things to whoever reads the log line: one delivery deferring to a persona that will run it, versus
// no persona existing at all and every route dropping the command (issue #317).
import { describe, expect, test } from "bun:test";
import {
  type CommandRoute,
  commandRoute,
} from "@/modules/chatwoot/command-route";

describe("commandRoute", () => {
  const cases: [
    label: string,
    personaBotId: number | null,
    deliveryBotId: number | null,
    expected: CommandRoute["reason"],
  ][] = [
    ["the inbox's own persona, on its own route", 9, 9, "ours"],
    ["another persona's route", 9, 8, "other_route"],
    // Fails closed: an unattributed route is not evidence that this is the right one, and the
    // persona's own delivery still carries its id.
    ["an unattributed route, persona known", 9, null, "other_route"],
    // No identity on the inbox's agent: EVERY route lands here, so nobody runs the command.
    ["no persona identity, delivery attributed", null, 9, "no_persona"],
    ["no persona identity, unattributed route", null, null, "no_persona"],
    // The id belonging to nobody is still not ours: equality is the whole test, never truthiness.
    ["persona 0, delivery 0", 0, 0, "ours"],
    ["persona 0, delivery 9", 0, 9, "other_route"],
  ];

  for (const [label, persona, delivery, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      const route = commandRoute(persona, delivery);
      expect(route.reason).toBe(expected);
      // The id the line reports comes back WITH the verdict, so the report cannot read the ids a
      // second time and answer something else.
      expect("personaBot" in route ? route.personaBot : null).toBe(
        expected === "other_route" ? persona : null,
      );
    });
  }
});
