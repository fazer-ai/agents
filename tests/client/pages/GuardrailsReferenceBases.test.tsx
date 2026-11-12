/// <reference lib="dom" />

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import * as AuthModule from "@/client/contexts/AuthContext";
import type { GuardrailsRefusals } from "@/client/pages/agents/types";
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from "@/modules/guardrails/settings";
import { stubExports } from "@/tests/utils/module-stub";

// The reference bases of the factual-grounding section: the same selectable cards the Knowledge tab
// picks the agent's bases with, and a pick lands in the form. Made-up bases.

stubExports(AuthModule, {
  useAuth: () => ({
    user: { id: "1", email: "admin@example.com", role: "TENANT_ADMIN" },
    loading: false,
    logout: async () => {},
  }),
});
const { ToastProvider } = await import("@/client/components/Toast");
const { GuardrailsTab } = await import("@/client/pages/agents/GuardrailsTab");

const NO_REFUSALS: GuardrailsRefusals = {
  credential: null,
  decisionsCredential: null,
  customPolicy: null,
  inputTemplateMessage: null,
  outputTemplateMessage: null,
  outputGenerationPrompt: null,
  inputHandoffMessage: null,
  outputHandoffMessage: null,
  externalUrl: null,
  externalSecret: null,
  groundingCredential: null,
};

const BASES = [
  {
    id: "11",
    name: "Regras da casa",
    description: "Prazos",
    unindexedCount: 0,
  },
  { id: "12", name: "Catálogo", description: null, unindexedCount: 0 },
];

let previousFetch: typeof globalThis.fetch;
beforeAll(() => {
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ tools: [], entries: [] }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
});
afterEach(() => cleanup());
afterAll(() => {
  globalThis.fetch = previousFetch;
});

let saved: GuardrailsConfig | null = null;
function Stateful({ initial }: { initial: GuardrailsConfig }) {
  const [g, setG] = useState(initial);
  saved = g;
  return (
    <GuardrailsTab
      agentId="7"
      guardrails={g}
      setGuardrails={setG as never}
      refusals={NO_REFUSALS}
      dirty={false}
      saving={false}
      onSave={() => {}}
      onDiscard={() => {}}
      knowledgeBases={BASES}
    />
  );
}

function mount(referenceKnowledgeBaseIds: string[]) {
  const c = structuredClone(GUARDRAILS_DEFAULTS);
  c.enabled = true;
  c.factualGrounding = {
    ...c.factualGrounding,
    enabled: true,
    referenceKnowledgeBaseIds,
  };
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ToastProvider>
          <Stateful initial={c} />
        </ToastProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const card = (name: string) =>
  screen
    .getAllByRole("checkbox")
    .find((el) => el.textContent?.includes(name)) as HTMLElement;

test("each base is a selectable card in the section, and a pick lands in the form", () => {
  mount(["12"]);
  const section = document.querySelector(
    '[data-testid="gr-grounding-reference"]',
  );
  const inSection = !!section?.contains(card("Regras da casa"));
  const before = [
    card("Regras da casa").getAttribute("aria-checked"),
    card("Catálogo").getAttribute("aria-checked"),
  ];
  fireEvent.click(card("Regras da casa"));
  const picked = saved?.factualGrounding.referenceKnowledgeBaseIds;
  fireEvent.click(card("Catálogo"));
  expect([
    inSection,
    before,
    picked,
    saved?.factualGrounding.referenceKnowledgeBaseIds,
  ]).toEqual([true, ["false", "true"], ["12", "11"], ["11"]]);
});

test("a picked base deleted since is dropped by the next pick, or on its own from the line below the cards", () => {
  mount(["99", "12"]);
  const line = !!screen.queryByText(/no longer exist/);
  fireEvent.click(card("Regras da casa"));
  const afterPick = saved?.factualGrounding.referenceKnowledgeBaseIds;
  cleanup();
  mount(["99", "12"]);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect([
    line,
    afterPick,
    saved?.factualGrounding.referenceKnowledgeBaseIds,
  ]).toEqual([true, ["12", "11"], ["12"]]);
});
