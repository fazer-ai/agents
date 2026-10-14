import { NATIVE_TOOL_NAMES, REPLY_AS_TEXT_TOOL } from "@/graph/tools/catalog";
import { mcpRuntimeBase } from "@/graph/tools/mcp-names";
import { isGuardableToolName } from "@/modules/agents/tool-preconditions";
import { DECISION_ACTION_TOOLS } from "@/modules/decisions/config";
import { customToolsOf } from "./decisionsFormState";
import { offeredPackTools } from "./ToolGrantsEditor";
import type { GrantState, ToolCatalog } from "./types";

// A tool a precondition can be put on, by the name the model calls it (the key the runtime matches).
export interface GuardableTool {
  name: string;
  // What the operator recognizes: the native's own label is resolved by the editor, so it is absent
  // here; a custom tool carries its label, an MCP or toolpack tool its server or integration name.
  label: string | null;
  kind: "native" | "http" | "code" | "mcp" | "toolpack" | "rag" | "document";
}

// Every tool this agent is granted, from every source, as the assembly would name it. A rule on a tool
// the agent does not get is inert and reads as protection, so only granted tools are offered, and a
// saved rule on any other name is the one the editor flags.
//
// Natives follow ToolGrantsEditor's rule (no NATIVE row = all, a row = its allowlist) minus what a
// watcher's muted turn strips; HTTP, code and MCP come from `customToolsOf`, the same answer the
// decisions editor gives; a toolpack exposes what its grant enables, as a fail-closed allowlist. A
// decisions agent's rules call natives from the action list and custom tools, never toolpacks.
export function guardableToolsOf(
  catalog: ToolCatalog,
  grants: readonly GrantState[],
  opts: { observing?: boolean; decides?: boolean },
): GuardableTool[] {
  const out: GuardableTool[] = [];
  const nativeGrant = grants.find((g) => g.source === "NATIVE");
  const offeredNative = new Set(
    offeredPackTools(catalog.native, opts.observing).map((n) => n.name),
  );
  const natives = nativeGrant
    ? (nativeGrant.enabledTools ?? [])
    : catalog.native.map((n) => n.name);
  for (const name of natives) {
    if (!offeredNative.has(name)) continue;
    if (
      opts.decides &&
      !(DECISION_ACTION_TOOLS as readonly string[]).includes(name)
    )
      continue;
    out.push({ name, label: null, kind: "native" });
  }

  const custom = customToolsOf(catalog, grants);
  for (const name of custom.granted) {
    const offer = custom.all.get(name);
    if (offer) out.push({ name, label: offer.label, kind: offer.kind });
  }

  if (!opts.decides) {
    for (const g of grants) {
      // A RAG row with no tool enabled builds nothing (the assembly skips it).
      if (g.source === "RAG") {
        for (const name of g.enabledTools ?? [])
          out.push({ name, label: null, kind: "rag" });
        continue;
      }
      // NOTE: a watcher's muted turn builds no document tool.
      if (g.source === "DOCUMENT") {
        if (opts.observing) continue;
        const tpl = catalog.documentTemplates.find(
          (d) => d.id === g.documentTemplateId,
        );
        if (tpl?.enabled && tpl.available)
          out.push({ name: tpl.toolName, label: tpl.name, kind: "document" });
        continue;
      }
      if (g.source !== "INTEGRATION") continue;
      const inst = catalog.integrationInstances.find(
        (i) => i.id === g.integrationInstanceId,
      );
      if (!inst || inst.enabled === false || inst.kind !== "TOOLPACK") continue;
      const allowed = new Set(g.enabledTools ?? []);
      for (const tool of offeredPackTools(inst.tools, opts.observing)) {
        if (!allowed.has(tool.name)) continue;
        out.push({
          name: tool.name,
          label: `${inst.name}: ${tool.name}`,
          kind: "toolpack",
        });
      }
    }
  }

  // Two integrations of one catalog type expose the same names, and which one the assembly keeps is
  // decided by an order this screen does not see, so such a name carries no integration's label.
  const packs = new Map<string, number>();
  for (const t of out)
    if (t.kind === "toolpack") packs.set(t.name, (packs.get(t.name) ?? 0) + 1);
  for (const t of out)
    if (t.kind === "toolpack" && (packs.get(t.name) ?? 0) > 1) t.label = t.name;

  // One entry per name: the assembly keeps one tool per name too (dropDuplicateToolNames).
  const seen = new Set<string>();
  // A name the write boundary refuses (an MCP tool called `foo.bar`) is not offered: the save would fail.
  return out.filter((t) => {
    if (!isGuardableToolName(t.name) || seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

// Whether a saved rule's name is one the turn may build, which is wider than what the select offers.
// MCP names are exact while no two granted tools reach one name. Where two do, the assembly suffixes
// the later ones in the server's listing order, which this screen does not have, so any MCP name is
// then taken as possibly built: a missed warning there is better than calling a working guard inert.
export interface BuiltTools {
  has(name: string): boolean;
}

export function assembledToolNames(
  catalog: ToolCatalog,
  grants: readonly GrantState[],
  opts: { observing?: boolean; decides?: boolean },
): BuiltTools {
  const names = new Set(
    guardableToolsOf(catalog, grants, opts).map((t) => t.name),
  );
  // A native the catalog leaves out is granted by configuration (`update_contact` by writable contact
  // fields, for one), which this screen cannot see, so a rule on it is not called inert; the same goes
  // for `reply_as_text`, which the agent's audio settings build.
  const listed = new Set(catalog.native.map((n) => n.name));
  for (const n of NATIVE_TOOL_NAMES) if (!listed.has(n)) names.add(n);
  names.add(REPLY_AS_TEXT_TOOL);
  const bases = new Map<string, number>();
  for (const g of grants) {
    if (g.source !== "MCP") continue;
    const conn = catalog.mcpConnections.find(
      (c) => c.id === g.mcpServerConnectionId,
    );
    if (!conn || conn.enabled === false) continue;
    // NOTE: a tool listed twice in one grant is exposed once.
    for (const tool of new Set(g.enabledTools ?? [])) {
      const base = mcpRuntimeBase(conn.slug, tool);
      bases.set(base, (bases.get(base) ?? 0) + 1);
    }
  }
  for (const base of bases.keys()) names.add(base);
  const collides = [...bases.values()].some((n) => n > 1);
  return {
    has: (name) => names.has(name) || (collides && name.startsWith("mcp__")),
  };
}
