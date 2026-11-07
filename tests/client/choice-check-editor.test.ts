/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  choiceCheckToForm,
  choiceCheckToStored,
} from "@/client/pages/agents/choiceCheckFormState";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The customer_choice judge's own model lives on the Tools tab, beside the rules it serves, and is
// saved by the Tools save in `settings.choiceCheck`.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const CHOICE_RULE = { send_orcamento: { kind: "customer_choice" } };

async function openTools(
  settings: Record<string, unknown>,
): Promise<EditorStub> {
  const stub = stubEditorApi(
    { settings },
    { catalog: { native: [{ name: "open_case_in_inbox" }] } },
  );
  await renderEditor(stub, "tools");
  await act(async () => {});
  return stub;
}

const judgeProvider = () =>
  document.getElementById("tools-choice-check")?.querySelector("select") ??
  null;

const savedChoiceCheck = (stub: EditorStub) =>
  stub.writes
    .filter((w) => w.method === "PATCH")
    .map(
      (w) =>
        (w.body.settings as Record<string, unknown> | undefined)?.choiceCheck,
    );

describe("the choice judge's model in the agent editor", () => {
  test("is drawn only while some rule asks for the customer's choice", async () => {
    await openTools({});
    expect(judgeProvider()).toBeNull();
    cleanup();
    await openTools({ toolPreconditions: CHOICE_RULE });
    expect(judgeProvider()).not.toBeNull();
  });

  test("the Tools save writes the picked model in settings.choiceCheck", async () => {
    const stub = await openTools({ toolPreconditions: CHOICE_RULE });
    const select = judgeProvider();
    if (!select) throw new Error("the judge's provider select is not drawn");
    fireEvent.change(select, { target: { value: "anthropic" } });
    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Save",
    );
    if (!save) throw new Error("no Save button");
    fireEvent.click(save);
    await waitFor(() =>
      expect(savedChoiceCheck(stub)).toEqual([
        {
          provider: "anthropic",
          model: null,
          credentialRef: null,
          baseURL: null,
        },
      ]),
    );
  });

  test("the stored block round-trips through the form, and an empty form is the agent's model", () => {
    const stored = {
      choiceCheck: {
        provider: "openai",
        model: "gpt-5.4-mini",
        credentialRef: "vw://k",
        baseURL: null,
      },
    };
    expect(choiceCheckToStored(choiceCheckToForm(stored))).toEqual(
      stored.choiceCheck,
    );
    expect(choiceCheckToStored(choiceCheckToForm({}))).toEqual({
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    });
  });
});
