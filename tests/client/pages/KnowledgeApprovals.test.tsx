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
import { withI18n } from "@/tests/utils/i18n";

// With only Approve and Reject, an operator facing a suggestion the agent hedged ("solicita-se
// validação da informação") could only approve the hedge or lose the finding. These tests drive the
// card's Edit, through the same `PATCH /v1/knowledge/approvals/:id` the `knowledge_edit` MCP tool
// uses, to the `EDITED` status.

interface PatchCall {
  id: string;
  body: Record<string, unknown>;
}

const patchCalls: PatchCall[] = [];
const postCalls: { url: string; body: Record<string, unknown> }[] = [];
let approvalsPayload: Record<string, unknown>[] = [];
let discardedPayload: Record<string, unknown>[] = [];
// What an approve, reject or requeue POST answers inside its 200.
let postResult: unknown = "approved";
// What the PATCH reports back. The endpoint answers "not-pending" INSIDE a 200 when someone else
// already approved or rejected the item, so the result is data, not an error.
let patchResult = "updated";
// Lets a test hold the PATCH open, so the in-flight state is observable.
let patchGate: Promise<void> | null = null;

// The api module is NOT mocked: `mock.module` is global to the process and leaks into every other
// file sharing the worker (a suite that stubs `globalThis.fetch`, like vaultCache's, would never be
// reached). The Eden treaty calls fetch, so stubbing that reaches the same paths with no spill.
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
    if (approval && method === "POST") {
      postCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ result: postResult });
    }
    if (url.includes("/knowledge/approvals/discarded")) {
      return json({ approvals: discardedPayload });
    }
    if (url.includes("/knowledge/approvals")) {
      return json({ approvals: approvalsPayload });
    }
    return realFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}

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
    withI18n(
      <MemoryRouter>
        <ToastProvider>
          <KnowledgeApprovals />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
}

describe("KnowledgeApprovals — reviewing before approving", () => {
  beforeEach(() => {
    patchCalls.length = 0;
    postCalls.length = 0;
    discardedPayload = [];
    postResult = "approved";
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

  // NOTE: the endpoint reports a lost race inside a 200, so checking only `error` would mark the
  // card EDITED over a revision that was never stored. The explicit budget: the test asserts a
  // BEHAVIOUR, not a speed, and the awaited PATCH here swings across the default 5s between
  // identical runs.
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
  }, 20000);

  // NOTE: the draft is single, so a second Edit would replace it and the first card's unsaved
  // rewrite would vanish with no warning.
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

  // NOTE: the draft is captured when Save is clicked, so anything typed while the request is in
  // flight would be dropped by the response that closes the editor.
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

  // NOTE: `busyId` holds ONE id, so a per-card `busyId === a.id` guard would leave every other card
  // live: approving a second card mid-save hands the token over, the first card's editor unlocks
  // with its PATCH still open, and the response that lands later overwrites whatever was typed.
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

const DOC_TEXT = "O prazo de entrega é de 3 dias úteis.";

// NOTE: the tests below await one or two POSTs through the real treaty, and on the CI runner that
// swings across the default 5s between identical runs, so each carries the same explicit budget as
// the lost-race test above: they assert behaviour, not speed.
describe("KnowledgeApprovals — what the suggestion reviewer decided", () => {
  beforeEach(() => {
    patchCalls.length = 0;
    postCalls.length = 0;
    discardedPayload = [];
    postResult = "approved";
    patchResult = "updated";
    patchGate = null;
    seed();
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
  });

  test("the reviewer's comment shows on the card, apart from the agent's rationale", async () => {
    seed({ reviewerComment: "Corrige o prazo do documento atual." });
    renderQueue();
    await screen.findByText(HEDGED);
    expect(
      screen.getByText(/Corrige o prazo do documento atual/),
    ).toBeDefined();
    expect(screen.getByText(/Não consegui confirmar/)).toBeDefined();
  });

  test("a proposed replacement shows the current text and approves either way", async () => {
    seed({
      replacesDocument: {
        id: "31",
        title: "Prazos",
        content: DOC_TEXT,
        synced: false,
      },
    });
    renderQueue();
    await screen.findByText(DOC_TEXT);
    fireEvent.click(
      screen.getByRole("button", { name: /approve as a new document/i }),
    );
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]?.url).toContain("/approvals/7/approve");
    expect(postCalls[0]?.body).toEqual({ asNew: true });
  }, 20000);

  test("approve and replace sends no asNew", async () => {
    seed({
      replacesDocument: {
        id: "31",
        title: "Prazos",
        content: DOC_TEXT,
        synced: false,
      },
    });
    renderQueue();
    await screen.findByText(DOC_TEXT);
    fireEvent.click(
      screen.getByRole("button", { name: /approve and replace/i }),
    );
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]?.body).toEqual({});
  }, 20000);

  // NOTE: nothing was claimed when the document is gone, so the card stays and offers only a plain
  // approval, which the server stores as a new document.
  test("a replacement target that vanished keeps the card and drops the replace offer", async () => {
    seed({
      replacesDocument: {
        id: "31",
        title: "Prazos",
        content: DOC_TEXT,
        synced: false,
      },
    });
    postResult = { outcome: "replace-unavailable" };
    renderQueue();
    await screen.findByText(DOC_TEXT);
    fireEvent.click(
      screen.getByRole("button", { name: /approve and replace/i }),
    );
    await waitFor(() => expect(screen.queryByText(DOC_TEXT)).toBeNull());
    expect(screen.getByText(HEDGED)).toBeDefined();
    // NOTE: a plain Approve would send `{}` and be answered `replace-unavailable` again, forever.
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    postResult = "approved";
    fireEvent.click(
      screen.getByRole("button", { name: /approve as a new document/i }),
    );
    await waitFor(() => expect(postCalls.length).toBe(2));
    expect(postCalls[1]?.body).toEqual({ asNew: true });
  }, 20000);

  test("a replacement the queue already knows is unavailable offers only approval as new", async () => {
    seed({ replacesDocument: null, replaceUnavailable: true });
    renderQueue();
    await screen.findByText(HEDGED);
    expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /approve and replace/i }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /approve as a new document/i }),
    );
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]?.body).toEqual({ asNew: true });
  }, 20000);

  test("rejecting asks for an optional reason and sends it trimmed", async () => {
    postResult = "rejected";
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    const box = await screen.findByLabelText(/reason/i);
    fireEvent.change(box, {
      target: { value: "  prazo errado, são 3 dias  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]?.url).toContain("/approvals/7/reject");
    expect(postCalls[0]?.body).toEqual({ reason: "prazo errado, são 3 dias" });
  }, 20000);

  // NOTE: the draft is single, so acting on another card would close it and drop what was typed.
  test("with a rejection reason open, the other cards wait", async () => {
    approvalsPayload = [
      { ...approvalsPayload[0], id: "7" },
      { ...approvalsPayload[0], id: "8", proposedTitle: "Outro" },
    ];
    renderQueue();
    await screen.findByText("Outro");
    fireEvent.click(
      screen.getAllByRole("button", { name: /reject/i })[0] as HTMLElement,
    );
    const box = await screen.findByLabelText(/reason/i);
    fireEvent.change(box, { target: { value: "prazo errado" } });
    const others = [
      ...screen.getAllByRole("button", { name: /^approve$/i }),
      ...screen.getAllByRole("button", { name: /^edit$/i }),
    ];
    expect(others.length).toBeGreaterThan(0);
    expect(
      others.filter((b) => !(b as HTMLButtonElement).disabled).length,
    ).toBe(0);
    for (const b of others) fireEvent.click(b);
    expect(postCalls.length).toBe(0);
    expect(
      (screen.getByLabelText(/reason/i) as HTMLTextAreaElement).value,
    ).toBe("prazo errado");
  }, 20000);

  test("rejecting with no reason sends an empty body", async () => {
    postResult = "rejected";
    renderQueue();
    await screen.findByText(HEDGED);
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    await screen.findByLabelText(/reason/i);
    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]?.body).toEqual({});
  }, 20000);

  test("the discarded tab shows what it matched and sends it back to the queue", async () => {
    approvalsPayload = [];
    discardedPayload = [
      {
        id: "9",
        status: "DISCARDED",
        proposedTitle: "Prazo repetido",
        proposedContent: CLEAN,
        rationale: null,
        knowledgeBaseName: "Base",
        source: null,
        reviewerComment: "Já está na base.",
        replacesDocument: null,
        match: {
          kind: "document",
          document: {
            id: "31",
            title: "Prazos",
            content: DOC_TEXT,
            synced: false,
          },
        },
      },
    ];
    postResult = "requeued";
    renderQueue();
    fireEvent.click(await screen.findByRole("tab", { name: /discarded/i }));
    await screen.findByText(DOC_TEXT);
    expect(screen.getByText(/Já está na base/)).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: /send to the pending list/i }),
    );
    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0]?.url).toContain("/approvals/9/requeue");
    await screen.findByText("Prazo repetido");
    expect(screen.queryByRole("tab", { name: /discarded/i })).toBeNull();
  }, 20000);
});
