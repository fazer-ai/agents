/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderEditor, stubEditorApi } from "../utils/agent-editor";

// What the provider says about a saved voice agent goes up to the configuration warnings, where any
// tab shows it, with a button to the Voice card. A check that could not run says nothing about the key.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function open(check: Response, tab = "call") {
  const stub = stubEditorApi({
    kind: "voice",
    settings: { calls: { credentialRef: "vault:9", llm: "gpt-4.1-mini" } },
  });
  stub.override = (method, path) =>
    method === "POST" && path.endsWith("/calls/check")
      ? check.clone()
      : undefined;
  await renderEditor(stub, tab);
  await act(async () => {});
  return stub;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const warningRow = (text: string) =>
  screen.queryByText(text)?.closest("li") ?? null;

describe("a voice agent's call check in the configuration warnings", () => {
  test("a refused key shows on another tab, and its button opens the Voice card on General", async () => {
    await open(json({ ok: false, problem: "invalid_key" }));
    const row = await waitFor(() => {
      const r = warningRow(
        "The agent cannot take calls because the key was refused.",
      );
      expect(r).not.toBeNull();
      return r as HTMLElement;
    });
    const button = row.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Review the key");
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "General" })
          .getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });

  test("a key without the agents permission and refused settings each say why, in their own words", async () => {
    await open(json({ ok: false, problem: "missing_permission" }));
    await waitFor(() =>
      expect(
        screen.queryByText(
          /cannot take calls because the key is not allowed to run agents/,
        ),
      ).not.toBeNull(),
    );
    cleanup();
    await open(json({ ok: false, problem: "sync_failed", detail: "voice_id" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/cannot take calls because .* refused its settings/),
      ).not.toBeNull(),
    );
  });

  test("a check that passed, or one that could not run, adds no call warning", async () => {
    await open(json({ ok: true, providerAgentId: "agent_1" }));
    await act(async () => {});
    expect(screen.queryByText(/cannot take calls/)).toBeNull();
    cleanup();
    await open(json({ error: "boom" }, 500));
    await act(async () => {});
    expect(screen.queryByText(/cannot take calls/)).toBeNull();
  });
});
