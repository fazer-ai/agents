import { describe, expect, test } from "bun:test";
import { AgentToolSource } from "@/../generated/prisma/client";
import {
  buildGroups,
  type MapGroup,
  toMermaid,
} from "@/client/pages/agents/CapabilityMap";
import type { GrantState, ToolCatalog } from "@/client/pages/agents/types";

// The capability graph draws the REAL LangGraph topology (vertical): the START → agent ⇄ tools
// (ToolNode) → END spine. To stay readable with many tools, the ToolNode links to each GROUP once
// (not to every tool) and tools stack vertically inside their subgraph, so the graph's width tracks
// the number of groups, not the number of tools. Large groups collapse to a "+N…" overflow node.
describe("toMermaid — agent graph (LangGraph)", () => {
  const groups: MapGroup[] = [
    { key: "native", label: "Built-in", items: ["Transfer", "Tag"] },
    { key: "http", label: "Custom HTTP", items: ["Look up order"] },
  ];

  test("emits a vertical (TB) flowchart with the LangGraph spine", () => {
    const m = toMermaid(groups);
    expect(m.startsWith("flowchart TB")).toBe(true);
    // The real spine: START → agent, the agent ⇄ tools loop, agent → END.
    expect(m).toContain("nStart([START])");
    expect(m).toContain("nEnd([END])");
    expect(m).toContain("nStart --> agent");
    expect(m).toContain("agent -->|tool call| nTools");
    expect(m).toContain("nTools -->|result| agent");
    expect(m).toContain("agent -->|done| nEnd");
  });

  test("links the ToolNode to each GROUP once, keeping every tool as a node", () => {
    const m = toMermaid(groups);
    const edges = m.split("\n").filter((l) => l.includes("nTools --> n"));
    // One edge per group (2 groups), regardless of how many tools each holds.
    expect(edges).toHaveLength(2);
    // Every capability is still drawn as a node.
    expect(m).toContain('"Transfer"');
    expect(m).toContain('"Tag"');
    expect(m).toContain('"Look up order"');
    // Tools within a group stack via invisible links (Built-in has 2 → at least one ~~~).
    expect(m).toContain("~~~");
  });

  test("with no capabilities, only the spine is drawn", () => {
    const m = toMermaid([]);
    expect(m.startsWith("flowchart TB")).toBe(true);
    expect(m).not.toContain("nTools --> n");
    expect(m).toContain("agent -->|done| nEnd");
  });

  test("caps a large group with a '+N…' overflow node", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Tool ${i + 1}`);
    const m = toMermaid([{ key: "native", label: "Built-in", items: many }]);
    // 20 items, cap 12 → 8 hidden behind the overflow marker.
    expect(m).toContain('"+8…"');
    expect(m).toContain('"Tool 12"');
    expect(m).not.toContain('"Tool 13"');
  });
});

// The map is the operator's answer to "what can this agent actually do", on the General tab and in
// the diagram they export. A source it does not know is a tool the agent calls and the picture does
// not show — which is worse than showing nothing, because the picture reads as complete.
//
// A SWEEP over the database's own enum, not a list of examples: every source is added there first,
// so a source that reaches the model without reaching this function fails here rather than in a
// screenshot months later. That is the shape of the miss this test exists for — DOCUMENT was added
// to the enum, the grant editor, the export and the runtime, and not to this map.
describe("buildGroups — every grant source is drawn", () => {
  const t = ((_k: string, fallback?: string, opts?: Record<string, string>) =>
    typeof fallback === "string"
      ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => opts?.[k] ?? "")
      : "") as unknown as Parameters<typeof buildGroups>[2];

  const catalog = {
    native: [{ name: "handoff_to_human" }],
    knowledgeBases: [{ id: "1", name: "Base" }],
    toolDefinitions: [{ id: "2", label: "Look up order" }],
    mcpConnections: [{ id: "3", name: "Sheets" }],
    integrationInstances: [
      { id: "4", name: "CRM", tools: [{ name: "crm_lookup" }] },
    ],
    documentTemplates: [
      {
        id: "5",
        name: "Orçamento",
        toolName: "send_orcamento",
        enabled: true,
        available: true,
      },
      // Disabled by the operator.
      {
        id: "6",
        name: "Antigo",
        toolName: "send_antigo",
        enabled: false,
        available: false,
      },
      // ENABLED, but its content is unreadable by this build — written by a newer version and seen
      // after a downgrade. The assembly skips it, and only `available` says so.
      {
        id: "7",
        name: "Do futuro",
        toolName: "send_futuro",
        enabled: true,
        available: false,
      },
    ],
  } as unknown as ToolCatalog;

  const grantFor: Record<string, GrantState> = {
    NATIVE: { source: "NATIVE", enabledTools: ["handoff_to_human"] },
    RAG: { source: "RAG", knowledgeBaseIds: ["1"] },
    HTTP: { source: "HTTP", toolDefinitionId: "2" },
    MCP: { source: "MCP", mcpServerConnectionId: "3" },
    INTEGRATION: { source: "INTEGRATION", integrationInstanceId: "4" },
    DOCUMENT: { source: "DOCUMENT", documentTemplateId: "5" },
  };

  test("every source in the enum produces a group", () => {
    const missing: string[] = [];
    for (const source of Object.values(AgentToolSource)) {
      const grant = grantFor[source];
      if (!grant) {
        missing.push(`${source} (no fixture)`);
        continue;
      }
      // NATIVE is the permissive default, so it draws with or without a grant; every other source
      // has to be asked for. Passing ONLY this grant isolates what it contributes.
      const groups = buildGroups(catalog, [grant], t);
      const drawn = groups.filter(
        (g) => source !== "NATIVE" || g.key === "native",
      );
      if (drawn.length === 0 || drawn.every((g) => g.items.length === 0)) {
        missing.push(source);
      }
    }
    expect(missing).toEqual([]);
  });

  // The editor's row and the map read the SAME field, and it is the one the assembly answers. A
  // template that is enabled but unreadable is the case the two used to disagree on: the map drew
  // its tool and the editor offered it as an ordinary grant, while the runtime exposed neither.
  test("enabled and available are not the same question", () => {
    const future = catalog.documentTemplates.find((d) => d.id === "7");
    expect(future?.enabled).toBe(true);
    expect(future?.available).toBe(false);
  });

  test("a document grant is named by the tool the agent will call", () => {
    const groups = buildGroups(catalog, [grantFor.DOCUMENT as GrantState], t);
    const documents = groups.find((g) => g.key === "document");
    expect(documents?.items).toEqual(["send_orcamento"]);
  });

  // A grant the ASSEMBLY would skip draws nothing either, and it has to answer to both ways that
  // happens: the operator disabled the template, or this build cannot read its content (one written
  // by a newer version, seen after a downgrade). Only the second distinguishes `available` from
  // `enabled`, which is why it is here — drawing it claims a tool that is not in the agent's graph.
  test("a grant the runtime would skip draws nothing", () => {
    for (const id of ["6", "7"]) {
      const groups = buildGroups(
        catalog,
        [{ source: "DOCUMENT", documentTemplateId: id }],
        t,
      );
      expect(groups.find((g) => g.key === "document")).toBeUndefined();
    }
  });

  // A grant pointing at a template that is gone resolves to nothing, the way a stale MCP or
  // integration grant does: the map shows what the agent can call, not what it was once given.
  test("a grant whose template no longer exists draws nothing", () => {
    const groups = buildGroups(
      catalog,
      [{ source: "DOCUMENT", documentTemplateId: "999" }],
      t,
    );
    expect(groups.find((g) => g.key === "document")).toBeUndefined();
  });
});
