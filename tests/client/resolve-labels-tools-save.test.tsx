/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
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

// The Tools save writes the grants first and the settings after, so a clash the PATCH refuses has
// to be caught before the grants PUT, or the tools change while the save reports a failure. The
// editor is rendered against a stubbed API that already stores a label the close assigns; making
// that label off limits on the set_labels card and saving must refuse with no write at all.
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
    enabledTools: ["resolve_conversation", "set_labels"],
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
  name: "Ana",
  systemPrompt: "Você atende.",
  modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
  businessHoursId: null,
  followUpHoursId: null,
  transferWithSummary: false,
  enabled: true,
  mode: "production",
  settings: {
    setLabels: { protected: [] },
    resolveConversation: { assignLabels: ["vip"] },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// Every request the page makes, as "METHOD /path". A path the stub does not know answers 404, which
// every optional read on the page already treats as "nothing there".
function stubApi(): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    asked.push(`${method} ${url.pathname}`);
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

async function saveWithProtectedLabels(labels: string): Promise<string[]> {
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
  // The second card with settings is set_labels (resolve_conversation sits before it).
  const settings = [...document.querySelectorAll("button")].filter(
    (b) => b.getAttribute("aria-label") === "Settings",
  );
  fireEvent.click(settings[1] as HTMLElement);
  const field = await waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. agente-off, testando-agente"]',
    );
    if (!input) throw new Error("the off-limits field is not there yet");
    return input;
  });
  fireEvent.change(field, { target: { value: labels } });
  const save = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Save tools",
  );
  fireEvent.click(save as HTMLElement);
  return asked;
}

const writes = (asked: string[]) =>
  asked.filter((a) => !a.startsWith("GET ")).join(", ");

describe("the editor refuses the clash before the grants are written", () => {
  test("a label made off limits while the close assigns it is refused, and nothing is written", async () => {
    const asked = await saveWithProtectedLabels("vip");
    await waitFor(() =>
      expect(
        text().includes(
          "Labels on close cannot hold a label off limits to set_labels: vip.",
        ),
      ).toBe(true),
    );
    expect(writes(asked)).toBe("");
  });

  test("a label the close does not assign saves the grants and then the settings", async () => {
    const asked = await saveWithProtectedLabels("outra");
    await waitFor(() =>
      expect(writes(asked)).toBe(
        "PUT /api/v1/agents/1/tool-selections, PATCH /api/v1/agents/1",
      ),
    );
  });
});
