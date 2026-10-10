/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const { AgentEditorPage } = await import(
  "@/client/pages/agents/AgentEditorPage"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { nativeToolAnchor } = await import("@/client/pages/agents/editorTabs");
const { focusableIn } = await import("@/client/pages/agents/saveAttempt");
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
    enabledTools: [
      "resolve_conversation",
      "set_labels",
      "private_note",
      "skip_reply",
    ],
  },
];

const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  knowledgeBases: [{ id: "kb1", name: "FAQ do SAC", description: null }],
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

function stubApi(
  agent: Record<string, unknown> = AGENT,
  grants: unknown[] = GRANTS,
): { method: string; path: string; body: unknown }[] {
  let stored = grants;
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
      "GET /api/v1/agents/1": { agent },
      "GET /api/v1/agents/1/tool-selections": {
        grants: stored,
        catalog: CATALOG,
      },
      "PATCH /api/v1/agents/1": {
        agent: { ...agent, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
      "GET /api/v1/business-hours": { businessHours: [] },
      "GET /api/v1/tenant-settings": {
        embedding: { credentialRef: null },
        langfuse: { sendContent: false },
      },
    };
    // The grants PUT stores what it was sent, as the server does.
    if (
      method === "PUT" &&
      url.pathname === "/api/v1/agents/1/tool-selections"
    ) {
      stored = (
        JSON.parse(String(init?.body)) as { grants: unknown[] }
      ).grants.map((g) => ({
        toolDefinitionId: null,
        mcpServerConnectionId: null,
        integrationInstanceId: null,
        documentTemplateId: null,
        codeToolDefinitionId: null,
        knowledgeBaseIds: [],
        enabledTools: [],
        ...(g as object),
      }));
      routes[`${method} ${url.pathname}`] = {
        grants: stored,
        catalog: CATALOG,
        agentUpdatedAt: "2026-01-02T00:00:00.000Z",
      };
    }
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

// The same holds for the grants: a tool this engine does not draw, revoked on the language model
// before the switch, stays granted through a Tools save on questions and rules.
test("a hidden tool revoked on the language model stays granted through a Tools save on questions and rules", async () => {
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
  const skip = await waitFor(() => {
    const el = document.getElementById(nativeToolAnchor("skip_reply"));
    if (!el) throw new Error("the skip_reply card is not there yet");
    return el;
  });
  fireEvent.click(focusableIn(skip) ?? skip);
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
  const put = await waitFor(() => {
    const p = asked.find((a) => a.method === "PUT");
    if (!p) throw new Error("no PUT yet");
    return p;
  });
  const native = (
    put.body as { grants: { source: string; enabledTools?: string[] }[] }
  ).grants.find((g) => g.source === "NATIVE");
  expect((native?.enabledTools ?? []).includes("skip_reply")).toBe(true);
});

const tab = async (name: string) => {
  const el = await waitFor(() => {
    const e = [...document.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent?.includes(name),
    );
    if (!e) throw new Error(`the ${name} tab is not there yet`);
    return e as HTMLElement;
  });
  fireEvent.click(el);
};
const engine = async (value: "llm" | "decisions") => {
  await tab("General");
  const el = await waitFor(() => {
    const e = document.querySelector<HTMLElement>(
      `[data-testid="engine-${value}"]`,
    );
    if (!e) throw new Error("the engine cards are not there yet");
    return e;
  });
  fireEvent.click(el);
};

// An Allow on questions and rules adds the rule's tool to the form as it stands: a tool revoked on
// the language model before the switch stays revoked, for the next save there.
test("an Allow keeps a hidden revocation made on the language model", async () => {
  const decidingAgent = {
    ...AGENT,
    settings: {
      ...AGENT.settings,
      monitoring: {
        engine: "decisions",
        decisions: {
          provider: "typesafe",
          credentialRef: "vault:12",
          questions: [
            { name: "pede_reembolso", type: "yes_no", instructions: "Pede?" },
          ],
          rules: [
            {
              when: [{ question: "pede_reembolso", minProbability: 0.7 }],
              action: { tool: "private_note", args: { content: "ver" } },
            },
          ],
        },
      },
    },
  };
  const grants = [{ ...GRANTS[0], enabledTools: ["set_labels", "skip_reply"] }];
  const asked = stubApi(decidingAgent, grants);
  render(
    <MemoryRouter initialEntries={["/agents/1/general"]}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <NavGuardProvider>
              <TooltipProvider>
                <Routes>
                  <Route
                    path="/agents/:id/:tab"
                    element={<AgentEditorPage />}
                  />
                </Routes>
              </TooltipProvider>
            </NavGuardProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  // Revoke skip_reply on the language model, then back to questions and rules.
  await engine("llm");
  await tab("Tools");
  const skip = await waitFor(() => {
    const el = document.getElementById(nativeToolAnchor("skip_reply"));
    if (!el) throw new Error("the skip_reply card is not there yet");
    return el;
  });
  fireEvent.click(focusableIn(skip) ?? skip);
  await engine("decisions");
  await tab("Questions and rules");
  const allow = await waitFor(() => {
    const b = document.querySelector<HTMLElement>(
      '[data-testid="decisions-rule-grant"]',
    );
    if (!b) throw new Error("the Allow button is not there yet");
    return b;
  });
  fireEvent.click(allow);
  await waitFor(() =>
    expect(asked.filter((a) => a.method === "PUT").length).toBe(1),
  );
  // Back on the language model, a Tools save writes the revocation and the allowed tool.
  await engine("llm");
  await tab("Tools");
  await waitFor(() => expect(Boolean(button("Save tools"))).toBe(true));
  fireEvent.click(button("Save tools"));
  const put = await waitFor(() => {
    const puts = asked.filter((a) => a.method === "PUT");
    if (puts.length < 2) throw new Error("no second PUT yet");
    return puts[1] as { body: unknown };
  });
  const native = (
    put.body as { grants: { source: string; enabledTools?: string[] }[] }
  ).grants.find((g) => g.source === "NATIVE");
  const tools = native?.enabledTools ?? [];
  expect(
    `${tools.includes("skip_reply")} ${tools.includes("private_note")}`,
  ).toBe("false true");
});

// Knowledge is not drawn on questions and rules either: a base granted on the language model before
// the switch is not written by a Tools save there, and Knowledge still reads unsaved afterwards.
test("a Knowledge draft made on the language model stays unsaved through a Tools save on questions and rules", async () => {
  const asked = stubApi();
  render(
    <MemoryRouter initialEntries={["/agents/1/knowledge"]}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <NavGuardProvider>
              <TooltipProvider>
                <Routes>
                  <Route
                    path="/agents/:id/:tab"
                    element={<AgentEditorPage />}
                  />
                </Routes>
              </TooltipProvider>
            </NavGuardProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  const retrieval = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[role='switch']");
    if (!el) throw new Error("the retrieval switch is not there yet");
    return el;
  });
  fireEvent.click(retrieval);
  const base = await waitFor(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>("[role='checkbox'], button"),
    ].find((b) => b.textContent?.includes("FAQ do SAC"));
    if (!el) throw new Error("the knowledge base card is not there yet");
    return el;
  });
  fireEvent.click(base);
  await waitFor(() => expect(Boolean(button("Discard"))).toBe(true));
  await engine("decisions");
  await tab("Tools");
  await waitFor(() => expect(Boolean(button("Save tools"))).toBe(true));
  fireEvent.click(button("Save tools"));
  const put = await waitFor(() => {
    const p = asked.find((a) => a.method === "PUT");
    if (!p) throw new Error("no PUT yet");
    return p;
  });
  const sentRag = (put.body as { grants: { source: string }[] }).grants.some(
    (g) => g.source === "RAG",
  );
  await waitFor(() =>
    expect(asked.some((a) => a.method === "PATCH")).toBe(true),
  );
  await engine("llm");
  await tab("Knowledge");
  await waitFor(() => expect(text().includes("FAQ do SAC")).toBe(true));
  expect(`${sentRag} ${Boolean(button("Discard"))}`).toBe("false true");
});
