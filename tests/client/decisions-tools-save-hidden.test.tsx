/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
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
  initial: Record<string, unknown> = AGENT,
  grants: unknown[] = GRANTS,
): { method: string; path: string; body: unknown }[] {
  let stored = grants;
  let agent = initial;
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
    // The agent PATCH stores what it was sent, as the server does.
    if (method === "PATCH" && url.pathname === "/api/v1/agents/1") {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      delete sent.expectedUpdatedAt;
      agent = {
        ...agent,
        ...sent,
        updatedAt: `2026-01-0${(asked.length % 9) + 1}T00:00:00.000Z`,
      };
      routes["PATCH /api/v1/agents/1"] = { agent };
    }
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

// Save tools is enabled only with an edit on the tab (agents#1365): toggle a tool questions and
// rules draws, so the save has something of its own to write next to the hidden configuration.
async function saveToolsEdited() {
  const privateNote = await waitFor(() => {
    const el = document.getElementById(nativeToolAnchor("private_note"));
    if (!el) throw new Error("the private_note card is not there yet");
    return el;
  });
  fireEvent.click(focusableIn(privateNote) ?? privateNote);
  await waitFor(() =>
    expect((button("Save") as HTMLButtonElement)?.disabled).toBe(false),
  );
  fireEvent.click(button("Save"));
}

test("a close label removed on the language model is not saved by a Tools save on questions and rules", async () => {
  const asked = stubApi(READY_TO_DECIDE);
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
  await waitFor(() => expect(text().includes("Save")).toBe(true));
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
  await saveToolsEdited();

  // The engine switch goes out first, with General; the Tools PATCH is the last one.
  await waitFor(() => expect(text().includes("Tools updated.")).toBe(true));
  const patch = asked.filter((a) => a.method === "PATCH").at(-1);
  if (!patch) throw new Error("no PATCH");
  const settingsSent = (patch.body as { settings: Record<string, unknown> })
    .settings;
  expect(JSON.stringify(settingsSent.resolveConversation)).toBe(
    JSON.stringify({ assignLabels: ["vip"] }),
  );
  // The draft is the language model's, so it is pending on the editor and not on this Tools tab.
  await waitFor(() => expect(text().includes("Tools updated.")).toBe(true));
  const toolsTab = [...document.querySelectorAll('[role="tab"]')].find((t) =>
    t.textContent?.includes("Tools"),
  );
  expect(
    `${toolsTab?.querySelector(".bg-warning") !== null} ${Boolean(button("Discard all"))}`,
  ).toBe("false true");
});

// The same holds for the grants: a tool this engine does not draw, revoked on the language model
// before the switch, stays granted through a Tools save on questions and rules.
test("a hidden tool revoked on the language model stays granted through a Tools save on questions and rules", async () => {
  const asked = stubApi(READY_TO_DECIDE);
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
  await saveToolsEdited();
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
  await waitFor(() => expect(Boolean(button("Save"))).toBe(true));
  fireEvent.click(button("Save"));
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
  const asked = stubApi(READY_TO_DECIDE);
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
  await saveToolsEdited();
  const put = await waitFor(() => {
    const p = asked.find((a) => a.method === "PUT");
    if (!p) throw new Error("no PUT yet");
    return p;
  });
  await waitFor(() =>
    expect(asked.some((a) => a.method === "PATCH")).toBe(true),
  );
  await waitFor(() => expect(text().includes("Tools updated.")).toBe(true));
  // Every grant write of the save, not just the first: the Knowledge save, which this engine does not
  // draw, must not follow the Tools one with the hidden draft.
  const sentRag = asked
    .filter((a) => a.method === "PUT")
    .some((w) =>
      (w.body as { grants: { source: string }[] }).grants.some(
        (g) => g.source === "RAG",
      ),
    );
  expect(put).toBeDefined();
  await engine("llm");
  await tab("Knowledge");
  await waitFor(() => expect(text().includes("FAQ do SAC")).toBe(true));
  expect(`${sentRag} ${Boolean(button("Discard"))}`).toBe("false true");
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
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

// On the language model, with a complete decision setup already stored: the switch to questions and
// rules can be saved, and the bar saves it with the rest of the agent (agents#1520).
const READY_TO_DECIDE = {
  ...AGENT,
  settings: {
    ...AGENT.settings,
    monitoring: {
      engine: "llm",
      decisions: {
        provider: "typesafe",
        credentialRef: "vault:12",
        questions: [
          { name: "pede_reembolso", type: "yes_no", instructions: "Pede?" },
        ],
        rules: [
          {
            when: [{ question: "pede_reembolso", minProbability: 0.7 }],
            action: { tool: "set_labels", args: { add: ["reembolso"] } },
          },
        ],
      },
    },
  },
};

const DECIDING = {
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
            action: { tool: "set_labels", args: { add: ["reembolso"] } },
          },
        ],
      },
    },
  },
};

// The questions and rules are drawn only for a monitoring agent. Edited, then hidden by a switch to
// Production and a General save, they are still the operator's: leaving still asks about them.
test("questions and rules edited before a switch to answering keep the editor unsaved", async () => {
  const asked = stubApi(DECIDING);
  renderAt("/agents/1/decisions");
  await waitFor(() => expect(Boolean(button("Add question"))).toBe(true));
  fireEvent.click(button("Add question"));
  await waitFor(() => expect(Boolean(button("Discard all"))).toBe(true));
  await tab("General");
  fireEvent.click(screen.getByRole("radio", { name: /^Production/ }));
  fireEvent.click(button("Save"));
  await waitFor(() =>
    expect(asked.some((a) => a.method === "PATCH")).toBe(true),
  );
  await waitFor(() => expect(text().includes("Production")).toBe(true));
  expect(Boolean(button("Discard all"))).toBe(true);
});

// The suggestion reviewer is Knowledge's, which questions and rules do not draw: edited before the
// switch, "Save and export" refuses instead of writing it unseen.
test("a reviewer edited on the language model is a hidden draft on questions and rules", async () => {
  const asked = stubApi();
  renderAt("/agents/1/knowledge");
  const provider = await waitFor(() => {
    const el = [...document.querySelectorAll<HTMLSelectElement>("select")].find(
      (e) => [...e.options].some((o) => o.text === "Same as the agent"),
    );
    if (!el) throw new Error("the reviewer provider is not there yet");
    return el;
  });
  fireEvent.change(provider, { target: { value: "openai" } });
  await engine("decisions");
  fireEvent.click(button("Export"));
  await waitFor(() => expect(Boolean(button("Save and export"))).toBe(true));
  fireEvent.click(button("Save and export"));
  await waitFor(() =>
    expect(text().includes("questions and rules do not use")).toBe(true),
  );
  // The call-floor estimate is a POST that writes nothing.
  expect(
    asked.filter((a) => a.method !== "GET" && !a.path.endsWith("/call-floor"))
      .length,
  ).toBe(0);
});

// A tool toggled on questions and rules while Save tools is in flight was not in the grants that
// request wrote: the form keeps it, and the Tools tab still reads unsaved once the save lands.
test("a tool toggled while Save tools is in flight stays unsaved on questions and rules", async () => {
  const asked = stubApi(DECIDING);
  const served = globalThis.fetch;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let putSent = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") {
      putSent = true;
      await held;
    }
    return served(input, init);
  }) as typeof fetch;
  renderAt("/agents/1/tools");
  const privateNote = await waitFor(() => {
    const el = document.getElementById(nativeToolAnchor("private_note"));
    if (!el) throw new Error("the private_note card is not there yet");
    return el;
  });
  // An edit so Save tools has something to write.
  fireEvent.click(focusableIn(privateNote) ?? privateNote);
  await waitFor(() => expect(Boolean(button("Discard"))).toBe(true));
  fireEvent.click(button("Save"));
  await waitFor(() => expect(putSent).toBe(true));
  // While the grants PUT is held, enable handoff.
  const handoff = document.getElementById(
    nativeToolAnchor("handoff_to_human"),
  ) as HTMLElement;
  fireEvent.click(focusableIn(handoff) ?? handoff);
  release();
  await waitFor(() =>
    expect(asked.some((a) => a.method === "PATCH")).toBe(true),
  );
  await waitFor(() => expect(text().includes("Tools updated.")).toBe(true));
  const put = asked.find((a) => a.method === "PUT") as { body: unknown };
  const sentHandoff = (
    put.body as { grants: { source: string; enabledTools?: string[] }[] }
  ).grants
    .find((g) => g.source === "NATIVE")
    ?.enabledTools?.includes("handoff_to_human");
  expect(`${Boolean(sentHandoff)} ${Boolean(button("Discard"))}`).toBe(
    "false true",
  );
});

// The guidance questions and rules do not draw is written as stored, byte for byte: a Tools save
// that tidied it would store a value the form does not hold, and the editor would then read a hidden
// draft nobody made.
test("a Tools save on questions and rules writes hidden guidance verbatim", async () => {
  const spaced = {
    ...DECIDING,
    settings: {
      ...DECIDING.settings,
      toolGuidance: { set_labels: "  nota com espaço  " },
      kanban: { instructions: "funil \n" },
      handoff: { mode: "auto", instructions: " passe adiante " },
    },
  };
  const asked = stubApi(spaced);
  renderAt("/agents/1/tools");
  await saveToolsEdited();
  const patch = await waitFor(() => {
    const p = asked.find((a) => a.method === "PATCH");
    if (!p) throw new Error("no PATCH yet");
    return p;
  });
  const sent = (patch.body as { settings: Record<string, unknown> }).settings;
  expect(
    JSON.stringify([
      sent.toolGuidance,
      (sent.kanban as { instructions?: unknown }).instructions,
      (sent.handoff as { instructions?: unknown }).instructions,
    ]),
  ).toBe(
    JSON.stringify([
      { set_labels: "  nota com espaço  " },
      "funil \n",
      " passe adiante ",
    ]),
  );
});

// The engine switched back while a Tools save on questions and rules is out: the request wrote the
// language model's settings as stored, so the edit made there before the switch is still unsaved.
test("a switch back to the language model while Save tools is out keeps its draft unsaved", async () => {
  const asked = stubApi(READY_TO_DECIDE);
  const served = globalThis.fetch;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let putSent = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") {
      putSent = true;
      await held;
    }
    return served(input, init);
  }) as typeof fetch;
  renderAt("/agents/1/tools");
  await waitFor(() => expect(text().includes("Save")).toBe(true));
  // Remove "vip" from "Labels on close", a setting questions and rules do not draw.
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
  await engine("decisions");
  await tab("Tools");
  await saveToolsEdited();
  await waitFor(() => expect(putSent).toBe(true));
  await engine("llm");
  release();
  await waitFor(() =>
    expect(asked.some((a) => a.method === "PATCH")).toBe(true),
  );
  await waitFor(() => expect(text().includes("Tools updated.")).toBe(true));
  // The engine switch went out first, with General; the Tools PATCH is the last one.
  const patch = asked.filter((a) => a.method === "PATCH").at(-1) as {
    body: unknown;
  };
  const sent = (patch.body as { settings: Record<string, unknown> }).settings;
  expect(
    `${JSON.stringify(sent.resolveConversation)} ${Boolean(button("Discard all"))}`,
  ).toBe(`${JSON.stringify({ assignLabels: ["vip"] })} true`);
});

// Two rules that each need a tool not granted: while the first Allow is written, the second waits.
// Both would replace the grant set built from the same saved copy and version, and the server would
// refuse the second as a conflict nobody caused.
test("a second Allow waits while the first grant is written", async () => {
  const twoRules = {
    ...DECIDING,
    settings: {
      ...DECIDING.settings,
      monitoring: {
        engine: "decisions",
        decisions: {
          ...DECIDING.settings.monitoring.decisions,
          rules: [
            {
              when: [{ question: "pede_reembolso", minProbability: 0.7 }],
              action: { tool: "private_note", args: { content: "ver" } },
            },
            {
              when: [{ question: "pede_reembolso", minProbability: 0.9 }],
              action: { tool: "handoff_to_human", args: {} },
            },
          ],
        },
      },
    },
  };
  const asked = stubApi(twoRules, [
    { ...GRANTS[0], enabledTools: ["set_labels"] },
  ]);
  const served = globalThis.fetch;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") await held;
    return served(input, init);
  }) as typeof fetch;
  renderAt("/agents/1/decisions");
  const allows = await waitFor(() => {
    const b = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="decisions-rule-grant"]',
      ),
    ];
    if (b.length < 2) throw new Error("the Allow buttons are not there yet");
    return b;
  });
  fireEvent.click(allows[0] as HTMLElement);
  fireEvent.click(allows[1] as HTMLElement);
  const waiting = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="decisions-rule-grant"]',
    ),
  ].every((b) => b.disabled);
  release();
  await waitFor(() =>
    expect(asked.filter((a) => a.method === "PUT").length).toBe(1),
  );
  expect(`${waiting} ${asked.filter((a) => a.method === "PUT").length}`).toBe(
    "true 1",
  );
});

// The case inbox is not drawn on questions and rules and goes back as stored, so a legacy key the
// console would refuse today does not stop a Tools save there: nobody on this engine can fix it.
test("a stored case key the console would refuse does not block a Tools save on questions and rules", async () => {
  const legacy = {
    ...DECIDING,
    settings: {
      ...DECIDING.settings,
      crossInboxCase: { caseAttributeKey: "invalid-key" },
    },
  };
  const asked = stubApi(legacy);
  renderAt("/agents/1/tools");
  await saveToolsEdited();
  const patch = await waitFor(() => {
    const p = asked.find((a) => a.method === "PATCH");
    if (!p) throw new Error("no PATCH yet");
    return p;
  });
  const sent = (patch.body as { settings: Record<string, unknown> }).settings;
  expect(JSON.stringify(sent.crossInboxCase)).toBe(
    JSON.stringify({ caseAttributeKey: "invalid-key" }),
  );
});

// A note over its cap on a field questions and rules do not draw (the handoff instructions) has no
// control on that engine, so its warning, and the Fix that would open a tab without the field, go
// with the engine that draws it.
test("a capped note the decisions engine does not draw raises no warning there", async () => {
  const long = "x".repeat(20_000);
  const read = async (engine: "llm" | "decisions") => {
    stubApi({
      ...DECIDING,
      settings: {
        ...DECIDING.settings,
        handoff: { mode: "auto", instructions: long },
        monitoring: { ...DECIDING.settings.monitoring, engine },
      },
    });
    renderAt("/agents/1/general");
    await waitFor(() => expect(text().includes("Observadora")).toBe(true));
    const warned = text().includes("handoff.instructions holds");
    cleanup();
    return warned;
  };
  expect(`${await read("llm")} ${await read("decisions")}`).toBe("true false");
});
