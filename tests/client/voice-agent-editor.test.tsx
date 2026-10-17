/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// A voice agent's editor: its own tabs, and the Voice card on General, whose edits General's own
// Discard takes back like any other field on that tab.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function open(tab = "general", kind: "voice" | "text" = "voice") {
  const stub = stubEditorApi(
    {
      kind,
      settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
    },
    {
      catalog: {
        rag: [{ name: "search_knowledge" }, { name: "suggest_kb_entry" }],
      },
    },
  );
  stub.override = (method, path) =>
    method === "POST" && path.endsWith("/calls/check")
      ? new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      : undefined;
  await renderEditor(stub, tab);
  await act(async () => {});
  return stub;
}

const tabNames = () =>
  screen.getAllByRole("tab").map((t) => t.textContent ?? "");
const modelSelect = () =>
  screen
    .getAllByRole("combobox")
    .find((el) =>
      [...(el as HTMLSelectElement).options].some(
        (o) => o.value === "qwen36-35b-a3b",
      ),
    ) as HTMLSelectElement;

describe("the editor of a voice agent", () => {
  test("draws the tabs of an agent that takes calls", async () => {
    await open();
    expect(tabNames()).toEqual([
      "General",
      "Channels",
      "Call settings",
      "Tools",
      "Knowledge",
      "Playground",
    ]);
  });

  test("Knowledge offers search, and no suggestions or their reviewer, which a call never runs", async () => {
    await open("knowledge");
    expect(screen.queryByText("Suggestion reviewer")).toBeNull();
    cleanup();
    // A text agent's tab, with the same catalog, still has them.
    await open("knowledge", "text");
    expect(screen.queryByText("Suggestion reviewer")).not.toBeNull();
  });

  test("General's Discard takes back a change to the Voice card", async () => {
    await open();
    expect(modelSelect().value).toBe("gpt-4.1-mini");
    fireEvent.change(modelSelect(), { target: { value: "qwen36-35b-a3b" } });
    await act(async () => {});
    expect(modelSelect().value).toBe("qwen36-35b-a3b");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => {});
    expect(modelSelect().value).toBe("gpt-4.1-mini");
  });

  test("one save of the name and a call setting leaves nothing unsaved on either tab", async () => {
    const stub = await open();
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Raquel" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Call settings" }));
    await act(async () => {});
    // Stored as the number 1, which the form spells back as "1".
    fireEvent.change(screen.getByLabelText(/^Speech speed/), {
      target: { value: "1,00" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(stub.writes.filter((w) => w.method === "PATCH")).toHaveLength(1);
    expect(
      (screen.getByLabelText(/^Speech speed/) as HTMLInputElement).value,
    ).toBe("1");
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  test("the Playground's call warns of an unsaved change on Tools, which the call does not carry", async () => {
    await open("tools");
    fireEvent.click(screen.getByRole("button", { name: "Add a precondition" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Save tools" })).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Call in the playground" }),
    );
    await act(async () => {});
    expect(
      screen.queryByText(
        "You have unsaved changes. The call uses what is saved.",
      ),
    ).not.toBeNull();
  });

  test("and of one on Knowledge", async () => {
    const stub = stubEditorApi(
      {
        kind: "voice",
        settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
      },
      {
        catalog: {
          rag: [{ name: "search_knowledge" }],
          knowledgeBases: [{ id: "kb1", name: "Perguntas frequentes" }],
        },
        grants: [
          {
            source: "RAG",
            enabledTools: ["search_knowledge"],
            knowledgeBaseIds: [],
          },
        ],
      },
    );
    await renderEditor(stub, "knowledge");
    await act(async () => {});
    fireEvent.click(screen.getByText("Perguntas frequentes"));
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "Save knowledge" }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Call in the playground" }),
    );
    await act(async () => {});
    expect(
      screen.queryByText(
        "You have unsaved changes. The call uses what is saved.",
      ),
    ).not.toBeNull();
  });
});
