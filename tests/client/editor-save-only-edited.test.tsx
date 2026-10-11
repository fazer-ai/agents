/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  type EditorAgent,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// A save writes what the operator edited and nothing else (agents#1206, agents#1304). A block the
// operator never touched stays exactly as stored, absent included: written out with the values the
// form showed, it would freeze today's defaults into the agent, so a later change of a default in
// the code no longer reaches it, and the stored settings stop saying what the operator chose.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const field = (label: RegExp): HTMLInputElement => {
  const el = screen.getByLabelText(label);
  if (!(el instanceof HTMLInputElement))
    throw new Error(`${label} is not an input`);
  return el;
};

const change = (el: Element, value: string) =>
  fireEvent.change(el, { target: { value } });

async function saveBehavior(
  seed: EditorAgent,
  edit?: () => void,
): Promise<{ before: unknown; after: Record<string, unknown> | undefined }> {
  const stub = stubEditorApi(seed);
  const before = structuredClone(stub.agent.settings);
  await renderEditor(stub, "behavior");
  edit?.();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Agent saved.");
  return { before, after: lastSavedSettings(stub) };
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

// An untouched Behavior tab has nothing to save (agents#1365): Save is disabled and nothing is sent.
async function untouched(seed: EditorAgent, edit?: () => void): Promise<void> {
  const stub = stubEditorApi(seed);
  await renderEditor(stub, "behavior");
  edit?.();
  await waitFor(() => expect(saveButton()).toHaveProperty("disabled", true));
  fireEvent.click(saveButton());
  expect(stub.writes.filter((w) => w.method === "PATCH")).toEqual([]);
}

// The guardrails' own on/off.
const mainSwitch = (): HTMLElement =>
  screen.getByRole("switch", { name: /Enable guardrails/ });

describe("Guardrails and Redirect: an untouched tab has nothing to save (agents#1206)", () => {
  for (const tab of ["guardrails", "channelRedirect"] as const) {
    test(`${tab}: Save is disabled on a fresh agent, and nothing is written`, async () => {
      const stub = stubEditorApi({ settings: {} });
      await renderEditor(stub, tab);
      expect(saveButton()).toHaveProperty("disabled", true);
      fireEvent.click(saveButton());
      expect(stub.writes.filter((w) => w.method === "PATCH")).toEqual([]);
    });
  }

  test("guardrails: an edit enables Save, undoing it disables Save again", async () => {
    const stub = stubEditorApi({ settings: {} });
    await renderEditor(stub, "guardrails");
    fireEvent.click(mainSwitch());
    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));
    fireEvent.click(mainSwitch());
    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", true));
  });

  test("guardrails: an edited save writes its block and no other", async () => {
    const stub = stubEditorApi({ settings: {} });
    await renderEditor(stub, "guardrails");
    fireEvent.click(mainSwitch());
    await waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));
    fireEvent.click(saveButton());
    await screen.findByText("Agent saved.");
    expect(Object.keys(lastSavedSettings(stub) ?? {})).toEqual(["guardrails"]);
  });
});

describe("Behavior writes the sections the operator edited (agents#1304)", () => {
  test("a reply agent with no settings, untouched, has nothing to save", async () => {
    await untouched({ settings: {} });
  });

  test("editing the wait window writes debounce and nothing else", async () => {
    const { after } = await saveBehavior({ settings: {} }, () =>
      change(field(/^Wait window \(s\)/), "25"),
    );
    expect(Object.keys(after ?? {})).toEqual(["debounce"]);
    const debounce = after?.debounce as Record<string, unknown> | undefined;
    expect(debounce?.windowSeconds).toBe(25);
  });

  // The serialization is lossy (`Number(x) || 15`): a stored 0 and a typed 15 serialize alike, so
  // the edit is judged on the form state, before it.
  test("a stored 0 changed to the default is an edit, and is written", async () => {
    const { after } = await saveBehavior(
      {
        settings: {
          debounce: {
            enabled: true,
            windowSeconds: 0,
            maxMessagesPerBurst: 20,
            maxWindowSeconds: 60,
          },
        },
      },
      () => change(field(/^Wait window \(s\)/), "15"),
    );
    const debounce = after?.debounce as Record<string, unknown> | undefined;
    expect(debounce?.windowSeconds).toBe(15);
  });

  test("editing and undoing leaves nothing to save", async () => {
    await untouched({ settings: {} }, () => {
      change(field(/^Wait window \(s\)/), "25");
      change(field(/^Wait window \(s\)/), "15");
    });
  });

  test("a block stored in part and never edited is not completed with defaults", async () => {
    const { after } = await saveBehavior(
      { settings: { debounce: { enabled: true } } },
      () => change(field(/^Max tool calls \/ turn/), "3"),
    );
    expect(after?.debounce).toEqual({ enabled: true });
  });

  test("editing split keeps the stored debounce and grounding as they are", async () => {
    const settings = {
      debounce: {
        enabled: true,
        windowSeconds: 30,
        maxMessagesPerBurst: 7,
        maxWindowSeconds: 90,
      },
      split: { enabled: true, maxChars: 500, typingWpm: 200, maxDelayMs: 5000 },
      grounding: { maxDistance: 0.4 },
    };
    const { after } = await saveBehavior({ settings }, () =>
      change(field(/^Max chars \/ message/), "450"),
    );
    expect(Object.keys(after ?? {}).sort()).toEqual([
      "debounce",
      "grounding",
      "split",
    ]);
    expect(after?.debounce).toEqual(settings.debounce);
    expect(after?.grounding).toEqual(settings.grounding);
    const split = after?.split as Record<string, unknown> | undefined;
    expect(split?.maxChars).toBe(450);
  });

  const monitoring = {
    engine: "decisions",
    analysis: "incremental",
    window: { messages: 12 },
    debounce: { windowSeconds: 45, maxWindowSeconds: 120 },
    decisions: {
      provider: "typesafe",
      model: "jev-latest",
      credentialRef: "vault:1",
      questions: [
        {
          name: "pede_reembolso",
          type: "yes_no",
          instructions: "O cliente pede o dinheiro de volta?",
        },
      ],
      rules: [
        {
          when: [{ question: "pede_reembolso", minProbability: 0.7 }],
          action: { tool: "set_labels", args: { add: ["reembolso"] } },
        },
      ],
    },
  };

  test("a watcher with only monitoring, untouched, has nothing to save", async () => {
    await untouched({ mode: "monitoring", settings: { monitoring } });
  });

  test("a watcher's burst window edit writes monitoring with the decision setup as stored", async () => {
    const { after } = await saveBehavior(
      { mode: "monitoring", settings: { monitoring } },
      () => change(field(/^Burst window \(seconds\)/), "50"),
    );
    expect(Object.keys(after ?? {})).toEqual(["monitoring"]);
    const m = after?.monitoring as Record<string, unknown>;
    expect((m.debounce as Record<string, unknown>).windowSeconds).toBe(50);
    expect(m.decisions).toEqual(monitoring.decisions);
    expect(m.engine).toBe(monitoring.engine);
    expect(m.analysis).toBe(monitoring.analysis);
    expect(m.window).toEqual(monitoring.window);
  });
});
