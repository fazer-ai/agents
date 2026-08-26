import { Plug, Puzzle, ShieldCheck, Webhook, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DiscoveredMcpTool } from "@/client/components/mcp/DiscoveredMcpTools";
import { SectionNav } from "./SectionNav";
import { TabActionBar } from "./TabActionBar";
import { ToolGrantsEditor } from "./ToolGrantsEditor";
import { ToolPreconditionsEditor } from "./ToolPreconditionsEditor";
import type {
  GrantState,
  HandoffUiState,
  ToolCatalog,
  ToolPreconditionRow,
} from "./types";

interface ToolsTabProps {
  agentId: string;
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
  setCustomAttributeInstructions: (v: string) => void;
  labelInstructions: string;
  setLabelInstructions: (v: string) => void;
  updateKanbanTaskInstructions: string;
  setUpdateKanbanTaskInstructions: (v: string) => void;
  // Per-tool preconditions (issue #101). Owned by AgentEditorPage like the guidance above, and saved
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
  onOpenPlayground: () => void;
}

export function ToolsTab({
  agentId,
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
  setCustomAttributeInstructions,
  labelInstructions,
  setLabelInstructions,
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
  // The native tools this agent actually has, resolved with the SAME rule ToolGrantsEditor uses: no
  // explicit NATIVE row means all of them (the permissive default), an explicit row means exactly
  // its allowlist. Offering a name the agent was not granted would let an operator write a rule that
  // is inert, which reads as protection and is not.
  const nativeGrant = grants.find((g) => g.source === "NATIVE");
  const grantedNativeTools = nativeGrant
    ? (nativeGrant.enabledTools ?? [])
    : catalog.native.map((n) => n.name);

  // Section index for the Tools tab (item 9): mirrors the section ids set on ToolGrantsEditor's
  // blocks + the capability map below.
  const sections = [
    {
      id: "tools-http",
      icon: Webhook,
      label: t("editor.tools.http", "HTTP tools"),
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

  return (
    <div className="flex grow flex-col gap-4">
      <div className="flex gap-6">
        <SectionNav sections={sections} />
        <div className="flex min-w-0 grow flex-col gap-4">
          <ToolGrantsEditor
            agentId={agentId}
            catalog={catalog}
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
            setCustomAttributeInstructions={setCustomAttributeInstructions}
            labelInstructions={labelInstructions}
            setLabelInstructions={setLabelInstructions}
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
            rows={toolPreconditions}
            onChange={setToolPreconditions}
            grantedNativeTools={grantedNativeTools}
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
