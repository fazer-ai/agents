/// <reference lib="dom" />

import { afterEach, expect, jest, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router";

const { AgentEditorPage } = await import(
  "@/client/pages/agents/AgentEditorPage"
);
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { BreadcrumbProvider } = await import(
  "@/client/contexts/BreadcrumbContext"
);
const { Breadcrumbs } = await import("@/client/components/Breadcrumbs");

// The agent editor's tabs (agents#1647): a tab change is no history entry, so with an unsaved edit
// browser Back always leaves the agent (asking first), and Discard lands outside it, even after tabs
// seen before the edit. Real happy-dom history, no stubbed back().
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

function stubApi(agent: typeof AGENT): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const routes: Record<string, unknown> = {
      "GET /api/auth/me": {
        user: { id: "1", email: "a@b.c", role: "ADMIN" },
      },
      "GET /api/v1/agents/1": { agent },
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

let navigateTo: (to: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  navigateTo = navigate;
  return null;
}

function renderEditor(path: string, agent = AGENT) {
  stubApi(agent);
  (globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
    "http://localhost/agents",
  );
  window.history.replaceState(null, "");
  window.history.pushState({ idx: 1 }, "", path);
  render(
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <NavGuardProvider>
              <BreadcrumbProvider>
                <Navigator />
                <Breadcrumbs />
                <Routes>
                  <Route path="/agents" element={<p>Agent list</p>} />
                  <Route
                    path="/agents/:id/:tab"
                    element={<AgentEditorPage />}
                  />
                </Routes>
              </BreadcrumbProvider>
            </NavGuardProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>,
  );
}

const unsaved = () =>
  (document.body.textContent ?? "").includes("Unsaved changes");
const asking = () =>
  (document.body.textContent ?? "").includes("Discard changes?");
const selected = () =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ??
  "";
const signature = () =>
  screen.getByRole("switch", {
    name: /Add a signature to the agent's messages/i,
  });

test("a clean tab change follows in the URL in place, with no history entry of its own", async () => {
  renderEditor("/agents/1/behavior");
  await waitFor(() => signature());
  const entries = window.history.length;
  fireEvent.click(screen.getByRole("tab", { name: /General/ }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/agents/1/general"),
  );
  fireEvent.click(screen.getByRole("tab", { name: /Behavior/ }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/agents/1/behavior"),
  );
  expect(window.history.length).toBe(entries);
});

test("with an unsaved edit, browser Back asks once and Discard leaves the agent, even after tabs seen before the edit", async () => {
  renderEditor("/agents/1/behavior");
  await waitFor(() => signature());
  fireEvent.click(screen.getByRole("tab", { name: /General/ }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/agents/1/general"),
  );
  fireEvent.click(screen.getByRole("tab", { name: /Behavior/ }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/agents/1/behavior"),
  );
  fireEvent.click(signature());
  await waitFor(() => expect(unsaved()).toBe(true));
  await waitFor(() =>
    expect(
      (window.history.state as Record<string, unknown> | null)?.[
        "__unsavedBackGuard"
      ],
    ).toBe(true),
  );
  // Moving between tabs with the edit pending neither asks nor loses it.
  fireEvent.click(screen.getByRole("tab", { name: /General/ }));
  expect(selected().includes("General")).toBe(true);
  expect(asking()).toBe(false);
  expect(unsaved()).toBe(true);
  window.history.back();
  await waitFor(() => expect(asking()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(asking()).toBe(false));
  expect(unsaved()).toBe(true);
  expect(selected().includes("General")).toBe(true);
  window.history.back();
  await waitFor(() => expect(asking()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  await waitFor(() =>
    expect((document.body.textContent ?? "").includes("Agent list")).toBe(true),
  );
  expect(document.querySelector('[role="tab"]') === null).toBe(true);
});

test("with an unsaved edit the URL keeps the tab it had, past the guard's wait for its sentinel", async () => {
  renderEditor("/agents/1/behavior");
  await waitFor(() => signature());
  fireEvent.click(signature());
  await waitFor(() =>
    expect(
      (window.history.state as Record<string, unknown> | null)
        ?.__unsavedBackGuard,
    ).toBe(true),
  );
  jest.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("tab", { name: /General/ }));
    jest.advanceTimersByTime(5_000);
  } finally {
    jest.useRealTimers();
  }
  await act(async () => {});
  expect(window.location.pathname).toBe("/agents/1/behavior");
  expect(
    (window.history.state as Record<string, unknown> | null)
      ?.__unsavedBackGuard === true,
  ).toBe(true);
  expect(selected().includes("General")).toBe(true);
});

test("a link to another tab of the open agent opens it and the URL stays put, also after a tab picked here", async () => {
  renderEditor("/agents/1/behavior");
  await waitFor(() => signature());
  fireEvent.click(screen.getByRole("tab", { name: /Tools/ }));
  await waitFor(() => expect(window.location.pathname).toBe("/agents/1/tools"));
  act(() => navigateTo("/agents/1/general"));
  await waitFor(() => expect(selected().includes("General")).toBe(true));
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    await act(async () => {});
    seen.add(window.location.pathname);
  }
  expect([...seen].join(" ")).toBe("/agents/1/general");
  expect(selected().includes("General")).toBe(true);
});

test("a warning's button opens its tab even when the URL already names it, with an edit pending on another tab", async () => {
  const {
    renderEditor: renderInMemory,
    stubEditorApi,
    editTab,
  } = await import("../utils/agent-editor");
  await renderInMemory(
    stubEditorApi({ modelConfig: { provider: "not-a-provider", model: "x" } }),
    "general",
  );
  await act(async () => {});
  editTab("general");
  fireEvent.click(screen.getByRole("tab", { name: /Behavior/ }));
  expect(selected().includes("Behavior")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Set up the model" }));
  await waitFor(() => expect(selected().includes("General")).toBe(true));
});

test("a link to the tab the URL already names opens it, with an edit pending and another tab picked here", async () => {
  renderEditor("/agents/1/behavior");
  await waitFor(() => signature());
  fireEvent.click(signature());
  await waitFor(() => expect(unsaved()).toBe(true));
  fireEvent.click(screen.getByRole("tab", { name: /General/ }));
  expect(selected().includes("General")).toBe(true);
  expect(window.location.pathname).toBe("/agents/1/behavior");
  act(() => navigateTo("/agents/1/behavior"));
  await waitFor(() => expect(selected().includes("Behavior")).toBe(true));
  expect(unsaved()).toBe(true);
});

test("a warning's jump does not hold back a later link's focus marker", async () => {
  renderEditor("/agents/1/behavior", {
    ...AGENT,
    modelConfig: { provider: "not-a-provider", model: "x" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up the model" }),
  );
  await waitFor(() => expect(selected().includes("General")).toBe(true));
  await waitFor(() =>
    expect(
      document
        .getElementById("general-model")
        ?.classList.contains("section-highlight"),
    ).toBe(true),
  );
  act(() => navigateTo("/agents/1/behavior?focus=stt"));
  await waitFor(() => expect(selected().includes("Behavior")).toBe(true));
  await waitFor(() =>
    expect(
      document.getElementById("stt")?.classList.contains("section-highlight"),
    ).toBe(true),
  );
});

test("with an unsaved edit the header's crumb names the tab on screen, not the URL's", async () => {
  renderEditor("/agents/1/behavior");
  await waitFor(() => signature());
  const crumb = () =>
    document.querySelector('nav[aria-label="Breadcrumbs"] li:last-child')
      ?.textContent ?? "";
  expect(crumb()).toBe("Behavior");
  fireEvent.click(signature());
  await waitFor(() => expect(unsaved()).toBe(true));
  fireEvent.click(screen.getByRole("tab", { name: /General/ }));
  expect(window.location.pathname).toBe("/agents/1/behavior");
  await waitFor(() => expect(crumb()).toBe("General"));
  act(() => navigateTo("/agents/1/behavior"));
  await waitFor(() => expect(crumb()).toBe("Behavior"));
});
