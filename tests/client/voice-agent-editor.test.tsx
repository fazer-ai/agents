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

async function open(tab = "general") {
  const stub = stubEditorApi({
    kind: "voice",
    settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
  });
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
});
