/// <reference lib="dom" />

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import { MemoryRouter, Route, Routes } from "react-router";
import { nativeToolAnchor } from "@/client/pages/agents/editorTabs";
import { focusableIn } from "@/client/pages/agents/saveAttempt";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
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
  // The grants as stored: a PUT replaces them and answers with them, as the server does.
  let storedGrants: unknown[] = opts.grants ?? [];
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
      if (method === "PUT")
        storedGrants = (body.grants as Record<string, unknown>[]).map((g) => ({
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds: [],
          enabledTools: [],
          ...g,
        }));
      return json({
        grants: storedGrants,
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

// The catalog with every native tool, so the Tools tab draws a card to toggle (`editTab("tools")`).
export const NATIVE_CATALOG = {
  native: NATIVE_TOOL_NAMES.map((name) => ({ name })),
};

// An edit to a tab, for a test that is about what the save does: every Save is disabled until its tab
// has an edit (agents#1206, agents#1365). Tools toggles the private-note card, so its stub needs a
// catalog with the natives (NATIVE_CATALOG).
export function editTab(tab: string): void {
  const panel =
    document.querySelector<HTMLElement>('[role="tabpanel"]') ?? document.body;
  if (tab === "general") {
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    fireEvent.change(name, { target: { value: `${name.value} (editado)` } });
  } else if (tab === "behavior") {
    const n = panel.querySelector<HTMLInputElement>('input[type="number"]');
    if (!n) throw new Error("no number field on Behavior");
    fireEvent.change(n, { target: { value: String(Number(n.value) + 1) } });
  } else if (tab === "knowledge") {
    const select = panel.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("no select on Knowledge");
    const other = [...select.options].find(
      (o) => o.value && o.value !== select.value,
    );
    if (!other) throw new Error("the Knowledge select has one option");
    fireEvent.change(select, { target: { value: other.value } });
  } else if (tab === "tools") {
    const card = document.getElementById(nativeToolAnchor("private_note"));
    if (!card) throw new Error("the private_note card is not drawn");
    fireEvent.click(focusableIn(card) ?? card);
  } else if (tab === "decisions") {
    fireEvent.click(screen.getByRole("button", { name: "Customer sentiment" }));
  } else if (tab === "guardrails") {
    fireEvent.click(screen.getByRole("switch", { name: /Enable guardrails/ }));
  } else if (tab === "channelRedirect") {
    const message = document.querySelector("textarea");
    if (!message) throw new Error("the redirect message is not drawn");
    fireEvent.change(message, {
      target: { value: "Continue pelo site: {link}" },
    });
  }
}
