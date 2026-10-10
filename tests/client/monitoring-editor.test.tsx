/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import en from "@/client/locales/en.json";
import { MONITORING_SECTIONS } from "@/client/pages/agents/BehaviorTab";
import {
  type EditorStub,
  lastSavedSettings,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";
import { createTestI18n } from "../utils/i18n";

// A watcher's editor. The page has eight tabs and a Behavior tab of fifteen sections, and a
// monitoring agent runs almost none of it: drawn in full, the page would say the agent could answer.
// The block that does run for it (what it does with what it reads) has its own screen. Rendered
// whole against a stubbed API, once as a watcher and once as an agent that answers.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

type Mode = "monitoring" | "production";

async function open(
  mode: Mode,
  tab = "general",
  opts: {
    settings?: Record<string, unknown>;
    grants?: unknown[];
    catalog?: Record<string, unknown>;
    state?: unknown;
    catalogText?: boolean;
  } = {},
): Promise<EditorStub> {
  const stub = stubEditorApi(
    { mode, settings: opts.settings ?? {} },
    { grants: opts.grants, catalog: opts.catalog },
  );
  await renderEditor(
    stub,
    tab,
    opts.catalogText
      ? createTestI18n("en", { en: { translation: en } })
      : undefined,
    opts.state,
  );
  await act(async () => {});
  return stub;
}

const tabs = () =>
  screen.getAllByRole("tab").map((t) => ({
    name: t.textContent ?? "",
    selected: t.getAttribute("aria-selected") === "true",
  }));
const goTo = async (name: RegExp) => {
  fireEvent.click(screen.getByRole("tab", { name }));
  await act(async () => {});
};
const playgroundOffers = () =>
  screen.queryAllByText("Test in playground").length;
// Every Behavior section on the page, and whether it is drawn.
const sections = () =>
  [...document.querySelectorAll(".scroll-mt-4[id]")].map((el) => ({
    id: el.id,
    hidden: el.classList.contains("hidden"),
  }));
const saveDisabled = () =>
  (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled;

describe("the editor of a monitoring agent", () => {
  test("draws only the tabs a watcher has a use for", async () => {
    await open("production");
    const all = tabs().map((t) => t.name);
    cleanup();
    await open("monitoring");
    // NOTE: tools and knowledge are drawn: a watcher runs the ordinary graph, so its grants and its
    // knowledge bases are the whole of what it can do. What stays out is what only an agent that
    // SPEAKS has: a reply to screen, a redirect that messages the customer, a playground.
    expect({ all, watcher: tabs().map((t) => t.name) }).toEqual({
      all: [
        "General",
        "Channels",
        "Tools",
        "Knowledge",
        "Behavior",
        "Guardrails",
        "Redirect",
        "Playground",
      ],
      watcher: ["General", "Channels", "Tools", "Knowledge", "Behavior"],
    });
    cleanup();
    // A URL naming a hidden tab lands on General rather than rendering a tab the page hides.
    await open("monitoring", "guardrails");
    await waitFor(() =>
      expect(tabs().find((t) => t.selected)?.name).toBe("General"),
    );
  });

  // NOTE: the playground loads the agent WITHOUT `ignoreMode`, so a monitoring agent cannot run
  // there: an action that opens a panel whose every run fails as `agentNotRunnable` is worse than no
  // action.
  test("no tab a watcher draws offers the playground", async () => {
    const offered: Record<string, number> = {};
    for (const mode of ["production", "monitoring"] as const) {
      await open(mode);
      for (const tab of [/General/, /Behavior/, /Tools/, /Knowledge/]) {
        await goTo(tab);
        offered[`${mode} ${tab.source}`] = playgroundOffers();
      }
      cleanup();
    }
    expect(offered).toEqual({
      "production General": 1,
      "production Behavior": 1,
      "production Tools": 1,
      "production Knowledge": 1,
      "monitoring General": 0,
      "monitoring Behavior": 0,
      "monitoring Tools": 0,
      "monitoring Knowledge": 0,
    });
  });

  test("the Behavior tab keeps the blocks that apply to a watcher and hides the rest", async () => {
    expect([...MONITORING_SECTIONS].sort()).toEqual([
      // NOTE: the prompt block built on every turn, this one included.
      "attributeContext",
      // NOTE: the contact gate's rule decides which conversations a watcher observes.
      "contactAuth",
      // NOTE: ...and the ceiling on the tool calls a watcher actually makes.
      "limits",
      "memory",
      "modelFallback",
      "observability",
      "observation",
      // NOTE: media analysis runs on the observer's route under its own settings, so its controls
      // stay reachable.
      "stt",
      "vision",
    ]);
    // Every section the set leaves out is hidden on a watcher's page (hidden, not unmounted: it stays
    // in the tree); every section it keeps is drawn.
    await open("monitoring", "behavior");
    const drawn = sections();
    expect(drawn.length).toBeGreaterThan(10);
    expect(
      drawn.filter((s) => s.hidden === MONITORING_SECTIONS.has(s.id)),
    ).toEqual([]);
  });

  // A warning is kept for a watcher by its own deep-link TARGET: the section it would scroll to has
  // to be one the watcher's editor draws. Issues with no target (the knowledge base's indexing) are
  // kept: a watcher searches the knowledge bases it was granted. The import warnings' Review button
  // asks the same question.
  test("a watcher's warnings and Review buttons point only at what it draws", async () => {
    const settings = {
      // Speech replies: a section a watcher does not draw.
      tts: { mode: "mirror", provider: "openai" },
      // Image reading: a section it does draw.
      vision: { enabled: true, provider: "openai" },
      // Guardrails: a tab it does not draw.
      guardrails: { enabled: true },
    };
    const knowledge = {
      grants: [
        {
          source: "RAG",
          knowledgeBaseIds: ["kb1"],
          enabledTools: [],
        },
      ],
      catalog: {
        knowledgeBases: [
          { id: "kb1", name: "Base", unindexedCount: 2, documentCount: 2 },
        ],
      },
    };
    const state = {
      importWarnings: [
        {
          code: "credentialUnset",
          params: { name: "fala" },
          target: { kind: "agentField", tab: "behavior", sectionId: "tts" },
        },
        {
          code: "credentialUnset",
          params: { name: "visao" },
          target: { kind: "agentField", tab: "behavior", sectionId: "vision" },
        },
      ],
    };
    const seen: Record<string, unknown> = {};
    for (const mode of ["production", "monitoring"] as const) {
      await open(mode, "general", {
        settings,
        ...knowledge,
        state,
        catalogText: true,
      });
      const panel = screen
        .getByText("Configuration warnings")
        .closest("div.flex-col") as HTMLElement;
      seen[mode] = {
        warnings: within(panel).getAllByRole("listitem").length,
        embedding: within(panel).queryAllByText(
          /tenant embedding is not configured/,
        ).length,
        review: screen.queryAllByText("Review").length,
      };
      cleanup();
    }
    const production = seen.production as { warnings: number };
    expect(seen).toEqual({
      production: { warnings: production.warnings, embedding: 1, review: 2 },
      // Two fewer: the speech section's and the guardrails tab's.
      monitoring: {
        warnings: production.warnings - 2,
        embedding: 1,
        review: 1,
      },
    });
  });

  test("the Observation block is drawn first, and only for a watcher", async () => {
    const drawn: Record<string, unknown> = {};
    for (const mode of ["monitoring", "production"] as const) {
      const stub = await open(mode, "behavior");
      const ids = sections().map((s) => s.id);
      // The save REPLACES the `monitoring` block through the form-state pair, and only for an agent
      // that is a watcher (or already has the block).
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
      drawn[mode] = {
        observationAt: ids.indexOf("observation"),
        savesBlock: "monitoring" in (lastSavedSettings(stub) ?? {}),
      };
      cleanup();
    }
    expect(drawn).toEqual({
      monitoring: { observationAt: 0, savesBlock: true },
      production: { observationAt: -1, savesBlock: false },
    });
  });
});

// The rest of a watcher's editor. The Channels tab's own rows (roles read off the inbox, the observer
// pair's health and repair, the combined removal, the disconnected account) are rendered in
// tests/client/monitoring-channels.test.tsx.
describe("the Channels tab of a watcher", () => {
  // ...and the Behavior tab's Save is not held hostage by a section the watcher does not draw, while
  // the sections it does draw (the fallback, the contact gate) still hold it.
  test("save is not blocked by validators for hidden sections", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "a leftover speech rewrite with no endpoint",
        {
          tts: {
            mode: "mirror",
            normalize: true,
            normalizeProvider: "openai-compatible",
            normalizeModel: "m",
            normalizeBaseURL: null,
          },
        },
      ],
      [
        "a fallback provider with no model",
        { modelFallback: { provider: "gemini", model: "" } },
      ],
      [
        "an authorization endpoint that is not a URL",
        { contactAuth: { enabled: true, url: "not a url" } },
      ],
    ];
    const blocked: Record<string, boolean> = {};
    for (const [what, settings] of cases) {
      await open("monitoring", "behavior", { settings });
      blocked[what] = saveDisabled();
      cleanup();
    }
    expect(blocked).toEqual({
      "a leftover speech rewrite with no endpoint": false,
      "a fallback provider with no model": true,
      "an authorization endpoint that is not a URL": true,
    });
  });

  // The fallback section is drawn for a watcher, so the save writes the block like any other, in the
  // shape the form-state pair writes (the blanks as null).
  test("a watcher's save writes the fallback block like any other", async () => {
    const stub = await open("monitoring", "behavior", {
      settings: { modelFallback: { provider: "gemini", model: "gemini-x" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastSavedSettings(stub)).toBeDefined());
    expect(lastSavedSettings(stub)?.modelFallback).toEqual({
      provider: "gemini",
      model: "gemini-x",
      credentialRef: null,
      baseURL: null,
    });
  });

  // The panel closes with its trigger: flipping a production agent to monitoring removes the entry
  // point, and an already-open playground must not stay mounted as a reply surface.
  test("an open playground closes when the mode hides it", async () => {
    await open("production");
    fireEvent.click(screen.getByText("Test in playground"));
    await screen.findByText("New session");
    fireEvent.click(screen.getByRole("button", { name: "Monitoring" }));
    await act(async () => {});
    expect(screen.queryAllByText("New session").length).toBe(0);
  });

  // The ceiling acts on a watcher, but not on the tick: the control stays and only the help differs.
  test("the history ceiling tells a watcher what it actually bounds", async () => {
    const help: Record<string, string> = {};
    for (const mode of ["production", "monitoring"] as const) {
      await open(mode, "behavior");
      fireEvent.click(
        screen.getByRole("button", {
          name: /Show help: History ceiling \(tokens\)/,
        }),
      );
      help[mode] =
        (
          await screen.findByText(/history/i, {
            selector: "[data-radix-popper-content-wrapper] *",
          })
        ).textContent?.slice(0, 40) ?? "";
      cleanup();
    }
    expect(help).toEqual({
      production: "The agent sends this contact's whole his",
      monitoring: "An observation does not carry this conta",
    });
  });

  // Binding acts immediately and the server judges the stored agent, so a draft flipped on General
  // must not decide which endpoint the switch calls.
  test("routes a new binding by the SAVED mode", async () => {
    const stub = stubEditorApi({ mode: "production", settings: {} });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    stub.override = (method, path) => {
      if (path === "/api/v1/chatwoot/deployment") {
        return json({
          deployment: { baseUrl: "https://chat.example.com" },
          accounts: [
            {
              id: "a1",
              accountId: 1,
              accountName: "Conta",
              disconnectedAt: null,
            },
          ],
        });
      }
      if (path === "/api/v1/chatwoot/inboxes" && method === "GET") {
        return json({
          inboxes: [
            {
              id: "i1",
              name: "Livre",
              chatwootInstanceId: "a1",
              chatwootInboxId: 9,
              channelType: "Channel::Api",
              agentId: null,
              observerAgentIds: [],
            },
          ],
        });
      }
      if (path === "/api/v1/chatwoot/inboxes/bot-status") {
        return json({ statuses: {}, observerStatuses: {} });
      }
      if (path === "/api/v1/agents" && method === "GET") {
        return json({ agents: [], total: 0 });
      }
      return undefined;
    };
    await renderEditor(stub, "general");
    // A draft flip, not saved.
    fireEvent.click(screen.getByRole("button", { name: "Monitoring" }));
    await goTo(/Channels/);
    const sw = await screen.findByRole("switch", { name: /Livre/ });
    fireEvent.click(sw);
    await waitFor(() =>
      expect(
        stub.writes.some((w) => w.path.includes("/chatwoot/inboxes/i1")),
      ).toBe(true),
    );
    expect(
      stub.writes
        .filter((w) => w.path.includes("/chatwoot/"))
        .map((w) => `${w.method} ${w.path}`),
    ).toEqual(["PATCH /api/v1/chatwoot/inboxes/i1"]);
  });

  test("the tab redirect keeps the way back to the conversation", async () => {
    await open("monitoring", "guardrails?from=/conversations/77");
    await waitFor(() =>
      expect(tabs().find((t) => t.selected)?.name).toBe("General"),
    );
    expect(screen.queryAllByText("Back to the conversation").length).toBe(1);
  });
});
