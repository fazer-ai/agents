import { describe, expect, test } from "bun:test";
import { guardableToolsOf } from "@/client/pages/agents/guardableTools";
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
});
