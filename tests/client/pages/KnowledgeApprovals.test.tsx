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

mock.module("@/client/lib/api", () => ({
  api: {
    api: {
      v1: {
        knowledge: {
          approvals: Object.assign(
            ({ id }: { id: string }) => ({
              approve: { post: async () => ({ data: {}, error: null }) },
              reject: { post: async () => ({ data: {}, error: null }) },
              patch: async (body: Record<string, unknown>) => {
                patchCalls.push({ id, body });
                return { data: { result: "updated" }, error: null };
              },
            }),
            {
              get: async () => ({
                data: { approvals: approvalsPayload },
                error: null,
              }),
            },
          ),
        },
      },
    },
  },
}));

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
    seed();
  });

  afterEach(() => {
    cleanup();
  });

  // mock.module is global to the process and leaks across files in the same worker, so the api stub
  // is handed back at the end of this file rather than left installed for whoever runs next.
  afterAll(() => {
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

  // Approve is the destructive step here: it copies the text verbatim into the base. It must act on
  // what the reviewer is looking at, so it cannot stay live under an open editor.
  test("approve is not reachable while the editor is open", async () => {
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
  });
});
