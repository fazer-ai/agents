/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { EngineCards } from "@/client/pages/agents/EngineChoice";
import { GeneralTab } from "@/client/pages/agents/GeneralTab";
import type { AgentMode } from "@/modules/agents/mode";

// Mode is the most consequential choice in the editor, so it is drawn as cards with a line each
// (agents#1254), from the same component as the engine choice: one named single-choice group, one
// radio per card, exactly one checked. Assertions reduce to strings, numbers and booleans before
// expect: a DOM node in a failing expectation stalls the runner.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

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

let picked: AgentMode[] = [];
function renderGeneral(mode: AgentMode): void {
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  picked = [];
  const noop = () => {};
  render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <TooltipProvider>
            <GeneralTab
              name="Agent"
              setName={noop}
              systemPrompt="Answer."
              setSystemPrompt={noop}
              enabled
              setEnabled={noop}
              mode={mode}
              setMode={(m) => {
                picked.push(m);
              }}
              model={MODEL}
              setModel={noop}
              modelCredBaseUrl={null}
              dirty={false}
              saving={false}
              onSave={noop}
              onDiscard={noop}
              onDelete={noop}
            />
          </TooltipProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const group = (name: string) => screen.getByRole("radiogroup", { name });
const radios = (g: HTMLElement) =>
  [...g.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => ({
    label: (r.closest("label")?.textContent ?? "").trim(),
    checked: r.checked,
    name: r.name,
  }));

describe("Mode on General is a group of cards", () => {
  test("three radios named Test, Production and Monitoring, exactly one checked", () => {
    renderGeneral("production");
    const rs = radios(group("Mode"));
    expect(rs.length).toBe(3);
    expect(rs.filter((r) => r.checked).length).toBe(1);
    expect(rs.find((r) => r.checked)?.label.startsWith("Production")).toBe(
      true,
    );
    // One radio name for the group: the browser makes it one Tab stop and moves with the arrows.
    expect(new Set(rs.map((r) => r.name)).size).toBe(1);
    expect((rs[0]?.name ?? "").length > 0).toBe(true);
  });

  test("each card says what the agent does in that mode", () => {
    renderGeneral("production");
    const [testCard, prodCard, monCard] = radios(group("Mode")).map(
      (r) => r.label,
    );
    expect(testCard?.includes("/teste")).toBe(true);
    expect(/every customer/i.test(prodCard ?? "")).toBe(true);
    expect(/never answers/i.test(monCard ?? "")).toBe(true);
    // Choosing monitoring changes the screen, and the card says so.
    expect(/tab/i.test(monCard ?? "")).toBe(true);
  });

  test("clicking a card picks it; clicking the checked one picks nothing", () => {
    renderGeneral("production");
    const input = (label: string) =>
      [
        ...group("Mode").querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        ),
      ].find((r) =>
        (r.closest("label")?.textContent ?? "").trim().startsWith(label),
      ) as HTMLInputElement;
    fireEvent.click(input("Production"));
    expect(picked.length).toBe(0);
    fireEvent.click(input("Monitoring"));
    expect(picked.join(",")).toBe("monitoring");
  });
});

describe("the engine cards and the mode cards are one component", () => {
  test("both groups carry the shared card structure", () => {
    renderGeneral("monitoring");
    cleanup();
    render(<EngineCards engine="decisions" onChange={() => {}} />);
    const engine = group("How it decides");
    const engineCards = radios(engine);
    expect(engineCards.length).toBe(2);
    expect(engineCards.filter((r) => r.checked).length).toBe(1);
    expect(engine.hasAttribute("data-choice-cards")).toBe(true);
    cleanup();
    renderGeneral("monitoring");
    expect(group("Mode").hasAttribute("data-choice-cards")).toBe(true);
  });
});
