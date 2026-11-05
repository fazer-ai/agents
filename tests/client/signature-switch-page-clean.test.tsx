/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const { AgentEditorPage } = await import(
  "@/client/pages/agents/AgentEditorPage"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { SIGNATURE_SEED } = await import(
  "@/client/pages/agents/signatureFormState"
);

// The Behavior tab as the operator sees it (agents#1440): the switch on and off again is no change, so
// nothing is marked unsaved. Both for an agent with no signature, where the switch seeds the box, and
// for one saved off with the seed as its text, which is what the bug itself left behind.
//
// Assertions reduce to strings or booleans before `expect`: a failing expectation that holds a DOM
// node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const AGENT = {
  id: "1",
  name: "Alex",
  systemPrompt: "Você atende.",
  modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
  businessHoursId: null,
  followUpHoursId: null,
  transferWithSummary: true,
  enabled: true,
  mode: "reply",
  settings: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function stubApi(settings: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const routes: Record<string, unknown> = {
      "GET /api/auth/me": {
        user: { id: "1", email: "a@b.c", role: "ADMIN" },
      },
      "GET /api/v1/agents/1": { agent: { ...AGENT, settings } },
      "GET /api/v1/agents/1/tool-selections": {
        grants: [],
        catalog: {
          native: [],
          rag: [],
          toolDefinitions: [],
          mcpConnections: [],
          integrationInstances: [],
          knowledgeBases: [],
          codeTools: [],
          documentTemplates: [],
        },
      },
      "GET /api/v1/business-hours": { businessHours: [] },
      "GET /api/v1/tenant-settings": {
        embedding: { credentialRef: null },
        langfuse: { sendContent: false },
      },
    };
    const body = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    return new Response(JSON.stringify(body ?? { error: "not found" }), {
      status: body === undefined ? 404 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const unsaved = () =>
  (document.body.textContent ?? "").includes("Unsaved changes");

async function onAndOff(settings: Record<string, unknown>): Promise<void> {
  stubApi(settings);
  render(
    <MemoryRouter initialEntries={["/agents/1/behavior"]}>
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
  const toggle = await waitFor(() =>
    screen.getByRole("switch", {
      name: /Add a signature to the agent's messages/i,
    }),
  );
  fireEvent.click(toggle);
  await waitFor(() => expect(unsaved()).toBe(true));
  fireEvent.click(toggle);
  await waitFor(() => expect(unsaved()).toBe(false));
}

// The case the issue reports: an agent with no signature, the switch on and off again.
test("on and off again on an agent with no signature leaves the Behavior tab clean", async () => {
  await onAndOff({});
});

test("on and off again over a saved signature leaves the Behavior tab clean", async () => {
  await onAndOff({ signature: { enabled: false, text: SIGNATURE_SEED } });
});
