import {
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  Network,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, Modal, useModalController } from "@/client/components";
import { useTheme } from "@/client/contexts/ThemeContext";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { toolpackToolMeta } from "@/client/lib/toolpackTools";
import { cn, slugify } from "@/client/lib/utils";
import type { GrantState, ToolCatalog } from "./types";

// A capability is one tool the agent can call, grouped by where it comes from. The graph draws the REAL
// LangGraph topology — START → agent ⇄ tools (ToolNode) → END — and then hangs every granted capability
// off the single `tools` node, grouped by source via subgraphs, so the operator sees both "how the agent
// runs" (the LangGraph spine) and "what it can actually do" (one edge per tool / knowledge base). Built
// entirely from the editor's catalog + grants (no backend); the graph renders client-side via mermaid.

export interface MapGroup {
  key: string;
  label: string;
  items: string[];
}

export function buildGroups(
  catalog: ToolCatalog,
  grants: GrantState[],
  t: ReturnType<typeof useTranslation>["t"],
): MapGroup[] {
  const groups: MapGroup[] = [];

  // Native: an explicit NATIVE grant lists the enabled tools; its absence means ALL native tools (the
  // permissive default mirrored from ToolGrantsEditor).
  const nativeGrant = grants.find((g) => g.source === "NATIVE");
  const nativeNames = nativeGrant
    ? (nativeGrant.enabledTools ?? [])
    : catalog.native.map((n) => n.name);
  if (nativeNames.length > 0) {
    groups.push({
      key: "native",
      label: t("editor.capabilities.native", "Built-in"),
      items: nativeNames.map((n) => nativeToolMeta(n, t).label),
    });
  }

  // Knowledge bases (RAG grants).
  const kbIds = new Set(grants.flatMap((g) => g.knowledgeBaseIds ?? []));
  const kbNames = catalog.knowledgeBases
    .filter((k) => kbIds.has(k.id))
    .map((k) => k.name);
  if (kbNames.length > 0) {
    groups.push({
      key: "knowledge",
      label: t("editor.capabilities.knowledge", "Knowledge"),
      items: kbNames,
    });
  }

  // Custom HTTP tools shown by their display name (label).
  const httpNames = grants
    .filter((g) => g.source === "HTTP")
    .map((g) => {
      const td = catalog.toolDefinitions.find(
        (x) => x.id === g.toolDefinitionId,
      );
      return td ? td.label : undefined;
    })
    .filter((n): n is string => !!n);
  if (httpNames.length > 0) {
    groups.push({
      key: "http",
      label: t("editor.capabilities.http", "Custom HTTP"),
      items: httpNames,
    });
  }

  // MCP servers: one group per granted server, listing its selected tools (or the server itself when
  // none are individually selected).
  for (const g of grants.filter((x) => x.source === "MCP")) {
    const conn = catalog.mcpConnections.find(
      (m) => m.id === g.mcpServerConnectionId,
    );
    if (!conn) continue;
    const tools = g.enabledTools ?? [];
    groups.push({
      key: `mcp:${conn.id}`,
      label: t("editor.capabilities.mcp", "MCP · {{name}}", {
        name: conn.name,
      }),
      items:
        tools.length > 0
          ? tools
          : [t("editor.capabilities.allTools", "(all tools)")],
    });
  }

  // Integrations (toolpacks): one group per granted instance.
  for (const g of grants.filter((x) => x.source === "INTEGRATION")) {
    const inst = catalog.integrationInstances.find(
      (i) => i.id === g.integrationInstanceId,
    );
    if (!inst) continue;
    const tools = g.enabledTools ?? inst.tools.map((tt) => tt.name);
    groups.push({
      key: `integration:${inst.id}`,
      label: t("editor.capabilities.integration", "Integration · {{name}}", {
        name: inst.name,
      }),
      // Show the friendly label per tool (like NATIVE via nativeToolMeta), not the raw internal name.
      items:
        tools.length > 0
          ? tools.map((n) => toolpackToolMeta(n, t).label)
          : [t("editor.capabilities.allTools", "(all tools)")],
    });
  }

  // Document templates: one item per granted template, named by the TOOL the agent will call. A
  // grant whose template was deleted, or which is disabled, still resolves to nothing here for the
  // same reason a stale MCP or integration grant does — the map shows what the agent can call.
  const documentNames = grants
    .filter((g) => g.source === "DOCUMENT")
    .map(
      (g) =>
        catalog.documentTemplates.find(
          // AVAILABLE, not merely enabled: assembly also skips a template whose content this build
          // cannot parse. The map is the operator's answer to "what can this agent call", and
          // drawing a tool that is not in the graph is worse than drawing nothing, since the
          // picture reads as complete. One question, asked of the catalog that answers it.
          (d) => d.id === g.documentTemplateId && d.available,
        )?.toolName,
    )
    .filter((n): n is string => !!n);
  if (documentNames.length > 0) {
    groups.push({
      key: "document",
      label: t("editor.capabilities.documents", "Documents"),
      items: documentNames,
    });
  }

  return groups;
}

// Sanitize a label for a Mermaid node literal (it sits inside ["…"]).
function mmLabel(s: string): string {
  return s
    .replace(/"/g, "'")
    .replace(/[\n\r]+/g, " ")
    .trim();
}

// Caps the tools shown PER GROUP in the graph; beyond this a single "+N…" node stands in for the
// rest (the full per-tool list lives in the capability cards above the graph). Keeps a tool-heavy
// agent's graph readable instead of an unbounded fan-out.
const MAX_GRAPH_ITEMS_PER_GROUP = 12;

// Emits the agent's real LangGraph topology as a vertical (top-to-bottom) Mermaid flowchart:
// START → agent, the agent ⇄ tools (ToolNode) loop driven by the tools-condition, and agent → END.
// Capabilities are grouped by source into subgraphs. To stay readable with many tools, the ToolNode
// links to each GROUP once (not to every tool), and the tools within a group are chained with
// invisible links so they STACK vertically inside the subgraph — so the graph's width tracks the
// number of groups (~5), not the number of tools. Node ids avoid Mermaid's reserved `end` keyword.
export function toMermaid(groups: MapGroup[]): string {
  const lines = [
    "flowchart TB",
    "  nStart([START])",
    '  agent["🤖 agent"]',
    '  nTools["🛠️ tools (ToolNode)"]',
    "  nEnd([END])",
    "  nStart --> agent",
    "  agent -->|tool call| nTools",
    "  nTools -->|result| agent",
    "  agent -->|done| nEnd",
  ];
  groups.forEach((group, gi) => {
    const shown = group.items.slice(0, MAX_GRAPH_ITEMS_PER_GROUP);
    const overflow = group.items.length - shown.length;
    lines.push(`  subgraph g${gi}["${mmLabel(group.label)}"]`);
    lines.push("    direction TB");
    shown.forEach((item, ii) => {
      lines.push(`    n${gi}_${ii}["${mmLabel(item)}"]`);
    });
    if (overflow > 0) {
      lines.push(`    n${gi}_more["+${overflow}…"]`);
    }
    lines.push("  end");
    // Single edge from the ToolNode into the group (its first node), not one per tool.
    if (shown.length > 0) {
      lines.push(`  nTools --> n${gi}_0`);
    }
    // Invisible links chain the tools so the subgraph lays them out vertically (narrow column).
    for (let ii = 1; ii < shown.length; ii++) {
      lines.push(`  n${gi}_${ii - 1} ~~~ n${gi}_${ii}`);
    }
    if (overflow > 0 && shown.length > 0) {
      lines.push(`  n${gi}_${shown.length - 1} ~~~ n${gi}_more`);
    }
  });
  return lines.join("\n");
}

// Kicks off a browser download of `blob` under `fileName`.
function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Triggers a client-side download of `svg` (the rendered Mermaid markup) as an .svg file.
function downloadSvg(svg: string, fileName: string) {
  triggerDownload(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    fileName,
  );
}

// UTF-8-safe base64 (btoa is latin1-only; mermaid labels carry accents). Looped byte-by-byte — a
// graph SVG is a few KB, so this never approaches the argument-count limit of String.fromCharCode(...).
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Rasterizes the rendered SVG into a PNG (2x, on a filled background so it isn't transparent/black) and
// downloads it. Uses a base64 data: URL (same-origin, so the canvas is never tainted) and relies on the
// graph being rendered with htmlLabels:false — no foreignObject, which would otherwise taint the canvas.
async function downloadPng(svgEl: SVGSVGElement, fileName: string, bg: string) {
  const vb = svgEl.viewBox?.baseVal;
  const rect = svgEl.getBoundingClientRect();
  const width = vb?.width || rect.width || 800;
  const height = vb?.height || rect.height || 600;
  // Clone with explicit pixel dimensions so the rasterizer knows the intrinsic size.
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const xml = new XMLSerializer().serializeToString(clone);
  const dataUrl = `data:image/svg+xml;base64,${utf8ToBase64(xml)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("svg image failed to load"));
    img.src = dataUrl;
  });
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const c = canvas.getContext("2d");
  if (!c) return;
  c.fillStyle = bg;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  await new Promise<void>((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) triggerDownload(blob, fileName);
      resolve();
    }, "image/png");
  });
}

// Renders the agent graph as an SVG inside the modal and lets the operator save it. mermaid is
// lazy-imported (heavy dep, kept out of the initial bundle — loaded only when the operator opens the
// graph) and rendered via mermaid.render (its dompurify sanitizes the SVG). On any failure it shows a
// fallback message. `fileName` is the slugified download name for the saved image.
function GraphModalBody({
  code,
  fileNameBase,
}: {
  code: string;
  // Base download name (no extension); the SVG/PNG buttons append ".svg" / ".png".
  fileNameBase: string;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setSvg(null);
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "light" ? "default" : "dark",
          // Render labels as <text>, not foreignObject HTML — foreignObject taints the canvas and
          // would block the PNG export.
          flowchart: { htmlLabels: false },
        });
        const { svg: rendered } = await mermaid.render(
          `capmap-${crypto.randomUUID()}`,
          code,
        );
        if (cancelled) return;
        if (ref.current) ref.current.innerHTML = rendered;
        setSvg(rendered);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-text-muted text-xs">
          {t(
            "editor.capabilities.graphLegend",
            "The agent's LangGraph runtime: START → agent ⇄ tools (ToolNode) → END, with each granted tool and knowledge base hanging off the ToolNode.",
          )}
        </span>
        {state === "ready" && svg && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => downloadSvg(svg, `${fileNameBase}.svg`)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-text-secondary text-xs hover:bg-bg-hover hover:text-text-primary"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t("editor.capabilities.saveSvg", "Save SVG")}
            </button>
            <button
              type="button"
              onClick={() => {
                const svgEl = ref.current?.querySelector("svg");
                if (!svgEl) return;
                const bg =
                  getComputedStyle(document.body).backgroundColor ||
                  (resolvedTheme === "light" ? "#ffffff" : "#0a0a0a");
                void downloadPng(svgEl, `${fileNameBase}.png`, bg).catch(
                  () => {},
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-text-secondary text-xs hover:bg-bg-hover hover:text-text-primary"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t("editor.capabilities.savePng", "Save PNG")}
            </button>
          </div>
        )}
      </div>
      {state === "error" ? (
        <p className="text-sm text-text-muted">
          {t(
            "editor.capabilities.graphError",
            "Couldn't render the graph here. Try reopening it.",
          )}
        </p>
      ) : (
        <div
          ref={ref}
          // Natural SVG width (max-w-none) + overflow-auto → horizontal scroll for wide graphs;
          // max-h-[72vh] gives a taller viewport. No justify-center so the start isn't clipped on scroll.
          className="max-h-[72vh] overflow-auto [&_svg]:h-auto [&_svg]:max-w-none"
          // role status while loading so the (async) render is announced; the SVG is injected above.
          aria-busy={state === "loading"}
        />
      )}
    </div>
  );
}

export function CapabilityMap({
  catalog,
  grants,
  agentName,
}: {
  catalog: ToolCatalog;
  grants: GrantState[];
  // Used to name the downloaded graph image (slugified, NFD-stripped).
  agentName?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const graphModal = useModalController();
  const groups = buildGroups(catalog, grants, t);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  const mermaidCode = toMermaid(groups);
  const imageFileNameBase = `agents-${slugify(agentName ?? "") || "agent"}-grafo`;

  return (
    <Card id="general-capabilities" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          )}
          <Network className="h-4 w-4 text-accent" aria-hidden="true" />
          <span className="font-medium text-sm text-text-primary">
            {t("editor.capabilities.title", "Capability map")}
          </span>
          <span className="text-text-muted text-xs">
            {t("editor.capabilities.count", "{{n}} tools", { n: total })}
          </span>
        </button>
        {total > 0 && (
          <button
            type="button"
            onClick={() => graphModal.open()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-text-secondary text-xs hover:bg-bg-hover hover:text-text-primary"
          >
            <Network className="h-3.5 w-3.5" aria-hidden="true" />
            {t("editor.capabilities.viewGraph", "View graph")}
          </button>
        )}
      </div>
      {open &&
        (total === 0 ? (
          <p className="text-sm text-text-muted">
            {t(
              "editor.capabilities.empty",
              "No tools granted yet — the agent can only chat.",
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex shrink-0 items-center gap-2 self-center rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 font-medium text-sm text-text-primary">
              <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("editor.capabilities.agent", "Agent")}
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {groups.map((group) => (
                <div
                  key={group.key}
                  className="rounded-lg border border-border bg-bg-secondary p-2"
                >
                  <p className="mb-1.5 font-medium text-[10px] text-text-muted uppercase tracking-wider">
                    {group.label}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.items.map((item) => (
                      <span
                        key={item}
                        className={cn(
                          "inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-text-secondary text-xs",
                        )}
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      <Modal
        modal={graphModal}
        title={t("editor.capabilities.graphTitle", "Agent graph (LangGraph)")}
        size="xl"
      >
        <GraphModalBody code={mermaidCode} fileNameBase={imageFileNameBase} />
      </Modal>
    </Card>
  );
}
