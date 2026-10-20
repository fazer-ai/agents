/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import clientEn from "@/client/locales/en.json";
import {
  type CallFloor,
  CallFloorContext,
} from "@/client/pages/agents/CallFloor";
import {
  buildGroups,
  CapabilityMap,
  groupTotal,
  itemTokens,
} from "@/client/pages/agents/CapabilityMap";
import type { GrantState, ToolCatalog } from "@/client/pages/agents/types";

// The capability map carries the same per-call numbers as the Tools tab: each pill its tool's, each
// group the sum of what it holds, and no number where the floor has none.

afterEach(() => {
  cleanup();
});

const t = ((_k: string, fallback?: string, opts?: Record<string, string>) =>
  typeof fallback === "string"
    ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => opts?.[k] ?? "")
    : "") as unknown as Parameters<typeof buildGroups>[2];

const catalog = {
  native: [{ name: "handoff_to_human" }, { name: "set_labels" }],
  knowledgeBases: [{ id: "1", name: "Base" }],
  toolDefinitions: [
    { id: "2", name: "consultar_pedido", label: "Consultar pedido" },
  ],
  mcpConnections: [
    { id: "3", name: "Planilhas" },
    { id: "9", name: "Estoque" },
  ],
  codeTools: [{ id: "8", name: "somar", label: "Somar", enabled: true }],
  integrationInstances: [
    {
      id: "4",
      name: "CRM",
      tools: [{ name: "crm_lookup" }, { name: "crm_update" }],
    },
  ],
  documentTemplates: [
    {
      id: "5",
      name: "Orçamento",
      toolName: "send_orcamento",
      enabled: true,
      available: true,
    },
  ],
} as unknown as ToolCatalog;

const grants: GrantState[] = [
  { source: "NATIVE", enabledTools: ["handoff_to_human", "set_labels"] },
  { source: "RAG", knowledgeBaseIds: ["1"] },
  { source: "HTTP", toolDefinitionId: "2" },
  { source: "CODE", codeToolDefinitionId: "8" },
  { source: "MCP", mcpServerConnectionId: "3", enabledTools: ["ler"] },
  { source: "MCP", mcpServerConnectionId: "9" },
  { source: "INTEGRATION", integrationInstanceId: "4" },
  { source: "DOCUMENT", documentTemplateId: "5" },
];

const FLOOR: CallFloor = {
  engine: "llm",
  instructions: 0,
  instructionsAdded: 140,
  instructionsAddedBy: { grounding: 100, mcp: 40 },
  tools: [
    { name: "handoff_to_human", category: "native", estimatedTokens: 255 },
    { name: "set_labels", category: "native", estimatedTokens: 180 },
    { name: "search_knowledge", category: "knowledge", estimatedTokens: 90 },
    {
      name: "consultar_pedido",
      category: "http",
      estimatedTokens: 812,
      label: "Consultar pedido",
    },
    { name: "somar", category: "code", estimatedTokens: 64, label: "Somar" },
    {
      name: "mcp__planilhas__ler",
      category: "mcp",
      estimatedTokens: 300,
      mcp: { connectionId: "3", tool: "ler" },
    },
    {
      name: "mcp__estoque__a",
      category: "mcp",
      estimatedTokens: 70,
      mcp: { connectionId: "9", tool: "a" },
    },
    {
      name: "mcp__estoque__b",
      category: "mcp",
      estimatedTokens: 30,
      mcp: { connectionId: "9", tool: "b" },
    },
    {
      name: "crm_lookup",
      category: "integration",
      estimatedTokens: 40,
      integrationInstanceId: "4",
    },
    {
      name: "crm_update",
      category: "integration",
      estimatedTokens: 60,
      integrationInstanceId: "4",
    },
    {
      name: "send_orcamento",
      category: "external",
      estimatedTokens: 410,
      templateId: "5",
    },
  ],
  total: 0,
};

describe("the map's numbers", () => {
  test("each item is its tool's number and each group the sum of what it holds", () => {
    const groups = buildGroups(catalog, grants, t);
    const drawn = groups.map((g) => [
      g.key,
      g.items.map((i) => [i.label, itemTokens(FLOOR, i)]),
      groupTotal(FLOOR, g),
    ]);
    expect(drawn).toEqual([
      [
        "native",
        [
          ["Hand off to human", 255],
          ["Set labels", 180],
        ],
        435,
      ],
      // A base has no tool of its own: the group costs the search and the rules it appends.
      ["knowledge", [["Base", null]], 90 + 100],
      ["http", [["Consultar pedido", 812]], 812],
      ["code", [["Somar", 64]], 64],
      ["mcp:3", [["ler", 300]], 300],
      // Granted with all tools: the server's total.
      ["mcp:9", [["(all tools)", 100]], 100],
      [
        "integration:4",
        [
          ["crm_lookup", 40],
          ["crm_update", 60],
        ],
        100,
      ],
      ["document", [["send_orcamento", 410]], 410],
    ]);
  });

  test("with no floor, or a decisions engine, nothing has a number", () => {
    const groups = buildGroups(catalog, grants, t);
    const decisions = { ...FLOOR, engine: "decisions" } as CallFloor;
    for (const floor of [null, decisions]) {
      for (const g of groups) {
        expect(groupTotal(floor, g)).toBeNull();
        for (const i of g.items) expect(itemTokens(floor, i)).toBeNull();
      }
    }
  });

  test("a tool the floor did not measure has no number, and the group sums only the rest", () => {
    const partial: CallFloor = {
      ...FLOOR,
      tools: FLOOR.tools.filter((tl) => tl.name !== "set_labels"),
    };
    const native = buildGroups(catalog, grants, t).find(
      (g) => g.key === "native",
    );
    if (!native) throw new Error("no native group");
    expect(native.items.map((i) => itemTokens(partial, i))).toEqual([
      255,
      null,
    ]);
    expect(groupTotal(partial, native)).toBe(255);
  });
});

async function renderMap(floor: CallFloor | null, ui: ReactNode = null) {
  const i = i18next.createInstance();
  await i.init({
    lng: "en",
    resources: { en: { translation: clientEn } },
    interpolation: { escapeValue: false },
  });
  return render(
    <I18nextProvider i18n={i}>
      <CallFloorContext.Provider value={floor}>
        <CapabilityMap catalog={catalog} grants={grants} />
        {ui}
      </CallFloorContext.Provider>
    </I18nextProvider>,
  );
}

describe("CapabilityMap", () => {
  test("opened, a pill shows its tool's number and a group its total", async () => {
    await renderMap(FLOOR);
    fireEvent.click(screen.getByRole("button", { name: /Capability map/ }));
    expect(screen.getByText("Consultar pedido").textContent).toBe(
      "Consultar pedido~812",
    );
    expect(screen.getByText("~435 tokens per call")).toBeTruthy();
    expect(screen.getByText("~190 tokens per call")).toBeTruthy();
  });

  test("before the floor loads, the pills carry no number", async () => {
    await renderMap(null);
    fireEvent.click(screen.getByRole("button", { name: /Capability map/ }));
    expect(screen.getByText("Consultar pedido").textContent).toBe(
      "Consultar pedido",
    );
    expect(screen.queryByText(/tokens per call/)).toBeNull();
  });
});
