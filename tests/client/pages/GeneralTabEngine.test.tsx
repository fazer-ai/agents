/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { DecisionsSetupMissing } from "@/client/pages/agents/EngineChoice";
import { GeneralTab } from "@/client/pages/agents/GeneralTab";
import type { DecisionsIssue } from "@/modules/decisions/config";

// General follows the engine (agents#1224): on questions and rules the instructions and the Model
// card are REPLACED by the classifier, not drawn disabled, and the Save stays off while the setup
// cannot be written, with a line saying what is missing. Assertions reduce to numbers and booleans
// before expect: a DOM node in a failing expectation stalls the runner.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
function stubApi(): void {
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const MODEL = {
  provider: "openai",
  model: "gpt-6-luna",
  credentialRef: "",
  baseURL: "",
  temperature: "",
  reasoningEffort: "",
  promptCache: "",
  promptCacheTtl: "",
  promptCacheConversationTtl: "",
};

function renderGeneral(watcher?: {
  decides: boolean;
  saveBlocked: boolean;
}): void {
  stubApi();
  const noop = () => {};
  render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <TooltipProvider>
            <GeneralTab
              name="Monitor"
              setName={noop}
              systemPrompt="Observe."
              setSystemPrompt={noop}
              enabled
              setEnabled={noop}
              mode="monitoring"
              setMode={noop}
              model={MODEL}
              setModel={noop}
              modelCredBaseUrl={null}
              dirty
              saving={false}
              onSave={noop}
              onDiscard={noop}
              onDelete={noop}
              watcher={
                watcher && {
                  ...watcher,
                  engineCards: <div data-testid="engine-cards" />,
                  classifier: <div data-testid="classifier" />,
                }
              }
            />
          </TooltipProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const count = (id: string) => screen.queryAllByTestId(id).length;
const hasText = (s: string) => (document.body.textContent ?? "").includes(s);
const saveOff = () =>
  (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled;

describe("General for a monitoring agent", () => {
  test("on questions and rules, the classifier replaces the instructions and the model", () => {
    renderGeneral({ decides: true, saveBlocked: false });
    expect(count("engine-cards")).toBe(1);
    expect(count("classifier")).toBe(1);
    expect(hasText("Agent instructions")).toBe(false);
    expect(document.getElementById("general-model") === null).toBe(true);
    expect(saveOff()).toBe(false);
  });

  test("on the language model, the instructions and the model are back and no classifier", () => {
    renderGeneral({ decides: false, saveBlocked: false });
    expect(count("engine-cards")).toBe(1);
    expect(count("classifier")).toBe(0);
    expect(hasText("Agent instructions")).toBe(true);
    expect(document.getElementById("general-model") === null).toBe(false);
  });

  test("the Save stays off while the setup cannot be written", () => {
    renderGeneral({ decides: true, saveBlocked: true });
    expect(saveOff()).toBe(true);
  });

  test("an answering agent has no engine at all", () => {
    renderGeneral();
    expect(count("engine-cards")).toBe(0);
    expect(hasText("Agent instructions")).toBe(true);
  });
});

const issue = (code: string): DecisionsIssue => ({
  path: [],
  code,
  message: "",
  params: {},
});

describe("what is still missing to save the setup", () => {
  function renderMissing(paths: string[]): string {
    render(
      <MemoryRouter>
        <DecisionsSetupMissing
          issues={new Map(paths.map((p) => [p, issue("x")]))}
          onOpenDecisions={() => {}}
        />
      </MemoryRouter>,
    );
    return screen.queryByTestId("engine-missing")?.textContent ?? "";
  }

  test("names the key and the missing question, each where it is fixed", () => {
    const text = renderMissing(["credentialRef", "questions"]);
    expect(text.includes("API key")).toBe(true);
    expect(text.includes("at least one question")).toBe(true);
    expect(text.includes("Open Questions and rules")).toBe(true);
  });

  test("a classifier problem alone does not send the operator to the other tab", () => {
    const text = renderMissing(["credentialRef"]);
    expect(text.includes("API key")).toBe(true);
    expect(text.includes("Open Questions and rules")).toBe(false);
  });

  test("says nothing when nothing is missing", () => {
    expect(renderMissing([])).toBe("");
  });
});
