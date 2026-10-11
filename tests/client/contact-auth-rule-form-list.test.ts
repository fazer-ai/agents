import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  contactAuthGateEmpty,
  contactAuthRulePayload,
  EMPTY_CONTACT_AUTH_RULE_FORM,
  readContactAuthEndpointEnabled,
  readContactAuthRuleForm,
} from "@/client/pages/agents/contactAuthRuleForm";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

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

describe("an enabled gate with nothing to decide", () => {
  test("is empty only when on, with no conditions and no endpoint", () => {
    const base = { enabled: true, ruleConditions: [], endpointEnabled: false };
    expect(contactAuthGateEmpty(base)).toBe(true);
    expect(contactAuthGateEmpty({ ...base, enabled: false })).toBe(false);
    expect(contactAuthGateEmpty({ ...base, endpointEnabled: true })).toBe(
      false,
    );
    expect(contactAuthGateEmpty({ ...base, ruleConditions: [{}] })).toBe(false);
  });
});

// "Save and export" saves every dirty section without the Behavior tab's Save button, so it refuses
// the empty gate itself, before writing any section, and then does not export.
describe("save and export with an enabled gate that decides nothing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  async function saveAndExport(removeTheCondition: boolean) {
    const stub = stubEditorApi({
      settings: {
        contactAuth: { enabled: true, rule: { kind: "label", label: "vip" } },
      },
    });
    await renderEditor(stub, "general");
    fireEvent.change(screen.getByDisplayValue("Atendente"), {
      target: { value: "Atendente 2" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /Behavior/ }));
    if (removeTheCondition) {
      fireEvent.click(
        await screen.findByRole("button", { name: "Remove condition" }),
      );
    } else {
      fireEvent.change(await screen.findByDisplayValue("vip"), {
        target: { value: "vip2" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and export" }),
    );
    return stub;
  }

  test("is refused before any section is written, and nothing is exported", async () => {
    const stub = await saveAndExport(true);
    // NOTE: the toast and the gate's own line under the rule say the same sentence.
    await screen.findAllByText(
      "Add at least one condition or turn on the external endpoint, or turn the gate off.",
    );
    expect(stub.writes).toEqual([]);
    expect(stub.requests.filter((r) => r.endsWith("/export"))).toEqual([]);
  });

  test("a gate with a condition saves both sections and exports", async () => {
    const stub = await saveAndExport(false);
    await waitFor(() =>
      expect(stub.requests.some((r) => r.endsWith("/export"))).toBe(true),
    );
    expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(2);
  });
});
