import {
  Code2,
  FileText,
  Plug,
  Puzzle,
  ShieldCheck,
  Webhook,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DiscoveredMcpTool } from "@/client/components/mcp/DiscoveredMcpTools";
import type { CrossInboxCaseState } from "./CrossInboxCaseFields";
import { assembledToolNames, guardableToolsOf } from "./guardableTools";
import type { ResolveConversationState } from "./ResolveConversationFields";
import { SectionNav } from "./SectionNav";
import type { SendImageState } from "./SendImageFields";
import { TabActionBar } from "./TabActionBar";
import { ToolGrantsEditor } from "./ToolGrantsEditor";
import { ToolPreconditionsEditor } from "./ToolPreconditionsEditor";
import type {
  GrantState,
  HandoffUiState,
  ToolCatalog,
  ToolPreconditionRow,
  ToolRefusals,
} from "./types";
import { voiceToolCatalog } from "./voiceToolCatalog";

interface ToolsTabProps {
  agentId: string;
  // Passed straight through: a watcher's toolset is assembled MUTED, so the editor must not offer
  // the tools that assembly drops.
  observing?: boolean;
  // A voice agent: the tab draws only what a call can run (`isVoiceDeniedTool`).
  voice?: boolean;
  // Questions and rules: see ToolGrantsEditor.
  decides?: boolean;
  catalog: ToolCatalog;
  grants: GrantState[];
  onChange: React.Dispatch<React.SetStateAction<GrantState[]>>;
  onCatalogChange: () => void | Promise<void>;
  transferWithSummary: boolean;
  setTransferWithSummary: (v: boolean) => void;
  handoff: HandoffUiState;
  setHandoff: React.Dispatch<React.SetStateAction<HandoffUiState>>;
  kanbanInstructions: string;
  setKanbanInstructions: (v: string) => void;
  customAttributeInstructions: string;
  crossInboxCase: CrossInboxCaseState;
  setCrossInboxCase: React.Dispatch<React.SetStateAction<CrossInboxCaseState>>;
  sendImage: SendImageState;
  setSendImage: React.Dispatch<React.SetStateAction<SendImageState>>;
  resolveConversation: ResolveConversationState;
  setResolveConversation: React.Dispatch<
    React.SetStateAction<ResolveConversationState>
  >;
  refusals: ToolRefusals;
  setCustomAttributeInstructions: (v: string) => void;
  labelInstructions: string;
  setLabelInstructions: (v: string) => void;
  protectedLabels: string;
  setProtectedLabels: (v: string) => void;
  allowedLabels: string;
  setAllowedLabels: (v: string) => void;
  outsideAllowedLabels: "refuse" | "accept";
  setOutsideAllowedLabels: (v: "refuse" | "accept") => void;
  labelRemoval: "any" | "allowed";
  setLabelRemoval: (v: "any" | "allowed") => void;
  updateKanbanTaskInstructions: string;
  setUpdateKanbanTaskInstructions: (v: string) => void;
  // Per-tool preconditions. Owned by AgentEditorPage like the guidance above, and saved
  // by this tab, because a precondition is config OF a tool.
  toolPreconditions: ToolPreconditionRow[];
  setToolPreconditions: (rows: ToolPreconditionRow[]) => void;
  // Discovered MCP tools + per-connection collapse state, owned by AgentEditorPage so the discovery
  // survives tab switches (this tab unmounts when inactive).
  mcpTools: Record<string, DiscoveredMcpTool[]>;
  setMcpTools: React.Dispatch<
    React.SetStateAction<Record<string, DiscoveredMcpTool[]>>
  >;
  mcpInstructions: Record<string, string | null>;
  setMcpInstructions: React.Dispatch<
    React.SetStateAction<Record<string, string | null>>
  >;
  mcpCollapsed: Record<string, boolean>;
  setMcpCollapsed: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  integrationCollapsed: Record<string, boolean>;
  setIntegrationCollapsed: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  // Absent for a WATCHER: the playground loads the agent without `ignoreMode`, so a monitoring
  // agent cannot run there and the action would open a panel whose every run fails. Same shape
  // General and Behavior already use.
  onOpenPlayground?: () => void;
}

export function ToolsTab({
  agentId,
  observing,
  voice,
  decides,
  catalog,
  grants,
  onChange,
  onCatalogChange,
  transferWithSummary,
  setTransferWithSummary,
  handoff,
  setHandoff,
  kanbanInstructions,
  setKanbanInstructions,
  customAttributeInstructions,
  crossInboxCase,
  setCrossInboxCase,
  sendImage,
  setSendImage,
  resolveConversation,
  setResolveConversation,
  refusals,
  setCustomAttributeInstructions,
  labelInstructions,
  setLabelInstructions,
  protectedLabels,
  setProtectedLabels,
  allowedLabels,
  setAllowedLabels,
  outsideAllowedLabels,
  setOutsideAllowedLabels,
  labelRemoval,
  setLabelRemoval,
  updateKanbanTaskInstructions,
  setUpdateKanbanTaskInstructions,
  toolPreconditions,
  setToolPreconditions,
  mcpTools,
  setMcpTools,
  mcpInstructions,
  setMcpInstructions,
  mcpCollapsed,
  setMcpCollapsed,
  integrationCollapsed,
  setIntegrationCollapsed,
  dirty,
  saving,
  onSave,
  onDiscard,
  onOpenPlayground,
}: ToolsTabProps) {
  const { t } = useTranslation();
  const shown = voice ? voiceToolCatalog(catalog) : catalog;
  // Every granted tool a precondition can be put on, by the name the model calls it.
  const guardableTools = guardableToolsOf(shown, grants, {
    observing,
    decides,
  });
  const assembledTools = assembledToolNames(shown, grants, {
    observing,
    decides,
  });

  // Section index for the Tools tab: mirrors the section ids set on ToolGrantsEditor's
  // blocks + the capability map below.
  const allSections = [
    {
      id: "tools-http",
      icon: Webhook,
      label: t("editor.tools.http", "HTTP tools"),
    },
    {
      id: "tools-code",
      icon: Code2,
      label: t("editor.tools.code", "Code tools"),
    },
    {
      id: "tools-mcp",
      icon: Plug,
      label: t("editor.tools.mcp", "MCP servers"),
    },
    {
      id: "tools-integrations",
      icon: Puzzle,
      label: t("editor.tools.integrations", "Integrations"),
    },
    // NOTE: the index has to agree with what the editor DRAWS: a watcher has no Documents block
    // (its tools deliver to the customer), and a nav entry with no target scrolls nowhere.
    ...(observing || voice
      ? []
      : [
          {
            id: "tools-documents",
            icon: FileText,
            label: t("editor.tools.documents", "Documents"),
          },
        ]),
    {
      id: "tools-native",
      icon: Wrench,
      label: t("editor.tools.native", "Native tools"),
    },
    {
      id: "tools-preconditions",
      icon: ShieldCheck,
      label: t("editor.tools.preconditions", "Preconditions"),
    },
  ];
  // Questions and rules draw what a rule can run: the native tools with their preconditions, and the
  // tenant's own HTTP, code and MCP tools.
  const RULE_SECTIONS = new Set([
    "tools-http",
    "tools-code",
    "tools-mcp",
    "tools-native",
    "tools-preconditions",
  ]);
  const sections = decides
    ? allSections.filter((sec) => RULE_SECTIONS.has(sec.id))
    : allSections;

  return (
    <div className="flex grow flex-col gap-4">
      <div className="flex gap-6">
        <SectionNav sections={sections} />
        <div className="flex min-w-0 grow flex-col gap-4">
          <ToolGrantsEditor
            agentId={agentId}
            observing={observing}
            voice={voice}
            decides={decides}
            catalog={shown}
            grants={grants}
            onChange={onChange}
            onCatalogChange={onCatalogChange}
            transferWithSummary={transferWithSummary}
            setTransferWithSummary={setTransferWithSummary}
            handoff={handoff}
            setHandoff={setHandoff}
            kanbanInstructions={kanbanInstructions}
            setKanbanInstructions={setKanbanInstructions}
            customAttributeInstructions={customAttributeInstructions}
            crossInboxCase={crossInboxCase}
            setCrossInboxCase={setCrossInboxCase}
            sendImage={sendImage}
            setSendImage={setSendImage}
            resolveConversation={resolveConversation}
            setResolveConversation={setResolveConversation}
            refusals={refusals}
            setCustomAttributeInstructions={setCustomAttributeInstructions}
            labelInstructions={labelInstructions}
            setLabelInstructions={setLabelInstructions}
            protectedLabels={protectedLabels}
            setProtectedLabels={setProtectedLabels}
            allowedLabels={allowedLabels}
            setAllowedLabels={setAllowedLabels}
            outsideAllowedLabels={outsideAllowedLabels}
            setOutsideAllowedLabels={setOutsideAllowedLabels}
            labelRemoval={labelRemoval}
            setLabelRemoval={setLabelRemoval}
            updateKanbanTaskInstructions={updateKanbanTaskInstructions}
            setUpdateKanbanTaskInstructions={setUpdateKanbanTaskInstructions}
            mcpTools={mcpTools}
            setMcpTools={setMcpTools}
            mcpInstructions={mcpInstructions}
            setMcpInstructions={setMcpInstructions}
            mcpCollapsed={mcpCollapsed}
            setMcpCollapsed={setMcpCollapsed}
            integrationCollapsed={integrationCollapsed}
            setIntegrationCollapsed={setIntegrationCollapsed}
          />
          <ToolPreconditionsEditor
            agentId={agentId}
            rows={toolPreconditions}
            onChange={setToolPreconditions}
            guardableTools={guardableTools}
            assembledTools={assembledTools}
            decides={decides}
          />
        </div>
      </div>
      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveLabel={t("editor.saveTools", "Save tools")}
        onOpenPlayground={onOpenPlayground}
      />
    </div>
  );
}
