import { describe, expect, test } from "bun:test";
import {
  contactAuthAskEndpointToSave,
  contactAuthRulePayload,
  EMPTY_CONTACT_AUTH_RULE_FORM,
  readContactAuthEndpointEnabled,
  readContactAuthRuleForm,
} from "@/client/pages/agents/contactAuthRuleForm";

// The editor holds the gate's rule as ONE list of conditions and the endpoint as one switch, while
// the stored shape and the runtime stay as they are: what is stored loads into the list and saves
// back to the same meaning, and the switch reads from what the runtime would do with the stored bag.

describe("what is stored loads as a list and saves back to the same meaning", () => {
  test("a plain rule is a list of one, and saves back as the plain rule", () => {
    const stored = { kind: "label", label: "suporte" };
    const form = readContactAuthRuleForm(stored);
    expect(form.ruleConditions.length).toBe(1);
    expect(contactAuthRulePayload(form)).toEqual(stored);
  });

  test("a combination keeps its match and its rows", () => {
    const stored = {
      kind: "any",
      conditions: [
        { kind: "conversation_type", type: "group" },
        { kind: "label", label: "suporte" },
      ],
    };
    const form = readContactAuthRuleForm(stored);
    expect(form.ruleMatch).toBe("any");
    expect(form.ruleConditions.length).toBe(2);
    expect(contactAuthRulePayload(form)).toEqual(stored);
  });

  test("a combination of one saves as that one condition, which means the same", () => {
    const form = readContactAuthRuleForm({
      kind: "all",
      conditions: [{ kind: "conversation_type", type: "group" }],
    });
    expect(form.ruleConditions.length).toBe(1);
    expect(contactAuthRulePayload(form)).toEqual({
      kind: "conversation_type",
      type: "group",
    });
  });

  test("no conditions is no rule", () => {
    expect(readContactAuthRuleForm(undefined).ruleConditions.length).toBe(0);
    expect(contactAuthRulePayload(EMPTY_CONTACT_AUTH_RULE_FORM)).toBeNull();
  });

  test("the endpoint switch reads from what the runtime would do", () => {
    const rule = readContactAuthRuleForm({ kind: "label", label: "x" });
    const none = readContactAuthRuleForm(undefined);
    // Beside conditions: only the stored flag, strictly; a url left there with the flag off is unused.
    expect(readContactAuthEndpointEnabled(rule, "https://a.test", false)).toBe(
      false,
    );
    expect(readContactAuthEndpointEnabled(rule, "https://a.test", true)).toBe(
      true,
    );
    expect(readContactAuthEndpointEnabled(rule, "https://a.test", "true")).toBe(
      false,
    );
    // No conditions: the endpoint decides alone when there is one to ask.
    expect(readContactAuthEndpointEnabled(none, "https://a.test", false)).toBe(
      true,
    );
    expect(readContactAuthEndpointEnabled(none, "", true)).toBe(false);
    expect(readContactAuthEndpointEnabled(none, null, false)).toBe(false);
  });
});

describe("what the save writes for the endpoint flag", () => {
  test("a responder writes the switch as shown", () => {
    expect(contactAuthAskEndpointToSave(true, false, false)).toBe(true);
    expect(contactAuthAskEndpointToSave(false, false, true)).toBe(false);
  });

  test("a monitoring agent, which draws no switch, writes the stored flag back as it was", () => {
    // An endpoint-only gate loads with the switch on (inferred from the url); saving it must not
    // turn a stored `false` into `true`, or a later return to production would ask the endpoint.
    expect(contactAuthAskEndpointToSave(true, true, false)).toBe(false);
    expect(contactAuthAskEndpointToSave(true, true, undefined)).toBe(false);
    expect(contactAuthAskEndpointToSave(false, true, true)).toBe(true);
    expect(contactAuthAskEndpointToSave(true, true, "true")).toBe(false);
  });
});
