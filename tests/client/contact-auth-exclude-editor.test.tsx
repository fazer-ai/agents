/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  contactAuthRulePayload,
  readContactAuthRuleForm,
} from "@/client/pages/agents/contactAuthRuleForm";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// The editor asks what a match means from the first condition on: serve only it (the default), or serve every conversation except it. The choice loads from the stored rule and saves back on it.

const STAFF = {
  kind: "allowlist",
  phones: ["5511988887777"],
  identifiers: [],
  effect: "exclude",
};

describe("the effect loads from the rule and saves back on it", () => {
  test("an exclusion list round-trips as an exclusion", () => {
    const form = readContactAuthRuleForm(STAFF);
    expect(form.ruleEffect).toBe("exclude");
    expect(contactAuthRulePayload(form)).toEqual(STAFF);
  });

  test("a combination keeps its effect on the combination, never on a condition", () => {
    const stored = {
      kind: "any",
      conditions: [
        { kind: "label", label: "equipe" },
        { kind: "conversation_type", type: "group" },
      ],
      effect: "exclude",
    };
    expect(contactAuthRulePayload(readContactAuthRuleForm(stored))).toEqual(
      stored,
    );
  });

  test("a rule with no effect loads as serve and saves with no key", () => {
    const stored = { kind: "label", label: "vip" };
    const form = readContactAuthRuleForm(stored);
    expect(form.ruleEffect).toBe("serve");
    expect(contactAuthRulePayload(form)).toEqual(stored);
  });
});

describe("choosing the effect in the editor", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  const SERVE = "Only who meets the conditions Everyone else is refused.";
  const EXCLUDE =
    "Everyone, except who meets the conditions To leave a few contacts out, like the team's own numbers.";
  const option = (name: string) =>
    screen.queryByRole("radio", { name }) as HTMLInputElement | null;
  const defaultLine = () =>
    screen.queryAllByText(
      "Off: this agent answers every contact on its inboxes.",
    ).length;

  async function open(rule: unknown, enabled = true) {
    const stub = stubEditorApi({
      settings: {
        contactAuth: {
          enabled,
          rule,
          denyMessage: null,
          handoffEnabled: true,
          operatorNoteEnabled: false,
        },
      },
    });
    await renderEditor(stub, "behavior");
    await screen.findAllByText("Who this agent serves");
    return stub;
  }

  function savedRule(stub: ReturnType<typeof stubEditorApi>) {
    const patch = stub.writes.find((w) => w.method === "PATCH");
    const settings = patch?.body.settings as
      | { contactAuth?: { rule?: unknown } }
      | undefined;
    return settings?.contactAuth?.rule;
  }

  test("a stored exclusion shows as every conversation except, and turning it to serve saves no effect", async () => {
    const stub = await open(STAFF);
    expect(option(EXCLUDE)?.checked).toBe(true);
    const serve = option(SERVE);
    if (!serve) throw new Error("expected the serve option");
    fireEvent.click(serve);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedRule(stub)).toBeDefined());
    expect(savedRule(stub)).toEqual({
      kind: "allowlist",
      phones: ["5511988887777"],
      identifiers: [],
    });
  });

  test("choosing every conversation except saves the effect on the rule", async () => {
    const stub = await open({ kind: "label", label: "equipe" });
    expect(option(SERVE)?.checked).toBe(true);
    const exclude = option(EXCLUDE);
    if (!exclude) throw new Error("expected the exclude option");
    fireEvent.click(exclude);
    // NOTE: with the exclusion chosen, how two rows combine reads as what leaves a conversation out.
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    expect(
      screen.queryAllByText("Leave a conversation out when it meets").length,
    ).toBe(1);
    const removes = screen.getAllByRole("button", { name: "Remove condition" });
    const added = removes.at(-1);
    if (!added) throw new Error("expected the added row");
    fireEvent.click(added);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedRule(stub)).toBeDefined());
    expect(savedRule(stub)).toEqual({
      kind: "label",
      label: "equipe",
      effect: "exclude",
    });
  });

  test("switched off, the section says the agent answers every contact", async () => {
    await open(null, false);
    expect(defaultLine()).toBe(1);
    expect(option(SERVE)).toBeNull();
  });

  test("switched on with no condition yet, both choices are on screen and serve is chosen", async () => {
    await open(null, false);
    fireEvent.click(
      screen.getByRole("switch", { name: "Only answer authorized contacts" }),
    );
    expect(defaultLine()).toBe(0);
    expect(option(SERVE)?.checked).toBe(true);
    expect(option(EXCLUDE)?.checked).toBe(false);
  });
});
