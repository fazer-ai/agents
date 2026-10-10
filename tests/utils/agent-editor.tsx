/// <reference lib="dom" />

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { render, screen } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import { MemoryRouter, Route, Routes } from "react-router";
import { withI18n } from "./i18n";

// The agent editor, rendered whole against a stubbed API: what it loads is the agent and grants given
// here, and every write it makes is recorded with its method, path and JSON body.

const { AgentEditorPage } = await import(
  "@/client/pages/agents/AgentEditorPage"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");

export interface EditorWrite {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface EditorAgent {
  id?: string;
  name?: string;
  systemPrompt?: string;
  enabled?: boolean;
  mode?: string;
  modelConfig?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

const EMPTY_CATALOG = {
  native: [],
  rag: [],
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  codeTools: [],
  documentTemplates: [],
  knowledgeBases: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export interface EditorStub {
  writes: EditorWrite[];
  // Every request, reads included, as `METHOD /path`.
  requests: string[];
  // The agent as the server holds it now: a PATCH merges into it, so a reload reads what was saved.
  agent: Record<string, unknown>;
  // A handler that answers before the defaults, for a test that needs one route to behave otherwise.
  override?: (
    method: string,
    path: string,
    body: Record<string, unknown>,
  ) => Response | Promise<Response> | undefined;
}

export function stubEditorApi(
  seed: EditorAgent,
  opts: { catalog?: Record<string, unknown>; grants?: unknown[] } = {},
): EditorStub {
  // NOTE: every editor opens in a fresh tab: what another file left in storage (a tenant, a remembered
  // choice) would otherwise change what this one renders.
  sessionStorage.clear();
  localStorage.clear();
  const id = seed.id ?? "41";
  const stub: EditorStub = {
    writes: [],
    requests: [],
    agent: {
      id,
      name: seed.name ?? "Atendente",
      systemPrompt: seed.systemPrompt ?? "Você atende.",
      modelConfig: seed.modelConfig ?? {
        provider: "openai",
        model: "gpt-4o-mini",
      },
      businessHoursId: null,
      followUpHoursId: null,
      transferWithSummary: false,
      enabled: seed.enabled ?? true,
      mode: seed.mode ?? "production",
      settings: seed.settings ?? {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  let version = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const raw = init?.body ?? null;
    const body =
      typeof raw === "string" && raw.length > 0
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
    const path = url.pathname;
    stub.requests.push(`${method} ${path}`);
    if (method !== "GET") stub.writes.push({ method, path, body });
    const answered = stub.override?.(method, path, body);
    if (answered) return await answered;
    if (path === "/api/auth/me") return json({ user: null });
    if (path === `/api/v1/agents/${id}/tool-selections`) {
      return json({
        grants: opts.grants ?? [],
        catalog: { ...EMPTY_CATALOG, ...(opts.catalog ?? {}) },
        agentUpdatedAt: stub.agent.updatedAt,
      });
    }
    if (path === `/api/v1/agents/${id}`) {
      if (method === "PATCH") {
        version += 1;
        const { expectedUpdatedAt: _, ...patch } = body;
        stub.agent = {
          ...stub.agent,
          ...patch,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, version)).toISOString(),
        };
      }
      return json({ agent: stub.agent });
    }
    if (path === "/api/v1/business-hours") return json({ businessHours: [] });
    if (path === "/api/v1/tenant-settings") {
      return json({
        embedding: { credentialRef: null },
        langfuse: { sendContent: null },
      });
    }
    // A read nobody stubbed answers as missing, which every optional read on the page tolerates.
    return method === "GET" ? json({ error: "not stubbed" }, 404) : json({});
  }) as unknown as typeof fetch;
  return stub;
}

// Renders the editor on one tab and waits until the loaded agent's name is on screen (the header).
// `tab` may carry a query (`"guardrails?from=/conversations/7"`). `i18n` is for a test that reads a
// sentence only the catalog holds (`createTestI18n` with resources); `state` is the navigation state
// the page is opened with (an import's warnings).
export async function renderEditor(
  stub: EditorStub,
  tab = "general",
  i18n?: I18n,
  state?: unknown,
): Promise<void> {
  const [segment, query] = tab.split("?");
  const pathname = `/agents/${stub.agent.id}/${segment}`;
  render(
    withI18n(
      <MemoryRouter
        initialEntries={[{ pathname, search: query ? `?${query}` : "", state }]}
      >
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <TooltipPrimitive.Provider>
                <Routes>
                  <Route
                    path="/agents/:id/:tab"
                    element={<AgentEditorPage />}
                  />
                </Routes>
              </TooltipPrimitive.Provider>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
      i18n,
    ),
  );
  await screen.findAllByText(String(stub.agent.name), undefined, {
    timeout: 5_000,
  });
}

// The settings bag of the last PATCH that carried one.
export function lastSavedSettings(
  stub: EditorStub,
): Record<string, unknown> | undefined {
  const patch = [...stub.writes]
    .reverse()
    .find((w) => w.method === "PATCH" && w.body.settings !== undefined);
  return patch?.body.settings as Record<string, unknown> | undefined;
}
