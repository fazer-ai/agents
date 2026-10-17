/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  suggestionReviewToForm,
  suggestionReviewToStored,
} from "@/client/pages/agents/knowledgeFormState";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The Knowledge section holds two things the editor saves in different requests: the knowledge
// grants (written by both the Tools and the Knowledge save, through the grants PUT) and the reviewer
// model (written only by the Knowledge save, in the settings bag).

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function openKnowledge(): Promise<EditorStub> {
  const stub = stubEditorApi(
    { settings: { crossInboxCase: { caseAttributeKey: "protocolo" } } },
    { catalog: { native: [{ name: "open_case_in_inbox" }] } },
  );
  await renderEditor(stub, "knowledge");
  return stub;
}

function reviewerProvider(): HTMLSelectElement {
  const section = document.getElementById("kb-review");
  const select = section?.querySelector("select");
  if (!select) throw new Error("the reviewer's provider select is not drawn");
  return select;
}

// Disabled the way the browser decides it: by the control's own flag or by a disabled fieldset around
// it (happy-dom's `:disabled` does not follow the fieldset).
const locked = (el: HTMLElement) =>
  el.matches(":disabled") ||
  (el.closest("fieldset") as HTMLFieldSetElement | null)?.disabled === true;

const pickAnthropic = () =>
  fireEvent.change(reviewerProvider(), { target: { value: "anthropic" } });
const goTo = async (name: RegExp) => {
  fireEvent.click(screen.getByRole("tab", { name }));
  await act(async () => {});
};
const dirty = (name: RegExp) =>
  screen.getByRole("tab", { name }).querySelector(".bg-warning") !== null;
const savedReviewer = (stub: EditorStub) =>
  stub.writes
    .filter((w) => w.method === "PATCH")
    .map(
      (w) =>
        (
          (w.body.settings as Record<string, unknown> | undefined)
            ?.knowledge as { suggestionReview?: { provider?: string } }
        )?.suggestionReview?.provider,
    );

describe("the reviewer model in the agent editor", () => {
  // The bar saves the agent, not the tab (agents#1520): pressed on Tools, it writes the reviewer too,
  // through the Knowledge save that carries it, and only then reads the Knowledge tab as saved.
  test("a save pressed on Tools writes the unsaved reviewer model too", async () => {
    const stub = await openKnowledge();
    pickAnthropic();
    await waitFor(() => expect(dirty(/Knowledge/)).toBe(true));
    await goTo(/Tools/);
    if (!screen.queryByPlaceholderText("case_conversation_id")) {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    }
    fireEvent.change(
      await screen.findByPlaceholderText("case_conversation_id"),
      {
        target: { value: "protocolo_novo" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(dirty(/Tools/)).toBe(false));
    await waitFor(() => expect(dirty(/Knowledge/)).toBe(false));
    // The Tools PATCH goes first and does not carry it; the Knowledge one after it does.
    const sent = savedReviewer(stub);
    expect(sent[0]).not.toBe("anthropic");
    expect(sent.at(-1)).toBe("anthropic");
  });

  test("save all writes the Knowledge section through its own save", async () => {
    const stub = await openKnowledge();
    pickAnthropic();
    await waitFor(() => expect(dirty(/Knowledge/)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save and export" }),
    );
    await waitFor(() =>
      expect(stub.requests.some((r) => r.endsWith("/export"))).toBe(true),
    );
    expect(savedReviewer(stub)).toEqual(["anthropic"]);
  });

  test("the reviewer fields are locked while the Knowledge save runs", async () => {
    const stub = await openKnowledge();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    stub.override = (method, path) =>
      method === "PUT" && path.endsWith("/tool-selections")
        ? held.then(
            () =>
              new Response(
                JSON.stringify({
                  grants: [],
                  catalog: {
                    native: [{ name: "open_case_in_inbox" }],
                    rag: [],
                    toolDefinitions: [],
                    mcpConnections: [],
                    integrationInstances: [],
                    codeTools: [],
                    documentTemplates: [],
                    knowledgeBases: [],
                  },
                  agentUpdatedAt: stub.agent.updatedAt,
                }),
                { headers: { "Content-Type": "application/json" } },
              ),
          )
        : undefined;
    pickAnthropic();
    expect(locked(reviewerProvider())).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(stub.requests).toContain("PUT /api/v1/agents/41/tool-selections"),
    );
    expect(locked(reviewerProvider())).toBe(true);
    release();
    await waitFor(() => expect(locked(reviewerProvider())).toBe(false));
  });

  test("the stored block round-trips through the form, and an empty form inherits the agent's model", () => {
    const form = suggestionReviewToForm({
      knowledge: {
        suggestionReview: {
          provider: "openai",
          model: "gpt-5-mini",
          credentialRef: null,
          baseURL: null,
        },
      },
    });
    expect(
      suggestionReviewToForm({ knowledge: suggestionReviewToStored(form) }),
    ).toEqual(form);
    expect(suggestionReviewToForm({}).provider).toBeFalsy();
  });
});
