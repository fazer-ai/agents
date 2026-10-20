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
  parseToolPreconditionRows,
  serializeToolPreconditions,
} from "@/client/pages/agents/ToolPreconditionsEditor";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { assertSettingsToolPreconditions } from "@/modules/agents/service";
import {
  invalidToolPreconditions,
  readToolPreconditions,
} from "@/modules/agents/tool-preconditions";
import {
  type EditorStub,
  renderEditor,
  stubEditorApi,
} from "../utils/agent-editor";

// The editor's two pure halves, tested against the RUNTIME reader rather than against themselves.
// The whole feature fails silently in one direction — a rule the console shows as saved and the turn
// does not enforce — so "the shape the editor writes is the shape the runtime reads" is the property
// worth holding, not the round trip on its own.
describe("serializeToolPreconditions", () => {
  test("writes a shape the runtime reader accepts", () => {
    const stored = serializeToolPreconditions([
      {
        tool: "handoff_to_human",
        conditions: [{ scope: "conversation", key: "url", equals: "" }],
      },
      {
        tool: "create_invoice",
        conditions: [{ scope: "contact", key: "plan", equals: "gold" }],
      },
    ]);
    expect(readToolPreconditions({ toolPreconditions: stored })).toEqual({
      handoff_to_human: [
        { kind: "attribute", scope: "conversation", key: "url" },
      ],
      create_invoice: [
        { kind: "attribute", scope: "contact", key: "plan", equals: "gold" },
      ],
    });
  });

  test("an empty `equals` means ANY value, and is not written as an empty string", () => {
    const stored = serializeToolPreconditions([
      {
        tool: "t",
        conditions: [{ scope: "conversation", key: "k", equals: "" }],
      },
    ]) as Record<string, Record<string, unknown>>;
    expect("equals" in (stored.t ?? {})).toBe(false);
  });

  test.each([
    [
      "no tool picked yet",
      {
        tool: "",
        conditions: [{ scope: "conversation", key: "k", equals: "" }],
      },
    ],
    [
      "no attribute key",
      {
        tool: "t",
        conditions: [{ scope: "conversation", key: "", equals: "" }],
      },
    ],
    [
      "a whitespace key",
      {
        tool: "t",
        conditions: [{ scope: "conversation", key: "  ", equals: "" }],
      },
    ],
  ])("drops a row with %s instead of saving it half-written", (_l, row) => {
    expect(
      serializeToolPreconditions([
        row as Parameters<typeof serializeToolPreconditions>[0][number],
      ]),
    ).toEqual({});
  });

  test("a half-written row does not block its finished siblings", () => {
    const stored = serializeToolPreconditions([
      {
        tool: "",
        conditions: [{ scope: "conversation", key: "", equals: "" }],
      },
      { tool: "t", conditions: [{ scope: "contact", key: "k", equals: "" }] },
    ]);
    expect(Object.keys(stored)).toEqual(["t"]);
  });

  test("trims what the operator typed, because a trailing space is invisible", () => {
    const stored = serializeToolPreconditions([
      {
        tool: " t ",
        conditions: [{ scope: "contact", key: " k ", equals: " v " }],
      },
    ]) as Record<string, Record<string, unknown>>;
    expect(Object.keys(stored)).toEqual(["t"]);
    expect(stored.t).toEqual({
      kind: "attribute",
      scope: "contact",
      key: "k",
      equals: "v",
    });
  });
});

describe("parseToolPreconditionRows", () => {
  test("round-trips what the runtime stores", () => {
    // Real native names: the parser only renders tools the editor can OFFER, so a placeholder name
    // would exercise the passthrough instead of the round trip.
    const rows = [
      {
        tool: "handoff_to_human",
        conditions: [{ scope: "conversation" as const, key: "k", equals: "" }],
      },
      {
        tool: "resolve_conversation",
        conditions: [{ scope: "contact" as const, key: "j", equals: "v" }],
      },
    ];
    expect(parseToolPreconditionRows(serializeToolPreconditions(rows))).toEqual(
      rows,
    );
  });

  test.each([
    ["nothing stored", undefined],
    ["an array", []],
    ["a string", "x"],
  ])("reads %s as no rows", (_l, stored) => {
    expect(parseToolPreconditionRows(stored)).toEqual([]);
  });

  test("skips an entry of a kind this editor cannot render", () => {
    // A condition kind added later (or written over the API) must not be silently rewritten into an
    // attribute rule by an editor that does not understand it — the row is skipped, and the save
    // path only touches rows it produced.
    expect(
      parseToolPreconditionRows({
        handoff_to_human: { kind: "somethingElse", host: "x.com" },
        set_labels: { kind: "attribute", scope: "contact", key: "k" },
      }),
    ).toEqual([
      {
        tool: "set_labels",
        conditions: [{ scope: "contact", key: "k", equals: "" }],
      },
    ]);
  });
});

// The editor renders a stored entry exactly, or not at all: coercing what it cannot render would let
// the next save turn an entry the runtime ignores into a live rule.
describe("round 1: the editor renders exactly, or not at all", () => {
  test.each([
    ["an unknown scope", { kind: "attribute", scope: "moon", key: "k" }],
    ["a missing key", { kind: "attribute", scope: "contact" }],
    ["a blank key", { kind: "attribute", scope: "contact", key: "  " }],
    [
      "a non-string equals",
      { kind: "attribute", scope: "contact", key: "k", equals: 42 },
    ],
    ["a kind this editor does not know", { kind: "linkOnHost", host: "x.com" }],
  ])("does not render %s as a row", (_l, stored) => {
    expect(parseToolPreconditionRows({ t: stored })).toEqual([]);
  });

  test("an entry it cannot render survives a save of unrelated rows", () => {
    // Otherwise the first operator to save anything on the Tools tab deletes a rule written over
    // REST, from a console that never showed it to them.
    const stored = { legacy: { kind: "linkOnHost", host: "x.com" } };
    const out = serializeToolPreconditions(
      [{ tool: "t", conditions: [{ scope: "contact", key: "k", equals: "" }] }],
      stored,
    );
    expect(out.legacy).toEqual({ kind: "linkOnHost", host: "x.com" });
    expect(out.t).toEqual({ kind: "attribute", scope: "contact", key: "k" });
  });

  test("a row the operator REMOVED is actually removed", () => {
    // The passthrough above must not resurrect a rule that was rendered and then deleted.
    const stored = {
      handoff_to_human: { kind: "attribute", scope: "contact", key: "k" },
      set_labels: { kind: "attribute", scope: "contact", key: "j" },
    };
    const out = serializeToolPreconditions(
      [
        {
          tool: "set_labels",
          conditions: [{ scope: "contact", key: "j", equals: "" }],
        },
      ],
      stored,
    );
    expect(Object.keys(out)).toEqual(["set_labels"]);
  });
});

// SAVING WITHOUT CHANGING A ROW MUST NOT CHANGE WHAT THE RUNTIME ACCEPTS, asserted per class of
// stored value rather than patched per class. Both directions: an entry the runtime refuses stays
// refused (a save must not promote it into a live rule), and an entry it accepts survives
// byte-identical (a save must not drop or rewrite it).
describe("round 2: parse → serialize is a fixed point for the runtime", () => {
  const RUNTIME_ACCEPTS = [
    [
      "a plain presence rule",
      { kind: "attribute", scope: "conversation", key: "url" },
    ],
    [
      "a rule with equals",
      { kind: "attribute", scope: "contact", key: "plan", equals: "gold" },
    ],
    [
      "a list of conditions",
      [
        { kind: "attribute", scope: "conversation", key: "url" },
        { kind: "attribute", scope: "contact", key: "plan", equals: "gold" },
      ],
    ],
  ] as const;

  const RUNTIME_REFUSES = [
    ["an unknown kind", { kind: "somethingElse", host: "x.com" }],
    ["an unknown scope", { kind: "attribute", scope: "moon", key: "k" }],
    ["a missing key", { kind: "attribute", scope: "contact" }],
    ["a blank key", { kind: "attribute", scope: "contact", key: "   " }],
    [
      "a blank equals",
      { kind: "attribute", scope: "contact", key: "k", equals: "" },
    ],
    [
      "a whitespace equals",
      { kind: "attribute", scope: "contact", key: "k", equals: "  " },
    ],
    [
      "a numeric equals",
      { kind: "attribute", scope: "contact", key: "k", equals: 42 },
    ],
    ["a null entry", null],
    ["a string entry", "cpf"],
    ["an array entry", []],
    [
      "a list with one condition it cannot read",
      [
        { kind: "attribute", scope: "conversation", key: "url" },
        { kind: "somethingElse" },
      ],
    ],
  ] as const;

  // A save that changes nothing: the rows come straight back out of the stored bag.
  const resave = (stored: Record<string, unknown>) =>
    serializeToolPreconditions(parseToolPreconditionRows(stored), stored);

  test.each(RUNTIME_ACCEPTS)(
    "keeps %s enforceable and identical",
    (_l, entry) => {
      const stored = { handoff_to_human: entry } as Record<string, unknown>;
      const after = resave(stored);
      expect(readToolPreconditions({ toolPreconditions: after })).toEqual(
        readToolPreconditions({ toolPreconditions: stored }),
      );
    },
  );

  test.each(RUNTIME_REFUSES)(
    "does not promote %s into a live rule",
    (_l, entry) => {
      const stored = { handoff_to_human: entry } as Record<string, unknown>;
      expect(readToolPreconditions({ toolPreconditions: stored })).toEqual({});
      expect(
        readToolPreconditions({ toolPreconditions: resave(stored) }),
      ).toEqual({});
    },
  );

  test.each(RUNTIME_REFUSES)(
    "carries %s through instead of deleting it",
    (_l, entry) => {
      const stored = { handoff_to_human: entry } as Record<string, unknown>;
      expect(resave(stored).handoff_to_human).toEqual(entry);
    },
  );

  test("a condition on a name this editor cannot render survives a save", () => {
    // A name the write boundary refuses (stored before the boundary existed, or by hand). Rendering it
    // would produce a row the next save could not write, and the reaction to that is to delete it.
    const stored = {
      "create invoice": { kind: "attribute", scope: "contact", key: "cpf" },
    };
    expect(parseToolPreconditionRows(stored)).toEqual([]);
    expect(resave(stored)).toEqual(stored);
    expect(
      readToolPreconditions({ toolPreconditions: resave(stored) }),
    ).toEqual(readToolPreconditions({ toolPreconditions: stored }));
  });

  test("a tool named `__proto__` survives serialization as an entry", () => {
    const rows = [
      {
        tool: "__proto__",
        conditions: [{ scope: "contact" as const, key: "k", equals: "" }],
      },
    ];
    const out = serializeToolPreconditions(rows);
    // On an ordinary object this assignment changes the prototype and the key vanishes from JSON.
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty("__proto__");
  });

  test("two rows on one tool keep the FIRST, not the last", () => {
    const out = serializeToolPreconditions([
      {
        tool: "handoff_to_human",
        conditions: [{ scope: "conversation", key: "first", equals: "" }],
      },
      {
        tool: "handoff_to_human",
        conditions: [{ scope: "contact", key: "second", equals: "" }],
      },
    ]) as Record<string, Record<string, unknown>>;
    expect(out.handoff_to_human?.key).toBe("first");
  });

  test("a row the operator ADDED overwrites an unrenderable entry of the same name", () => {
    const stored = { handoff_to_human: { kind: "somethingElse" } };
    const out = serializeToolPreconditions(
      [
        {
          tool: "handoff_to_human",
          conditions: [{ scope: "contact", key: "k", equals: "" }],
        },
      ],
      stored,
    ) as Record<string, Record<string, unknown>>;
    expect(out.handoff_to_human?.kind).toBe("attribute");
  });
});

// The Tools save must put every key it PATCHes back into the shared settings bag, or the next Behavior
// save spreads the pre-save map over the rules just stored, with this tab still showing them saved.
// Asked of the whole bag: an agent with nothing stored has every Tools block written for the first
// time, so a block the save does not put back is missing from the Behavior save that follows.
describe("round 2: the Tools save puts back everything it wrote", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
  });

  const patches = (stub: EditorStub) =>
    stub.writes
      .filter((w) => w.method === "PATCH" && w.body.settings)
      .map((w) => w.body.settings as Record<string, unknown>);

  test("every key sent in toolsSettings is written back to the settings state", async () => {
    const stub = stubEditorApi(
      { settings: {} },
      { catalog: { native: [{ name: "open_case_in_inbox" }] } },
    );
    await renderEditor(stub, "tools");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(
      await screen.findByPlaceholderText("case_conversation_id"),
      { target: { value: "protocolo" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(stub).length).toBe(1));
    const tools = patches(stub)[0] as Record<string, unknown>;
    // NOTE: the bag has to hold the tab's blocks, or the comparison below passes over nothing.
    expect(Object.keys(tools)).toContain("toolPreconditions");
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(4);

    fireEvent.click(screen.getByRole("tab", { name: /Behavior/ }));
    await act(async () => {});
    fireEvent.click(
      await screen.findByRole("switch", {
        name: /Stop answering when a person replies to the customer/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(stub).length).toBe(2));
    const behavior = patches(stub)[1] as Record<string, unknown>;
    const lost = Object.keys(tools).filter(
      (k) => JSON.stringify(behavior[k]) !== JSON.stringify(tools[k]),
    );
    expect(lost).toEqual([]);
  });
});

// The console, the runtime reader and the API's write boundary have to agree on tool names, and a
// disagreement is invisible from inside any one of them: a console offering a name the API refuses
// fails the save on a row the operator just filled in, and one hiding a name the API accepts invites
// them to delete a guard they cannot see.
describe("the console offers exactly what the API accepts", () => {
  test("every native name round-trips through the editor and the write boundary", () => {
    const rows = NATIVE_TOOL_NAMES.map((tool) => ({
      tool,
      conditions: [
        { scope: "conversation" as const, key: "article_url", equals: "" },
      ],
    }));
    const stored = serializeToolPreconditions(rows);
    expect(Object.keys(stored).sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
    // Accepted by the API...
    expect(invalidToolPreconditions({ toolPreconditions: stored })).toEqual([]);
    // ...enforced by the runtime...
    expect(
      Object.keys(readToolPreconditions({ toolPreconditions: stored })).sort(),
    ).toEqual([...NATIVE_TOOL_NAMES].sort());
    // ...and shown back on the next load, every one of them.
    expect(
      parseToolPreconditionRows(stored)
        .map((r) => r.tool)
        .sort(),
    ).toEqual([...NATIVE_TOOL_NAMES].sort());
  });

  test("a name the API refuses is one the editor never renders", () => {
    for (const tool of ["has space", "__proto__", " handoff_to_human "]) {
      const bag = {
        [tool]: { kind: "attribute", scope: "conversation", key: "k" },
      };
      expect(invalidToolPreconditions({ toolPreconditions: bag })).toEqual([
        tool,
      ]);
      expect(parseToolPreconditionRows(bag)).toEqual([]);
    }
  });

  // The fixed point again, now against the write boundary rather than the reader: an entry the
  // console cannot render is carried through verbatim, and a save that changed nothing must not be
  // the moment the API starts refusing a rule the operator never opened.
  test("saving an untouched tab does not turn a carried-through entry into a 400", () => {
    const legacy = {
      "legacy tool": {
        kind: "attribute",
        scope: "conversation",
        key: "cpf",
      },
    };
    const stored = { toolPreconditions: legacy };
    const rows = parseToolPreconditionRows(legacy);
    expect(rows).toEqual([]);
    const next = {
      toolPreconditions: serializeToolPreconditions(rows, legacy),
    };
    expect(next.toolPreconditions).toEqual(legacy);
    expect(() => assertSettingsToolPreconditions(next, stored)).not.toThrow();
  });

  test("but ADDING a refused name in the same save is still refused", () => {
    // The exemption above is for what was already there, not a hole to write new rules through.
    const stored = { toolPreconditions: {} };
    const next = {
      toolPreconditions: {
        "legacy tool": {
          kind: "attribute",
          scope: "conversation",
          key: "cpf",
        },
      },
    };
    expect(() => assertSettingsToolPreconditions(next, stored)).toThrow();
  });
});

// Every source's granted tools can carry a rule, and the select is where the operator finds them. A
// rule whose tool the agent no longer has (renamed, revoked, server gone) guards nothing, so the row
// says so instead of reading as protection.
describe("the Tools tab offers every granted tool, and flags a rule on one that is gone", () => {
  afterEach(cleanup);

  const catalog = {
    toolDefinitions: [
      {
        id: "7",
        name: "busca",
        label: "Busca por CPF",
        enabled: true,
        toolName: "busca_por_cpf",
        args: [],
      },
    ],
    integrationInstances: [
      {
        id: "9",
        catalogType: "google-calendar",
        kind: "TOOLPACK",
        name: "Agenda da escola",
        enabled: true,
        tools: [
          { name: "calendar_check_availability", args: [] },
          { name: "calendar_create_event", args: [] },
        ],
      },
    ],
    mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
  };
  // The shape the server sends: every id key present, the arrays always arrays.
  const grant = (g: Record<string, unknown>) => ({
    toolDefinitionId: null,
    mcpServerConnectionId: null,
    integrationInstanceId: null,
    documentTemplateId: null,
    codeToolDefinitionId: null,
    knowledgeBaseIds: [],
    enabledTools: [],
    ...g,
  });
  const grants = [
    grant({ source: "HTTP", toolDefinitionId: "7" }),
    grant({
      source: "INTEGRATION",
      integrationInstanceId: "9",
      enabledTools: ["calendar_check_availability"],
    }),
    grant({
      source: "MCP",
      mcpServerConnectionId: "5",
      enabledTools: ["create_deal"],
    }),
  ];
  const GONE = /is not among the agent's tools/;
  const offered = () =>
    [
      ...(screen.getByRole("combobox", { name: "Tool" }) as HTMLSelectElement)
        .options,
    ].map((o) => o.value);

  test("toolpack, HTTP and MCP tools are offered, and only the granted ones", async () => {
    const stub = stubEditorApi({ settings: {} }, { catalog, grants });
    await renderEditor(stub, "tools");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add a precondition" }),
    );
    expect(offered()).toEqual(
      expect.arrayContaining([
        "busca_por_cpf",
        "calendar_check_availability",
        "mcp__crm__create_deal",
      ]),
    );
    expect(offered()).not.toContain("calendar_create_event");
  });

  test("a rule on a toolpack tool is saved under the name the model calls", async () => {
    const stub = stubEditorApi({ settings: {} }, { catalog, grants });
    await renderEditor(stub, "tools");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add a precondition" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), {
      target: { value: "calendar_check_availability" },
    });
    // NOTE: an input with suggestions (`list`) is a combobox, not a textbox.
    fireEvent.change(screen.getByRole("combobox", { name: "Attribute" }), {
      target: { value: "dia_turno" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        stub.writes.some((w) => w.method === "PATCH" && w.body.settings),
      ).toBe(true),
    );
    const settings = stub.writes.find(
      (w) => w.method === "PATCH" && w.body.settings,
    )?.body.settings as Record<string, Record<string, unknown>>;
    expect(settings.toolPreconditions?.calendar_check_availability).toEqual({
      kind: "attribute",
      scope: "conversation",
      key: "dia_turno",
    });
  });

  const savedPreconditions = async (stub: EditorStub) => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        stub.writes.some((w) => w.method === "PATCH" && w.body.settings),
      ).toBe(true),
    );
    const settings = stub.writes.find(
      (w) => w.method === "PATCH" && w.body.settings,
    )?.body.settings as Record<string, unknown> | undefined;
    return settings?.toolPreconditions as Record<string, unknown>;
  };

  test("a second condition added under a stored one is saved as a list of both", async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            calendar_check_availability: {
              kind: "attribute",
              scope: "conversation",
              key: "dia",
            },
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add a condition" }),
    );
    const keys = screen.getAllByRole("combobox", { name: "Attribute" });
    expect(keys).toHaveLength(2);
    fireEvent.change(keys[1] as HTMLElement, { target: { value: "turno" } });
    expect(await savedPreconditions(stub)).toEqual({
      calendar_check_availability: [
        { kind: "attribute", scope: "conversation", key: "dia" },
        { kind: "attribute", scope: "conversation", key: "turno" },
      ],
    });
  });

  test("removing one of three conditions saves the other two and leaves the other tool alone", async () => {
    const cond = (key: string) => ({
      kind: "attribute",
      scope: "conversation",
      key,
    });
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            calendar_check_availability: [cond("a"), cond("b"), cond("c")],
            busca_por_cpf: cond("cpf"),
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    const removes = await screen.findAllByRole("button", {
      name: "Remove condition",
    });
    expect(removes).toHaveLength(3);
    fireEvent.click(removes[1] as HTMLElement);
    expect(await savedPreconditions(stub)).toEqual({
      calendar_check_availability: [cond("a"), cond("c")],
      busca_por_cpf: cond("cpf"),
    });
  });

  // The card's own button says what it removes, so it is not mistaken for a condition's, and the
  // conditions after the first read as one sentence ("and until the attribute").
  test("the card's button removes the whole rule, and each later condition reads as an and", async () => {
    const cond = (key: string) => ({
      kind: "attribute",
      scope: "conversation",
      key,
    });
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            calendar_check_availability: [cond("a"), cond("b")],
            busca_por_cpf: cond("cpf"),
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    expect(await screen.findAllByText("and until the attribute")).toHaveLength(
      1,
    );
    const rules = await screen.findAllByRole("button", {
      name: "Remove precondition",
    });
    expect(rules).toHaveLength(2);
    fireEvent.click(rules[0] as HTMLElement);
    expect(await savedPreconditions(stub)).toEqual({
      busca_por_cpf: cond("cpf"),
    });
  });

  test("a tool at the bound of ten conditions offers no eleventh", async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            calendar_check_availability: Array.from({ length: 10 }, (_, i) => ({
              kind: "attribute",
              scope: "conversation",
              key: `k${i}`,
            })),
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    const add = (await screen.findByRole("button", {
      name: "Add a condition",
    })) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(screen.getAllByRole("combobox", { name: "Attribute" })).toHaveLength(
      10,
    );
  });

  test("a rule on a tool the agent no longer has is shown with a warning", async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            busca_antiga: {
              kind: "attribute",
              scope: "conversation",
              key: "cpf",
            },
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    expect(
      await screen.findByText(
        "busca_antiga is not among the agent's tools: it was renamed, removed or turned off. This rule guards nothing.",
      ),
    ).toBeTruthy();
    expect(offered()).toContain("busca_antiga");
  });

  // Two MCP connections whose names give one slug expose names the select holds back (a new rule
  // could guard the other server's tool), but a saved rule on one still guards a tool the turn builds.
  test("a rule on a built name the select holds back carries no warning", async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            mcp__crm__create_deal: {
              kind: "attribute",
              scope: "conversation",
              key: "cpf",
            },
          },
        },
      },
      {
        catalog: {
          ...catalog,
          mcpConnections: [
            { id: "5", name: "CRM", enabled: true, slug: "crm" },
            { id: "6", name: "CRM!", enabled: true, slug: "crm" },
          ],
        },
        grants: [
          ...grants,
          grant({
            source: "MCP",
            mcpServerConnectionId: "6",
            enabledTools: ["create_deal"],
          }),
        ],
      },
    );
    await renderEditor(stub, "tools");
    expect(offered()).toContain("mcp__crm__create_deal");
    expect(screen.queryByText(GONE)).toBeNull();
  });

  test("a rule on a granted tool carries no warning", async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            busca_por_cpf: {
              kind: "attribute",
              scope: "conversation",
              key: "cpf",
            },
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    await screen.findByRole("combobox", { name: "Tool" });
    expect(screen.queryByText(GONE)).toBeNull();
  });
  test('clearing a saved value keeps "equals" chosen while the new one is typed', async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            busca_por_cpf: {
              kind: "attribute",
              scope: "contact",
              key: "cpf",
              equals: "ok",
            },
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Required value" }),
      { target: { value: "" } },
    );
    expect(
      (screen.getByRole("combobox", { name: "Condition" }) as HTMLSelectElement)
        .value,
    ).toBe("equals");
    expect(
      screen.getByRole("textbox", { name: "Required value" }),
    ).toBeTruthy();
  });

  test("the select groups the offered tools by where they come from", async () => {
    const stub = stubEditorApi({ settings: {} }, { catalog, grants });
    await renderEditor(stub, "tools");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add a precondition" }),
    );
    const select = screen.getByRole("combobox", {
      name: "Tool",
    }) as HTMLSelectElement;
    const groups = Object.fromEntries(
      [...select.querySelectorAll("optgroup")].map((g) => [
        g.label,
        [...g.querySelectorAll("option")].map((o) => o.value),
      ]),
    );
    expect(groups["HTTP tools"]).toEqual(["busca_por_cpf"]);
    expect(groups["MCP servers"]).toEqual(["mcp__crm__create_deal"]);
    expect(groups.Integrations).toEqual(["calendar_check_availability"]);
  });

  test('choosing "equals" saves the value, and going back to "any value" drops it', async () => {
    const stub = stubEditorApi(
      {
        settings: {
          toolPreconditions: {
            busca_por_cpf: { kind: "attribute", scope: "contact", key: "cpf" },
          },
        },
      },
      { catalog, grants },
    );
    await renderEditor(stub, "tools");
    const match = await screen.findByRole("combobox", { name: "Condition" });
    expect(
      screen.queryByRole("textbox", { name: "Required value" }),
    ).toBeNull();
    fireEvent.change(match, { target: { value: "equals" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Required value" }), {
      target: { value: "ok" },
    });
    const saved = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(
          stub.writes.some((w) => w.method === "PATCH" && w.body.settings),
        ).toBe(true),
      );
      const w = stub.writes.filter(
        (x) => x.method === "PATCH" && x.body.settings,
      );
      const settings = w[w.length - 1]?.body.settings as Record<
        string,
        Record<string, unknown>
      >;
      return settings.toolPreconditions?.busca_por_cpf;
    };
    expect(await saved()).toEqual({
      kind: "attribute",
      scope: "contact",
      key: "cpf",
      equals: "ok",
    });
    stub.writes.length = 0;
    fireEvent.change(screen.getByRole("combobox", { name: "Condition" }), {
      target: { value: "any" },
    });
    expect(await saved()).toEqual({
      kind: "attribute",
      scope: "contact",
      key: "cpf",
    });
  });
});
