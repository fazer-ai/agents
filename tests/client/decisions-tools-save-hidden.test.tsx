/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const { AgentEditorPage } = await import(
  "@/client/pages/agents/AgentEditorPage"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { NATIVE_TOOL_NAMES, RAG_TOOL_NAMES } = await import(
  "@/graph/tools/catalog"
);

// A Tools save on questions and rules writes the configuration of the tools that engine does not
// draw as stored. An edit made on the language model before the switch (here, a label removed from
// "Labels on close") stays a draft for a switch back rather than being saved unseen.
//
// Assertions reduce to strings or booleans before `expect`: a failing expectation that holds a DOM
// node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const GRANTS = [
  {
    source: "NATIVE",
    toolDefinitionId: null,
    mcpServerConnectionId: null,
    integrationInstanceId: null,
    documentTemplateId: null,
    codeToolDefinitionId: null,
    knowledgeBaseIds: [],
    enabledTools: ["resolve_conversation", "set_labels", "private_note"],
  },
];

const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  knowledgeBases: [],
  codeTools: [],
  documentTemplates: [],
};

const AGENT = {
  id: "1",
  name: "Observadora",
  systemPrompt: "Você observa.",
  modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
  businessHoursId: null,
  followUpHoursId: null,
  transferWithSummary: true,
  enabled: true,
  mode: "monitoring",
  settings: {
    setLabels: { protected: [] },
    resolveConversation: { assignLabels: ["vip"] },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function stubApi(): { method: string; path: string; body: unknown }[] {
  const asked: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    asked.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const routes: Record<string, unknown> = {
      "GET /api/auth/me": {
        user: { id: "1", email: "a@b.c", role: "ADMIN" },
      },
      "GET /api/v1/agents/1": { agent: AGENT },
      "GET /api/v1/agents/1/tool-selections": {
        grants: GRANTS,
        catalog: CATALOG,
      },
      "PUT /api/v1/agents/1/tool-selections": {
        grants: GRANTS,
        catalog: CATALOG,
        agentUpdatedAt: "2026-01-02T00:00:00.000Z",
      },
      "PATCH /api/v1/agents/1": {
        agent: { ...AGENT, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
      "GET /api/v1/business-hours": { businessHours: [] },
      "GET /api/v1/tenant-settings": {
        embedding: { credentialRef: null },
        langfuse: { sendContent: false },
      },
    };
    const body = routes[`${method} ${url.pathname}`];
    return new Response(JSON.stringify(body ?? { error: "not found" }), {
      status: body === undefined ? 404 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return asked;
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLElement;

test("a close label removed on the language model is not saved by a Tools save on questions and rules", async () => {
  const asked = stubApi();
  render(
    <MemoryRouter initialEntries={["/agents/1/tools"]}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <NavGuardProvider>
              <Routes>
                <Route path="/agents/:id/:tab" element={<AgentEditorPage />} />
              </Routes>
            </NavGuardProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(text().includes("Save tools")).toBe(true));
  // The first card with settings is resolve_conversation; its chip "vip" has a Remove button.
  const settings = [...document.querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-label") === "Settings",
  );
  fireEvent.click(settings[0] as HTMLElement);
  const remove = await waitFor(() => {
    const b = document.querySelector<HTMLElement>(
      'button[aria-label="Remove"]',
    );
    if (!b) throw new Error("the close label chip is not there yet");
    return b;
  });
  fireEvent.click(remove);

  // Switch to questions and rules on General, then save Tools there.
  fireEvent.click(
    [...document.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent?.includes("General"),
    ) as HTMLElement,
  );
  const decisions = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="engine-decisions"]',
    );
    if (!el) throw new Error("the engine cards are not there yet");
    return el;
  });
  fireEvent.click(decisions);
  fireEvent.click(
    [...document.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent?.includes("Tools"),
    ) as HTMLElement,
  );
  await waitFor(() => expect(Boolean(button("Save tools"))).toBe(true));
  fireEvent.click(button("Save tools"));

  const patch = await waitFor(() => {
    const p = asked.find((a) => a.method === "PATCH");
    if (!p) throw new Error("no PATCH yet");
    return p;
  });
  const settingsSent = (patch.body as { settings: Record<string, unknown> })
    .settings;
  expect(JSON.stringify(settingsSent.resolveConversation)).toBe(
    JSON.stringify({ assignLabels: ["vip"] }),
  );
});
