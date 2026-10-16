// What a voice agent's Tools tab offers: the catalog minus what a call never runs, the
// same list the call's toolset drops (`isVoiceDeniedTool`), so the tab draws exactly what a call can use.

import { isVoiceDeniedTool } from "@/modules/voice-call/denied-tools";
import type { ToolCatalog } from "./types";

export function voiceToolCatalog(catalog: ToolCatalog): ToolCatalog {
  return {
    ...catalog,
    native: catalog.native.filter((n) => !isVoiceDeniedTool(n.name)),
    integrationInstances: catalog.integrationInstances.map((inst) => ({
      ...inst,
      tools: inst.tools.filter((tool) => !isVoiceDeniedTool(tool.name)),
    })),
  };
}
