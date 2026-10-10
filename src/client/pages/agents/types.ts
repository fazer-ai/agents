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
  source:
    | "NATIVE"
    | "RAG"
    | "HTTP"
    | "MCP"
    | "INTEGRATION"
    | "DOCUMENT"
    | "CODE";
  toolDefinitionId?: string | null;
  mcpServerConnectionId?: string | null;
  integrationInstanceId?: string | null;
  documentTemplateId?: string | null;
  codeToolDefinitionId?: string | null;
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

// The refusal marks the editor hands its tabs, one object per tab. The readings stay in
// `AgentEditorPage` because `tests/client/field-refusal-fence.test.ts` requires every name a form
// declares to be read by an `at(…)` call in that same file; a `refusalAt` callback here would leave
// the declaration unanswered. Null is the normal value: at most one input is refused at a time.
export interface BehaviorRefusals {
  sttCredential: string | null;
  ttsCredential: string | null;
  ttsNormalizeCredential: string | null;
  visionCredential: string | null;
  visionExtractionPrompt: string | null;
  // The spoken-reply notice and the reply_as_text note.
  ttsSpokenNoticeText: string | null;
  ttsTextChoiceNote: string | null;
  contactAuthCredential: string | null;
  contactAuthDenyMessage: string | null;
  memoryCredential: string | null;
  modelFallbackCredential: string | null;
  // The decisions engine's API key, drawn in the Observation section of a watcher.
  decisionsCredential: string | null;
  awayMessage: string | null;
  // By index, because the server refuses a follow-up note as `followUp.steps[2].instructions` and the
  // step it names is the one that has to carry the mark.
  followUpSteps: readonly (string | null)[];
  // By cadence, then by step: `snoozedFollowUp.cadences[1].steps[0].instructions`.
  snoozedFollowUpSteps: readonly (readonly (string | null)[])[];
}

export interface GuardrailsRefusals {
  credential: string | null;
  customPolicy: string | null;
  inputTemplateMessage: string | null;
  outputTemplateMessage: string | null;
  outputGenerationPrompt: string | null;
  inputHandoffMessage: string | null;
  outputHandoffMessage: string | null;
}

export interface ToolRefusals {
  handoffInstructions: string | null;
  kanbanInstructions: string | null;
  attributeInstructions: string | null;
  labelInstructions: string | null;
  updateKanbanInstructions: string | null;
}
