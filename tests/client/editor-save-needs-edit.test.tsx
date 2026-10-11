/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  type EditorAgent,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// Every Save of the agent editor is disabled until its tab has an edit, and enabled by the first
// change (Gabriel's call on agents#1365): with no edit there is nothing to write, and a save that
// writes anyway stores what the operator never chose. The fence walks every tab that draws a Save,
// for an answering agent and for a watcher on questions and rules, so the next tab is held to it.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
  rag: [],
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  codeTools: [],
  documentTemplates: [],
  knowledgeBases: [],
};

const SAVE = /^Save( tools| knowledge)?$/;

const WATCHER: EditorAgent = {
  mode: "monitoring",
  settings: {
    monitoring: {
      engine: "decisions",
      decisions: {
        provider: "typesafe",
        credentialRef: "vault:1",
        questions: [{ name: "q", type: "yes_no", instructions: "?" }],
        rules: [],
      },
    },
  },
};

// The tabs that draw a Save, per kind of agent. Channels and Playground draw none.
const CASES: Array<[string, EditorAgent, string[]]> = [
  [
    "an answering agent",
    {},
    [
      "general",
      "behavior",
      "guardrails",
      "channelRedirect",
      "tools",
      "knowledge",
    ],
  ],
  [
    "a watcher on questions and rules",
    WATCHER,
    ["general", "behavior", "decisions", "tools"],
  ],
];

async function saveOn(seed: EditorAgent, tab: string): Promise<HTMLElement> {
  const stub = stubEditorApi(seed, { catalog: CATALOG });
  await renderEditor(stub, tab);
  // Settled: the grants and the catalog have loaded, so a tab that fills itself in late is caught.
  await waitFor(() =>
    expect(stub.requests.some((r) => r.endsWith("/tool-selections"))).toBe(
      true,
    ),
  );
  return screen.getByRole("button", { name: SAVE });
}

describe("no tab's Save is enabled without an edit", () => {
  for (const [kind, seed, tabs] of CASES) {
    for (const tab of tabs) {
      test(`${kind}: ${tab}`, async () => {
        const save = await saveOn(seed, tab);
        expect(save).toHaveProperty("disabled", true);
      });
    }
  }
});

// The positive half: the first change enables it, so the fence above is not met by a Save that is
// simply never enabled.
test("the first edit enables Save, and undoing it disables it again", async () => {
  const save = await saveOn({}, "general");
  const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
  const was = name.value;
  fireEvent.change(name, { target: { value: `${was} 2` } });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.change(name, { target: { value: was } });
  await waitFor(() => expect(save).toHaveProperty("disabled", true));
});
