import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  type EditorStub,
  editTab,
  NATIVE_CATALOG,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// Every save of the agent editor that can be forced declares the replacement when it is. The server
// refuses a settings bag that would drop blocks the row holds, and the editor builds its bags from
// the last-synced settings, so a block another writer added is missing from all of them. An
// ordinary save should be refused for that; the "Save anyway" retry after a 409 should not (the
// operator chose their copy), and without the declaration it answers 400 on every attempt. Each tab
// with a Save is saved against a server that answers its first PATCH with a conflict.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const patches = (stub: EditorStub) =>
  stub.writes.filter(
    (w) => w.method === "PATCH" && w.path === `/api/v1/agents/${stub.agent.id}`,
  );

function conflictOnce(stub: EditorStub) {
  let answered = false;
  stub.override = (method, path) => {
    if (
      answered ||
      method !== "PATCH" ||
      path !== `/api/v1/agents/${stub.agent.id}`
    ) {
      return undefined;
    }
    answered = true;
    return new Response(JSON.stringify({ error: "conflict" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("forced saves in the agent editor", () => {
  for (const [tab, save] of [
    ["general", "Save"],
    ["behavior", "Save"],
    ["tools", "Save"],
    ["guardrails", "Save"],
    ["channelRedirect", "Save"],
  ] as const) {
    test(`${tab}: the ordinary save keeps the precondition, the forced one replaces`, async () => {
      const stub = stubEditorApi({ settings: {} }, { catalog: NATIVE_CATALOG });
      conflictOnce(stub);
      await renderEditor(stub, tab);
      editTab(tab);
      fireEvent.click(screen.getByRole("button", { name: save }));
      // The notice is drawn twice (the card and the save bar); either runs the same retry.
      fireEvent.click(
        (
          await screen.findAllByRole("button", { name: "Save anyway" })
        )[0] as HTMLElement,
      );
      await waitFor(() =>
        expect(patches(stub).length).toBeGreaterThanOrEqual(2),
      );
      const [ordinary, forced] = patches(stub).map((w) => w.body);
      expect(ordinary?.expectedUpdatedAt).toBeDefined();
      expect(ordinary?.settingsMode).toBeUndefined();
      expect(forced?.settingsMode).toBe("replace");
      expect(forced?.expectedUpdatedAt).toBeUndefined();
    });
  }
});
