/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { nativeToolAnchor } from "@/client/pages/agents/editorTabs";
import { WRITABLE_ATTRIBUTES_MAX } from "@/modules/agents/tool-guidance";
import {
  editTab,
  lastSavedSettings,
  NATIVE_CATALOG,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The set_custom_attribute card: the operator picks the attributes it may write from the account's
// definitions, sees what each one accepts (the rule the tool enforces), and the Tools save stores the
// list where the runtime reads it.
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
    enabledTools: ["set_custom_attribute"],
  },
];

const DEFS = {
  attributes: [
    {
      key: "nome",
      displayName: "Nome",
      model: "contact_attribute",
      displayType: "text",
      values: [],
      regexPattern: "/^(?!oi$).{2,}$/i",
      regexCue: "o nome da pessoa",
    },
    {
      key: "serie",
      displayName: "Série",
      model: "conversation_attribute",
      displayType: "list",
      values: ["Infantil", "Fundamental"],
      regexPattern: null,
      regexCue: null,
    },
  ],
  accountCount: 1,
  settingsUrl:
    "https://chat.example.com/app/accounts/5/settings/custom-attributes/list",
};

function stub() {
  const s = stubEditorApi(
    {
      settings: {
        setCustomAttribute: {
          allowed: [
            { scope: "contact", key: "nome" },
            { scope: "conversation", key: "serie" },
          ],
        },
      },
    },
    { catalog: NATIVE_CATALOG, grants: GRANTS },
  );
  s.override = (method, path) =>
    method === "GET" && path === `/api/v1/chatwoot/custom-attributes/41`
      ? new Response(JSON.stringify(DEFS), {
          headers: { "Content-Type": "application/json" },
        })
      : undefined;
  return s;
}

const text = () => document.body.textContent ?? "";

// A tool loaded already granted starts collapsed: its settings open from the card's own button.
async function openAttributeCard(): Promise<void> {
  const card = await waitFor(() => {
    const el = document.getElementById(
      nativeToolAnchor("set_custom_attribute"),
    );
    if (!el) throw new Error("no set_custom_attribute card");
    return el;
  });
  const open = card.querySelector<HTMLElement>('[aria-label="Settings"]');
  if (!open) throw new Error("no settings button on the card");
  fireEvent.click(open);
}

describe("the attributes set_custom_attribute may write", () => {
  test("each listed attribute shows the rule the tool applies, and the link edits it in Chatwoot", async () => {
    await renderEditor(stub(), "tools");
    await openAttributeCard();
    await waitFor(() =>
      expect(text()).toContain("One of: Infantil, Fundamental"),
    );
    expect(text()).toContain("Must match the pattern");
    expect(text()).toContain("/^(?!oi$).{2,}$/i");
    expect(text()).toContain("(o nome da pessoa)");
    const link = screen.getByRole("link", {
      name: /Edit options and patterns in Chatwoot/,
    }) as HTMLAnchorElement;
    expect(link.href).toBe(DEFS.settingsUrl);
  });

  test("removing one and saving stores the rest where the runtime reads it", async () => {
    const s = stub();
    await renderEditor(s, "tools");
    await openAttributeCard();
    await waitFor(() =>
      expect(text()).toContain("One of: Infantil, Fundamental"),
    );
    const contactPicker = screen.getByRole("button", {
      name: "Attributes it may write: Contact",
    });
    const remove = contactPicker.parentElement?.querySelector<HTMLElement>(
      '[aria-label="Remove"]',
    );
    expect(Boolean(remove)).toBe(true);
    fireEvent.click(remove as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(Boolean(lastSavedSettings(s)?.setCustomAttribute)).toBe(true),
    );
    expect(lastSavedSettings(s)?.setCustomAttribute).toEqual({
      allowed: [{ scope: "conversation", key: "serie" }],
    });
  });

  test("an over-ceiling list is refused before the write, a stored one is not", async () => {
    const stored = Array.from(
      { length: WRITABLE_ATTRIBUTES_MAX + 2 },
      (_, i) => ({ scope: "conversation", key: `k${i}` }),
    );
    const s = stubEditorApi(
      { settings: { setCustomAttribute: { allowed: stored } } },
      { catalog: NATIVE_CATALOG, grants: GRANTS },
    );
    await renderEditor(s, "tools");
    await openAttributeCard();

    // Saved as stored, the list is not this save's to refuse.
    editTab("tools");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    expect(s.writes.map((w) => w.method).join(",")).toBe("PATCH");

    const picker = screen.getByRole("button", {
      name: "Attributes it may write: Conversation",
    });
    const remove = picker.parentElement?.querySelector<HTMLElement>(
      '[aria-label="Remove"]',
    );
    expect(Boolean(remove)).toBe(true);
    fireEvent.click(remove as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(
      `Attributes it may write takes at most ${WRITABLE_ATTRIBUTES_MAX} attributes across the three scopes.`,
    );
    expect(s.writes.map((w) => w.method).join(",")).toBe("PATCH");
  });
});
