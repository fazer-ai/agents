import type { api } from "@/client/lib/api";

// Eden-derived tool-selection view for the agent editor (the dynamic
// /agents/:id/tool-selections route).
type ToolSelectionResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.agents>["tool-selections"]["get"]>
>;
export type ToolSelectionView = NonNullable<ToolSelectionResp["data"]>;
export type ToolCatalog = ToolSelectionView["catalog"];

// Mutable working copy of a grant (the GET view returns readonly arrays). Shape
// matches the PUT body (ToolGrantInput); omitted fields default server-side.
export interface GrantState {
  source: "NATIVE" | "RAG" | "HTTP" | "MCP" | "INTEGRATION" | "DOCUMENT";
  toolDefinitionId?: string | null;
  mcpServerConnectionId?: string | null;
  integrationInstanceId?: string | null;
  documentTemplateId?: string | null;
  knowledgeBaseIds?: string[];
  enabledTools?: string[];
}

// Derived from the vault treaty response; never hand-mirrored (see docs/eden-treaty.md).
export type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

// Eden-derived business-hours entry for the agent editor.
type HoursData = Awaited<
  ReturnType<(typeof api.api.v1)["business-hours"]["get"]>
>["data"];
export type Hours = NonNullable<HoursData>["businessHours"][number];

// UI-side handoff config (the editor's working copy). `target` encodes the pinned pick as
// "agent:<id>" | "team:<id>" | "" so one <Select> offers both groups; AgentEditorPage splits it
// back into targetAgentId/targetTeamId on save. Lives on the handoff_to_human tool (Tools tab).
export interface HandoffUiState {
  mode: string;
  target: string;
  // The ChatwootInstance id (number) the pinned target was picked from; null unless pinned.
  targetInstanceId: number | null;
  // Operator-authored transfer guidance, appended to the handoff_to_human tool description.
  // Persisted in agent.settings.handoff.instructions.
  instructions: string;
}

// One row of the tool-precondition editor. The stored shape is a map keyed by tool name; the editor
// holds a list so a row survives the operator clearing the tool name to pick another one.
export interface ToolPreconditionRow {
  tool: string;
  scope: "conversation" | "contact";
  key: string;
  equals: string;
}

// THE MARKS THE EDITOR HANDS ITS TABS.
//
// One object per tab and not one prop per input, and the shape is forced rather than chosen. The
// fence in `tests/client/field-refusal-fence.test.ts` asks that every name a form DECLARES be read
// back by an `at(…)` call in the SAME file, so the readings have to stay in `AgentEditorPage` and
// only their answers travel. Handing a tab a `refusalAt` callback instead would move the readings
// into the tab and leave the declaration answered by nothing — which is the exact shape that rule
// exists to catch, since a declared name with no control behind it makes `placeRefusal` report a
// placement and the caller then keeps the toast quiet.
//
// Null is the normal value of every one of these: at most one input is refused at a time.
export interface BehaviorRefusals {
  sttCredential: string | null;
  ttsCredential: string | null;
  ttsNormalizeCredential: string | null;
  visionCredential: string | null;
  visionExtractionPrompt: string | null;
  contactAuthCredential: string | null;
  contactAuthDenyMessage: string | null;
  memoryCredential: string | null;
  modelFallbackCredential: string | null;
  awayMessage: string | null;
  // By index, because the server refuses a follow-up note as `followUp.steps[2].instructions` and the
  // step it names is the one that has to carry the mark.
  followUpSteps: readonly (string | null)[];
}

export interface GuardrailsRefusals {
  credential: string | null;
  customPolicy: string | null;
  inputTemplateMessage: string | null;
  outputTemplateMessage: string | null;
  outputGenerationPrompt: string | null;
}

export interface ToolRefusals {
  handoffInstructions: string | null;
  kanbanInstructions: string | null;
  attributeInstructions: string | null;
  labelInstructions: string | null;
  updateKanbanInstructions: string | null;
}
