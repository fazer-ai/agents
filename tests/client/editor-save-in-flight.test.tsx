/// <reference lib="dom" />

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { nativeToolAnchor } from "@/client/pages/agents/editorTabs";
import { focusableIn } from "@/client/pages/agents/saveAttempt";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  type EditorAgent,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// What a section is compared with after its save is what the server stored, never the form as it
// stands when the answer lands. The operator can keep editing while a save is out; an edit the
// request did not carry must still read unsaved, in every section that has its own Save. And the
// control: the same save with nothing edited meanwhile does clear the section.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// Holds every write until `release`, so the test can edit while the save is out.
function holdWrites(): { release: () => void; held: () => boolean } {
  const served = globalThis.fetch;
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let waiting = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") {
      waiting = true;
      await gate;
    }
    return served(input, init);
  }) as typeof fetch;
  return { release: () => open(), held: () => waiting };
}

const panel = () =>
  document.querySelector<HTMLElement>('[role="tabpanel"]') ?? document.body;

const change = (el: Element | null, value: string) => {
  if (!el) throw new Error("the control is not drawn");
  fireEvent.change(el, { target: { value } });
};

const dot = (tab: RegExp) =>
  screen.getByRole("tab", { name: tab }).querySelector(".bg-warning") !== null;

const NATIVE = [
  {
    source: "NATIVE",
    toolDefinitionId: null,
    mcpServerConnectionId: null,
    integrationInstanceId: null,
    documentTemplateId: null,
    codeToolDefinitionId: null,
    knowledgeBaseIds: [],
    enabledTools: ["private_note", "set_labels"],
  },
];

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

const toggleTool = (name: string) => {
  const card = document.getElementById(nativeToolAnchor(name));
  if (!card) throw new Error(`the ${name} card is not drawn`);
  fireEvent.click(focusableIn(card) ?? card);
};

interface Section {
  name: string;
  route: string;
  tab: RegExp;
  seed: EditorAgent;
  save: string;
  // The edit the save carries, and a different one made while it is out.
  first: () => void;
  meanwhile: () => void;
}

const SECTIONS: Section[] = [
  {
    name: "general",
    route: "general",
    tab: /^General/,
    seed: {},
    save: "Save",
    first: () => change(screen.getByLabelText(/^Name/), "Ana"),
    meanwhile: () => change(screen.getByLabelText(/^Name/), "Ana Maria"),
  },
  {
    name: "behavior",
    route: "behavior",
    tab: /^Behavior/,
    seed: {},
    save: "Save",
    first: () => change(panel().querySelector('input[type="number"]'), "7"),
    meanwhile: () => change(panel().querySelector('input[type="number"]'), "9"),
  },
  {
    name: "guardrails",
    route: "guardrails",
    tab: /^Guardrails/,
    seed: { settings: { guardrails: { enabled: true } } },
    save: "Save",
    first: () => change(panel().querySelector("textarea"), "Sem palavrão."),
    meanwhile: () =>
      change(panel().querySelector("textarea"), "Sem palavrão nenhum."),
  },
  {
    name: "channelRedirect",
    route: "channelRedirect",
    tab: /^Redirect/,
    seed: {},
    save: "Save",
    first: () => change(panel().querySelector("textarea"), "Siga pelo site."),
    meanwhile: () =>
      change(panel().querySelector("textarea"), "Siga pelo site, por favor."),
  },
  {
    name: "tools",
    route: "tools",
    tab: /^Tools/,
    seed: {},
    save: "Save tools",
    first: () => toggleTool("private_note"),
    meanwhile: () => toggleTool("handoff_to_human"),
  },
  {
    name: "tools config",
    route: "tools",
    tab: /^Tools/,
    seed: {},
    save: "Save tools",
    first: () => toggleTool("private_note"),
    meanwhile: () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Add a precondition" }),
      ),
  },
  {
    name: "knowledge",
    route: "knowledge",
    tab: /^Knowledge/,
    seed: {},
    save: "Save knowledge",
    first: () => change(panel().querySelector("select"), "openai"),
    meanwhile: () => change(panel().querySelector("select"), "anthropic"),
  },
  {
    name: "decisions",
    route: "decisions",
    tab: /^Questions and rules/,
    seed: {
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
    },
    save: "Save",
    // Two ready questions: an empty one would be refused before anything is written.
    first: () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Customer sentiment" }),
      ),
    meanwhile: () =>
      fireEvent.click(screen.getByRole("button", { name: "Main subject" })),
  },
];

async function saveWith(s: Section, editMeanwhile: boolean): Promise<boolean> {
  const stub = stubEditorApi(s.seed, { catalog: CATALOG, grants: NATIVE });
  // The grants PUT stores what it was sent, as the server does.
  stub.override = (method, path, body) => {
    if (method !== "PUT" || !path.endsWith("/tool-selections")) return;
    return new Response(
      JSON.stringify({
        grants: (body.grants as Record<string, unknown>[]).map((g) => ({
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds: [],
          enabledTools: [],
          ...g,
        })),
        catalog: CATALOG,
        agentUpdatedAt: stub.agent.updatedAt,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  await renderEditor(stub, s.route);
  s.first();
  await waitFor(() => expect(dot(s.tab)).toBe(true));
  const writes = holdWrites();
  fireEvent.click(screen.getByRole("button", { name: s.save }));
  await waitFor(() => expect(writes.held()).toBe(true));
  if (editMeanwhile) s.meanwhile();
  const before = stub.writes.length;
  writes.release();
  await waitFor(() => expect(stub.writes.length).toBeGreaterThan(before - 1));
  await waitFor(() =>
    expect(
      /Agent saved\.|Tools updated\./.test(document.body.textContent ?? ""),
    ).toBe(true),
  );
  return dot(s.tab);
}

describe("an edit made while a save is out stays unsaved", () => {
  for (const s of SECTIONS) {
    test(`${s.name}: edited meanwhile, still unsaved`, async () => {
      expect(await saveWith(s, true)).toBe(true);
    });
    test(`${s.name}: nothing edited meanwhile, saved`, async () => {
      expect(await saveWith(s, false)).toBe(false);
    });
  }
});

// The server's copy is read once per sync, not again on every render: a value it derives from the
// clock (the debug window closing) would otherwise move the baseline with no edit and no save.
test("a debug window that closes while the editor is open does not read as an edit", async () => {
  setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
  try {
    const stub = stubEditorApi({
      settings: {
        observability: { fullDetailUntil: "2026-03-01T12:30:00.000Z" },
      },
    });
    await renderEditor(stub, "behavior");
    expect(dot(/^Behavior/)).toBe(false);
    setSystemTime(new Date("2026-03-01T13:00:00.000Z"));
    // Any render: switch tabs and back.
    fireEvent.click(screen.getByRole("tab", { name: /^General/ }));
    fireEvent.click(screen.getByRole("tab", { name: /^Behavior/ }));
    await screen.findByRole("tab", { name: /^Behavior/, selected: true });
    expect(dot(/^Behavior/)).toBe(false);
  } finally {
    setSystemTime();
  }
});

// A Behavior save on questions and rules writes memory and the fallback as stored. Stored means what
// the server holds now: after a save whose answer was kept off the form (the section was edited
// meanwhile), the next save must not put the previous memory back.
test("memory saved while Behavior was edited is kept by the next save on questions and rules", async () => {
  const stub = stubEditorApi({
    mode: "monitoring",
    settings: {
      monitoring: {
        engine: "llm",
        decisions: {
          provider: "typesafe",
          credentialRef: "vault:1",
          questions: [{ name: "q", type: "yes_no", instructions: "?" }],
          rules: [],
        },
      },
    },
  });
  await renderEditor(stub, "behavior");
  const memoryProvider = () => {
    const el = [...document.querySelectorAll<HTMLSelectElement>("select")].find(
      (e) => [...e.options].some((o) => o.text === "Same as the agent"),
    );
    if (!el) throw new Error("the memory provider is not drawn");
    return el;
  };
  change(memoryProvider(), "openai");
  const writes = holdWrites();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(writes.held()).toBe(true));
  change(panel().querySelector('input[type="number"]'), "9");
  writes.release();
  await screen.findByText("Agent saved.");
  const stored = JSON.stringify(
    (stub.agent.settings as Record<string, unknown>).memory,
  );
  fireEvent.click(screen.getByRole("tab", { name: /^General/ }));
  fireEvent.click(
    await waitFor(() => {
      const e = document.querySelector<HTMLElement>(
        '[data-testid="engine-decisions"]',
      );
      if (!e) throw new Error("the engine cards are not drawn");
      return e;
    }),
  );
  fireEvent.click(screen.getByRole("tab", { name: /^Behavior/ }));
  await screen.findByRole("tab", { name: /^Behavior/, selected: true });
  const before = stub.writes.length;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(stub.writes.length).toBeGreaterThan(before));
  const second = stub.writes[stub.writes.length - 1] as {
    body: { settings?: Record<string, unknown> };
  };
  expect(
    `${stored.includes("openai")} ${JSON.stringify(second.body.settings?.memory) === stored}`,
  ).toBe("true true");
});

// The recording warning reads what the server records, so it follows a save even when the save's
// answer was kept off the form because Behavior was edited while it was out.
test("logging turned on and saved while Behavior was edited raises the recording warning", async () => {
  const stub = stubEditorApi({});
  await renderEditor(stub, "behavior");
  fireEvent.click(
    screen.getByRole("switch", { name: "Log the values sent to tools" }),
  );
  const writes = holdWrites();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(writes.held()).toBe(true));
  const warned = () =>
    (document.body.textContent ?? "").includes(
      "Recording more than the default right now",
    );
  const before = warned();
  change(panel().querySelector('input[type="number"]'), "9");
  writes.release();
  await screen.findByText("Agent saved.");
  await waitFor(() => expect(warned()).toBe(true));
  expect(before).toBe(false);
});

// An unrelated save re-reads the agent; a debug window that closed meanwhile is not re-read into the
// baseline while Behavior still shows the window it loaded, or Behavior would read as edited.
test("a General save after the debug window closed does not mark Behavior unsaved", async () => {
  setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
  try {
    const stub = stubEditorApi({
      settings: {
        observability: { fullDetailUntil: "2026-03-01T12:30:00.000Z" },
      },
    });
    await renderEditor(stub, "general");
    setSystemTime(new Date("2026-03-01T13:00:00.000Z"));
    change(screen.getByLabelText(/^Name/), "Ana");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Agent saved.");
    expect(`${dot(/^General/)} ${dot(/^Behavior/)}`).toBe("false false");
  } finally {
    setSystemTime();
  }
});

// Discard all puts the form back from the server's copy, read now; the baseline was read at load.
// A debug window that closed in between must read the same on both sides.
test("Discard all after the debug window closed leaves nothing unsaved", async () => {
  setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
  try {
    const stub = stubEditorApi({
      settings: {
        observability: { fullDetailUntil: "2026-03-01T12:30:00.000Z" },
      },
    });
    await renderEditor(stub, "general");
    change(screen.getByLabelText(/^Name/), "Ana");
    setSystemTime(new Date("2026-03-01T13:00:00.000Z"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard all" }));
    const confirm = await screen.findByRole("dialog");
    const buttons = [...confirm.querySelectorAll("button")];
    fireEvent.click(
      buttons.find((b) => /Discard/.test(b.textContent ?? "")) as HTMLElement,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Discard all" }) === null,
      ).toBe(true),
    );
    expect(`${dot(/^General/)} ${dot(/^Behavior/)}`).toBe("false false");
  } finally {
    setSystemTime();
  }
});

// A decisions save that lands while the setup was being edited: the next save that falls back to the
// stored block (an incomplete draft behind the language model) falls back to the block just saved,
// not to the one read before it.
test("a decisions save kept off an edited form is the stored block the next save falls back to", async () => {
  const stub = stubEditorApi({
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
  });
  await renderEditor(stub, "decisions");
  fireEvent.click(screen.getByRole("button", { name: "Customer sentiment" }));
  const writes = holdWrites();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(writes.held()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Add question" }));
  writes.release();
  await screen.findByText("Agent saved.");
  const saved = (
    (stub.agent.settings as { monitoring: { decisions: { questions: [] } } })
      .monitoring.decisions.questions ?? []
  ).length;
  fireEvent.click(screen.getByRole("tab", { name: /^General/ }));
  fireEvent.click(
    await waitFor(() => {
      const e = document.querySelector<HTMLElement>(
        '[data-testid="engine-llm"]',
      );
      if (!e) throw new Error("the engine cards are not drawn");
      return e;
    }),
  );
  const before = stub.writes.length;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(stub.writes.length).toBeGreaterThan(before));
  const last = stub.writes[stub.writes.length - 1] as {
    body: {
      settings?: { monitoring?: { decisions?: { questions?: unknown[] } } };
    };
  };
  expect(
    `${saved} ${last.body.settings?.monitoring?.decisions?.questions?.length}`,
  ).toBe("2 2");
});
