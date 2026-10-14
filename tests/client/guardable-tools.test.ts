import { describe, expect, test } from "bun:test";
import {
  assembledToolNames,
  guardableToolsOf,
} from "@/client/pages/agents/guardableTools";
import type { GrantState, ToolCatalog } from "@/client/pages/agents/types";

// What the precondition select offers: the tools the agent is granted, by the name the model calls
// them. Each row below is a way the list could offer a tool the turn never gets (a rule that reads as
// protection and guards nothing) or hide one it does.

const grant = (g: Partial<GrantState> & { source: string }): GrantState =>
  ({
    toolDefinitionId: null,
    mcpServerConnectionId: null,
    integrationInstanceId: null,
    documentTemplateId: null,
    codeToolDefinitionId: null,
    knowledgeBaseIds: [],
    enabledTools: [],
    ...g,
  }) as GrantState;

const catalog = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    native: [
      { name: "handoff_to_human" },
      { name: "set_labels" },
      { name: "send_image", deliversToCustomer: true },
    ],
    rag: [],
    toolDefinitions: [],
    mcpConnections: [],
    integrationInstances: [
      {
        id: "9",
        catalogType: "google-calendar",
        kind: "TOOLPACK",
        name: "Agenda",
        enabled: true,
        tools: [
          { name: "calendar_check_availability", args: [] },
          { name: "calendar_send_invite", args: [], deliversToCustomer: true },
        ],
      },
    ],
    codeTools: [],
    documentTemplates: [],
    knowledgeBases: [],
    ...over,
  }) as unknown as ToolCatalog;

const calendar = grant({
  source: "INTEGRATION",
  integrationInstanceId: "9",
  enabledTools: ["calendar_check_availability", "calendar_send_invite"],
});
const names = (c: ToolCatalog, g: GrantState[], o = {}) =>
  guardableToolsOf(c, g, o).map((t) => t.name);

describe("guardableToolsOf", () => {
  test("a toolpack offers what its grant enables, labelled with the integration", () => {
    const tools = guardableToolsOf(
      catalog(),
      [
        grant({
          source: "INTEGRATION",
          integrationInstanceId: "9",
          enabledTools: ["calendar_check_availability"],
        }),
      ],
      {},
    );
    expect(tools.filter((t) => t.kind === "toolpack")).toEqual([
      {
        name: "calendar_check_availability",
        label: "Agenda: calendar_check_availability",
        kind: "toolpack",
      },
    ]);
  });

  test("a disabled integration offers nothing, since the turn does not load it", () => {
    const off = catalog({
      integrationInstances: [
        {
          ...(catalog().integrationInstances[0] as object),
          enabled: false,
        },
      ],
    });
    expect(names(off, [calendar])).not.toContain("calendar_check_availability");
  });

  test("an integration that is not a toolpack offers nothing here", () => {
    const mcpKind = catalog({
      integrationInstances: [
        { ...(catalog().integrationInstances[0] as object), kind: "MCP" },
      ],
    });
    expect(names(mcpKind, [calendar])).not.toContain(
      "calendar_check_availability",
    );
  });

  test("a watcher is not offered what its muted turn strips, native or toolpack", () => {
    const watched = names(catalog(), [calendar], { observing: true });
    expect(watched).not.toContain("send_image");
    expect(watched).not.toContain("calendar_send_invite");
    expect(watched).toContain("calendar_check_availability");
  });

  test("a decisions agent gets natives from its action list and no toolpack", () => {
    const decided = names(catalog(), [calendar], { decides: true });
    expect(decided).toContain("set_labels");
    expect(decided).not.toContain("send_image");
    expect(decided).not.toContain("calendar_check_availability");
  });

  test("a NATIVE row is an allowlist, and no row means every native", () => {
    expect(
      names(catalog(), [
        grant({ source: "NATIVE", enabledTools: ["set_labels"] }),
      ]),
    ).toEqual(["set_labels"]);
    expect(names(catalog(), [])).toEqual([
      "handoff_to_human",
      "set_labels",
      "send_image",
    ]);
  });

  test("HTTP and MCP tools come under the names the model calls", () => {
    const c = catalog({
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
      mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
    });
    const tools = guardableToolsOf(
      c,
      [
        grant({ source: "NATIVE", enabledTools: [] }),
        grant({ source: "HTTP", toolDefinitionId: "7" }),
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: ["create_deal"],
        }),
      ],
      {},
    );
    expect(tools).toEqual([
      { name: "busca_por_cpf", label: "Busca por CPF", kind: "http" },
      { name: "mcp__crm__create_deal", label: "CRM: create_deal", kind: "mcp" },
    ]);
  });

  test("a name two sources share is offered once", () => {
    const c = catalog({
      toolDefinitions: [
        {
          id: "7",
          name: "x",
          label: "Outra",
          enabled: true,
          toolName: "calendar_check_availability",
          args: [],
        },
      ],
    });
    const offered = names(c, [
      grant({ source: "HTTP", toolDefinitionId: "7" }),
      calendar,
    ]);
    expect(
      offered.filter((n) => n === "calendar_check_availability"),
    ).toHaveLength(1);
  });

  test("knowledge and document tools are offered, a document only when the turn would build it", () => {
    const c = catalog({
      documentTemplates: [
        {
          id: "3",
          name: "Proposta",
          toolName: "send_proposta",
          description: null,
          enabled: true,
          available: true,
        },
        {
          id: "4",
          name: "Recibo antigo",
          toolName: "send_recibo",
          description: null,
          enabled: true,
          available: false,
        },
      ],
    });
    const offered = names(c, [
      grant({ source: "NATIVE", enabledTools: [] }),
      grant({
        source: "RAG",
        enabledTools: ["search_knowledge"],
        knowledgeBaseIds: ["1"],
      }),
      grant({ source: "DOCUMENT", documentTemplateId: "3" }),
      grant({ source: "DOCUMENT", documentTemplateId: "4" }),
    ]);
    expect(offered).toEqual(["search_knowledge", "send_proposta"]);
  });
});

// The warning on a saved rule asks what the turn builds, not what the select offers.
describe("assembledToolNames", () => {
  const twoCrms = catalog({
    mcpConnections: [
      { id: "5", name: "CRM", enabled: true, slug: "crm" },
      { id: "6", name: "CRM!", enabled: true, slug: "crm" },
    ],
  });
  const mcpGrants = [
    grant({ source: "NATIVE", enabledTools: [] }),
    grant({
      source: "MCP",
      mcpServerConnectionId: "5",
      enabledTools: ["create_deal"],
    }),
    grant({
      source: "MCP",
      mcpServerConnectionId: "6",
      enabledTools: ["create_deal"],
    }),
  ];

  test("an MCP name two servers may share is not offered, and still counts as built", () => {
    expect(names(twoCrms, mcpGrants)).not.toContain("mcp__crm__create_deal");
    const built = assembledToolNames(twoCrms, mcpGrants, {});
    expect(built.has("mcp__crm__create_deal")).toBe(true);
    expect(built.has("mcp__crm__create_deal_2")).toBe(true);
  });

  test("an MCP name the assembly trims past 64 characters counts as built", () => {
    const tool = "a".repeat(60);
    const built = assembledToolNames(
      catalog({
        mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
      }),
      [
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: [tool],
        }),
      ],
      {},
    );
    // No room is left for the slug, and the tool name itself is cut to fit.
    expect(built.has(`mcp____${"a".repeat(57)}`)).toBe(true);
  });

  // No two tools reach one name, so the names are exact and a rule on a revoked tool is flagged.
  test("without a collision, an MCP name the agent no longer builds is not built", () => {
    const built = assembledToolNames(
      catalog({
        mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
      }),
      [
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: ["create_deal"],
        }),
      ],
      {},
    );
    expect(built.has("mcp__crm__create_deal")).toBe(true);
    expect(built.has("mcp__crm__delete_deal")).toBe(false);
  });

  // The suffixes follow the server's listing order, which the console does not have.
  test("with a collision, any MCP name may be built, and other names are still checked", () => {
    const built = assembledToolNames(twoCrms, mcpGrants, {});
    expect(built.has("mcp__crm__create_deal_7")).toBe(true);
    expect(built.has("busca_antiga")).toBe(false);
  });

  test("a tool listed twice in one grant is one tool", () => {
    const built = assembledToolNames(
      catalog({
        mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
      }),
      [
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: ["foo", "foo"],
        }),
      ],
      {},
    );
    expect(built.has("mcp__crm__foo_2")).toBe(false);
  });

  test("a name no other tool reaches gets no suffixes", () => {
    const built = assembledToolNames(
      catalog({
        mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
      }),
      [
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: ["create_deal", "list_deals"],
        }),
      ],
      {},
    );
    expect(built.has("mcp__crm__create_deal")).toBe(true);
    expect(built.has("mcp__crm__create_deal_2")).toBe(false);
  });

  test("a disabled connection builds nothing", () => {
    const built = assembledToolNames(
      catalog({
        mcpConnections: [{ id: "5", name: "CRM", enabled: false, slug: "crm" }],
      }),
      [
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: ["create_deal"],
        }),
      ],
      {},
    );
    expect(built.has("mcp__crm__create_deal")).toBe(false);
  });

  test("a native the catalog leaves out is granted by configuration, so it counts as built", () => {
    // `update_contact` comes from writable contact fields, not from a grant this screen sees.
    const built = assembledToolNames(catalog(), [], {});
    expect(built.has("update_contact")).toBe(true);
    expect(names(catalog(), [])).not.toContain("update_contact");
  });

  test("the audio settings' reply_as_text counts as built", () => {
    expect(assembledToolNames(catalog(), [], {}).has("reply_as_text")).toBe(
      true,
    );
  });

  test("an MCP tool whose name the write boundary refuses is not offered", () => {
    const c = catalog({
      mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
    });
    const offered = names(c, [
      grant({ source: "NATIVE", enabledTools: [] }),
      grant({
        source: "MCP",
        mcpServerConnectionId: "5",
        enabledTools: ["foo.bar", "create_deal"],
      }),
    ]);
    expect(offered).toEqual(["mcp__crm__create_deal"]);
  });

  test("one server's many trimmed tools reach as many suffixes as it has tools", () => {
    const stem = "b".repeat(57);
    const tools = [`${stem}1`, `${stem}2`, `${stem}3`];
    const built = assembledToolNames(
      catalog({
        mcpConnections: [{ id: "5", name: "CRM", enabled: true, slug: "crm" }],
      }),
      [
        grant({
          source: "MCP",
          mcpServerConnectionId: "5",
          enabledTools: tools,
        }),
      ],
      {},
    );
    const base = `mcp____${stem}`;
    expect(built.has(`${base.slice(0, 62)}_3`)).toBe(true);
  });
});

describe("guardableToolsOf, sources a watcher or a collision changes", () => {
  test("a watcher is not offered a document tool, which its muted turn does not build", () => {
    const c = catalog({
      documentTemplates: [
        {
          id: "3",
          name: "Proposta",
          toolName: "send_proposta",
          description: null,
          enabled: true,
          available: true,
        },
      ],
    });
    const g = [grant({ source: "DOCUMENT", documentTemplateId: "3" })];
    expect(names(c, g, { observing: true })).not.toContain("send_proposta");
    expect(names(c, g)).toContain("send_proposta");
  });

  test("a name two toolpacks share is labelled by the tool alone", () => {
    const second = {
      ...(catalog().integrationInstances[0] as object),
      id: "10",
      name: "Agenda 2",
    };
    const c = catalog({
      integrationInstances: [catalog().integrationInstances[0], second],
    });
    const tools = guardableToolsOf(
      c,
      [
        calendar,
        grant({
          source: "INTEGRATION",
          integrationInstanceId: "10",
          enabledTools: ["calendar_check_availability"],
        }),
      ],
      {},
    );
    expect(
      tools.find((t) => t.name === "calendar_check_availability")?.label,
    ).toBe("calendar_check_availability");
  });
});
