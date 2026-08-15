/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";

// Issue #81: the approval card offered exactly two actions, Approve and Reject. An operator facing a
// suggestion the agent hedged ("solicita-se validação da informação") could only approve the hedge
// into the knowledge base or reject and lose the finding. Editing existed everywhere else —
// `editApprovalItem`, `PATCH /v1/knowledge/approvals/:id`, the `knowledge_edit` MCP tool — and the
// `EDITED` status was in the enum with a badge rendered for it, but the console could never produce
// it. These tests drive the affordance from the card, through the same PATCH.

interface PatchCall {
  id: string;
  body: Record<string, unknown>;
}

const patchCalls: PatchCall[] = [];
let approvalsPayload: Record<string, unknown>[] = [];
// What the PATCH reports back. The endpoint answers "not-pending" INSIDE a 200 when someone else
// already approved or rejected the item, so the result is data, not an error.
let patchResult = "updated";
// Lets a test hold the PATCH open, so the in-flight state is observable.
let patchGate: Promise<void> | null = null;

// The api module is NOT mocked: `mock.module` is global to the process and leaks into every other
// file sharing the worker — this file broke `vaultCache` in CI while passing locally, because that
// suite stubs `globalThis.fetch` and our module mock meant its code never reached it. The Eden
// treaty calls fetch, so stubbing that reaches the same paths with no spill (same shape as
// tests/client/lib/vaultCache.test.ts).
const realFetch = globalThis.fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const approval = /\/knowledge\/approvals\/([^/?]+)/.exec(url);
    if (approval && method === "PATCH") {
      if (patchGate) await patchGate;
      patchCalls.push({
        id: approval[1] as string,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return json({ result: patchResult });
    }
    if (approval && method === "POST") return json({});
    if (url.includes("/knowledge/approvals")) {
      return json({ approvals: approvalsPayload });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      fallback?: string | Record<string, unknown>,
      opts?: Record<string, unknown>,
    ) => {
      const fb = typeof fallback === "string" ? fallback : key;
      const vars = (typeof fallback === "string" ? opts : fallback) ?? {};
      return fb.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ""));
    },
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  useThemedAsset: (path: string) => ({ src: path }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

const { KnowledgeApprovals } = await import(
  "@/client/pages/resources/KnowledgeApprovals"
);

const HEDGED =
  "O prazo de entrega é de 5 dias úteis. Solicita-se validação da informação junto ao setor responsável.";
const CLEAN = "O prazo de entrega é de 5 dias úteis.";

function seed(over: Record<string, unknown> = {}) {
  approvalsPayload = [
    {
      id: "7",
      status: "PENDING",
      proposedTitle: "Prazo de entrega",
      proposedContent: HEDGED,
      rationale: "Não consegui confirmar com o setor.",
      knowledgeBaseName: "Base",
      source: null,
      ...over,
    },
  ];
}

function renderQueue() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <KnowledgeApprovals />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("KnowledgeApprovals — reviewing before approving", () => {
  beforeEach(() => {
    patchCalls.length = 0;
    patchResult = "updated";
    patchGate = null;
    seed();
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    mock.restore();
  });

  test("the card offers an edit action, not just approve and reject", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    expect(screen.getByRole("button", { name: /edit/i })).toBeDefined();
  });

  test("editing the content and saving sends only what changed", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const box = await screen.findByLabelText(/content/i);
    fireEvent.change(box, { target: { value: CLEAN } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0]?.id).toBe("7");
    expect(patchCalls[0]?.body).toEqual({ content: CLEAN });
  });

  // The reviewer's context for what the agent was unsure about. It must stay readable while the text
  // is being rewritten, and it must never be folded into the content that gets embedded.
  test("the rationale stays visible while editing", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.getByText(/Não consegui confirmar/)).toBeDefined();
  });

  test("saving an untouched card sends nothing and does not stamp it EDITED", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.queryByLabelText(/content/i)).toBeNull());
    expect(patchCalls.length).toBe(0);
    expect(screen.queryByText("Edited")).toBeNull();
  });

  test("cancelling restores the original text", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const box = await screen.findByLabelText(/content/i);
    fireEvent.change(box, { target: { value: "outra coisa" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await screen.findByText(HEDGED);
    expect(patchCalls.length).toBe(0);
  });

  // Review finding: the endpoint reports a lost race inside a 200. Checking only `error` left the
  // card marked EDITED and reported success over a revision that was never stored.
  test("a suggestion reviewed elsewhere meanwhile leaves the queue instead of claiming EDITED", async () => {
    patchResult = "not-pending";
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const box = await screen.findByLabelText(/content/i);
    fireEvent.change(box, { target: { value: CLEAN } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.queryByText(CLEAN)).toBeNull());
    expect(screen.queryByText("Edited")).toBeNull();
    expect(screen.queryByText(HEDGED)).toBeNull();
  });

  // Review finding: the draft is single, so a second Edit would replace it and the first card's
  // unsaved rewrite would vanish with no warning.
  test("with an editor open, the other cards cannot start one", async () => {
    approvalsPayload = [
      { ...approvalsPayload[0], id: "7" },
      { ...approvalsPayload[0], id: "8", proposedTitle: "Outro" },
    ];
    renderQueue();
    await screen.findByText("Outro");
    const editButtons = screen.getAllByRole("button", { name: /edit/i });
    expect(editButtons.length).toBe(2);
    fireEvent.click(editButtons[0] as HTMLElement);
    const stillOffered = screen
      .getAllByRole("button", { name: /edit/i })
      .filter((b) => !(b as HTMLButtonElement).disabled);
    expect(stillOffered.length).toBe(0);
  });

  // Review finding: the draft was captured when Save was clicked, so anything typed while the
  // request was in flight would be dropped by the response that closes the editor.
  test("the fields are locked while the save is in flight", async () => {
    let release: () => void = () => undefined;
    patchGate = new Promise<void>((r) => {
      release = r;
    });
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const box = (await screen.findByLabelText(
      /content/i,
    )) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: CLEAN } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(box.disabled).toBe(true));
    release();
    await waitFor(() => expect(patchCalls.length).toBe(1));
  });

  // Review finding, round 3: `busyId` holds ONE id, so a per-card `busyId === a.id` guard leaves
  // every other card live. Approving a second card mid-save hands the token over, the first card's
  // editor unlocks with its PATCH still open, and the response that lands later overwrites whatever
  // was typed or cancelled in between.
  test("a save in flight locks the other cards' actions too", async () => {
    approvalsPayload = [
      { ...approvalsPayload[0], id: "7" },
      { ...approvalsPayload[0], id: "8", proposedTitle: "Outro" },
    ];
    let release: () => void = () => undefined;
    patchGate = new Promise<void>((r) => {
      release = r;
    });
    renderQueue();
    await screen.findByText("Outro");
    fireEvent.click(
      screen.getAllByRole("button", { name: /edit/i })[0] as HTMLElement,
    );
    const box = (await screen.findByLabelText(
      /content/i,
    )) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: CLEAN } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(box.disabled).toBe(true));

    // The open editor replaced this card's own Approve/Reject, so everything matched here belongs to
    // the other card.
    const others = [
      ...screen.getAllByRole("button", { name: /^approve$/i }),
      ...screen.getAllByRole("button", { name: /reject/i }),
    ];
    expect(others.length).toBeGreaterThan(0);
    // Counts, never the elements themselves: an assertion that fails while holding a DOM node makes
    // the runner serialize a cyclic happy-dom tree, and the run stops producing output.
    expect(
      others.filter((b) => !(b as HTMLButtonElement).disabled).length,
    ).toBe(0);

    // The damage, not just the attribute: pressing one must not unlock the editor whose request is
    // still open.
    for (const b of others) fireEvent.click(b);
    expect(box.disabled).toBe(true);

    release();
    await waitFor(() => expect(patchCalls.length).toBe(1));
  });

  // Approve is the destructive step here: it copies the text verbatim into the base. It must act on
  // what the reviewer is looking at, so it cannot stay live under an open editor.
  test("approve is not reachable while the editor is open", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });
});
