/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, screen } from "@testing-library/react";
import ptBR from "@/client/locales/pt-BR.json";
import { configIssueMessage } from "@/modules/agents/config-health-message";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// The editor's tabs follow the work (set up, try, connect), and a configuration warning says what to
// do and opens the place to do it, rather than naming the internal state.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function open(seed: Parameters<typeof stubEditorApi>[0]) {
  await renderEditor(stubEditorApi(seed), "general");
  await act(async () => {});
}

function lookup(bag: unknown, key: string): string | undefined {
  let node: unknown = bag;
  for (const segment of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

const tabNames = () =>
  screen.getAllByRole("tab").map((t) => t.textContent ?? "");
const warnings = () =>
  [...document.querySelectorAll("li")]
    .filter((li) => li.querySelector("button"))
    .map((li) => ({
      text: li.querySelector("span")?.textContent ?? "",
      button: li.querySelector("button")?.textContent ?? "",
    }));

describe("the editor of a text agent", () => {
  test("draws its own settings before Tools, and Channels last, after the Playground", async () => {
    await open({});
    expect(tabNames()).toEqual([
      "General",
      "Behavior",
      "Guardrails",
      "Redirect",
      "Tools",
      "Knowledge",
      "Playground",
      "Channels",
    ]);
  });

  // The catalog is not loaded under test, so the button is read off the editor and the sentence off
  // the renderer the editor uses, with the Portuguese catalog.
  test("a model that cannot be built says what to choose, and its button opens the model", async () => {
    await open({ modelConfig: { provider: "not-a-provider", model: "x" } });
    expect(warnings().map((w) => w.button)).toContain("Set up the model");
    const text = configIssueMessage(
      { key: "modelNotRunnable", tab: "general" },
      { translate: (key) => lookup(ptBR, key) ?? "", guardrailLastError: "" },
    );
    expect(text).toBe(
      "Escolha um provedor, um modelo e uma chave de API para o agente responder.",
    );
  });

  test("a model with no key asks for one by name, under the picker and on the warning", async () => {
    await open({});
    expect(warnings().map((w) => w.button)).toContain("Choose a key");
    expect(warnings().map((w) => w.button)).not.toContain("Fix");
    expect(
      screen.getAllByText("Select an API key to use this feature.").length,
    ).toBeGreaterThan(0);
  });
});
