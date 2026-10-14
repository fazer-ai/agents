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
  kind: "native" | "http" | "code" | "mcp" | "toolpack";
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

  // One entry per name: the assembly keeps one tool per name too (dropDuplicateToolNames).
  const seen = new Set<string>();
  return out.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}
