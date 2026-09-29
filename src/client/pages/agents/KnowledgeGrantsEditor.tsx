import { BookOpen, Database, FileText, Pencil, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SelectableCard, SwitchField } from "@/client/components";
import { Tooltip } from "@/client/components/Tooltip";
import { useKnowledgeManager } from "@/client/pages/resources/useKnowledgeManager";
import type { GrantState, ToolCatalog } from "./types";

interface Props {
  catalog: ToolCatalog;
  grants: GrantState[];
  onChange: (grants: GrantState[]) => void;
  // Refetch the agent's tool catalog after creating/editing a base in-place, so a new base appears.
  onCatalogChange: () => void | Promise<void>;
}

// Stable RAG tool identifier (RAG_TOOL_NAMES in src/graph/tools/catalog.ts). The agent's
// `enabledTools` allowlist is filtered server-side by tool name, so the client gates the suggestion
// tool by including/excluding this exact name.
const SUGGEST_TOOL = "suggest_kb_entry";

// Controlled editor for the single RAG grant. Enabling sets the RAG tools +
// selected knowledge bases; disabling drops the grant. Preserves non-RAG grants.
export function KnowledgeGrantsEditor({
  catalog,
  grants,
  onChange,
  onCatalogChange,
}: Props) {
  const { t } = useTranslation();
  const ragGrant = grants.find((g) => g.source === "RAG");
  const nonRag = grants.filter((g) => g.source !== "RAG");
  const enabled = !!ragGrant && (ragGrant.enabledTools?.length ?? 0) > 0;
  const selectedKbs = new Set(ragGrant?.knowledgeBaseIds ?? []);
  const ragToolNames = catalog.rag.map((r) => r.name);
  // The currently-enabled RAG tools, defaulting to all of them when the grant exists but carries no
  // explicit selection (older agents, or the moment retrieval is first switched on).
  const enabledTools = ragGrant?.enabledTools?.length
    ? ragGrant.enabledTools
    : ragToolNames;
  const suggestAvailable = ragToolNames.includes(SUGGEST_TOOL);
  const suggestEnabled = enabledTools.includes(SUGGEST_TOOL);

  // Single writer for the RAG grant so every control preserves the others' state (selecting a base
  // must not silently re-enable the suggestion tool the operator turned off, and vice versa).
  function writeRag(tools: string[], knowledgeBaseIds: string[]) {
    onChange([
      ...nonRag,
      { source: "RAG", enabledTools: tools, knowledgeBaseIds },
    ]);
  }

  function setEnabled(on: boolean) {
    if (!on) {
      onChange(nonRag);
      return;
    }
    // Default a freshly-enabled grant to all RAG tools (current behavior: search + suggest on).
    writeRag(ragToolNames, ragGrant?.knowledgeBaseIds ?? []);
  }

  function setSuggest(on: boolean) {
    const tools = on
      ? [...new Set([...enabledTools, SUGGEST_TOOL])]
      : enabledTools.filter((n) => n !== SUGGEST_TOOL);
    writeRag(tools, ragGrant?.knowledgeBaseIds ?? []);
  }

  function selectKb(id: string) {
    const next = new Set(selectedKbs);
    next.add(id);
    writeRag(enabledTools, [...next]);
  }

  function toggleKb(id: string) {
    const next = new Set(selectedKbs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeRag(enabledTools, [...next]);
  }

  // Create/edit a base + manage its documents without leaving the agent editor. A newly-created base
  // is auto-selected (and turns retrieval on if it was off).
  const km = useKnowledgeManager({
    onChanged: onCatalogChange,
    onCreated: (base) => selectKb(base.id),
    allowDocumentEdits: true,
  });

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4">
        <SwitchField
          checked={enabled}
          onCheckedChange={setEnabled}
          label={t("editor.knowledge.enable", "Enable knowledge retrieval")}
        />
        <p className="text-text-muted text-xs">
          {t(
            "editor.knowledge.desc",
            "The agent can search the selected knowledge bases to ground its answers.",
          )}
        </p>
      </section>

      {enabled && (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-bg-secondary p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-medium text-sm text-text-primary">
              <BookOpen className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("editor.knowledge.bases", "Knowledge bases")}
            </h3>
            <button
              type="button"
              onClick={() => km.openCreate()}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-accent text-xs hover:underline"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t("editor.knowledge.createNew", "New")}
            </button>
          </div>
          {catalog.knowledgeBases.length === 0 ? (
            <p className="text-text-muted text-xs">
              {t(
                "editor.knowledge.noBases",
                "No knowledge bases yet. Create some in Components.",
              )}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {catalog.knowledgeBases.map((kb) => (
                <div key={kb.id} className="relative h-full">
                  <SelectableCard
                    selected={selectedKbs.has(kb.id)}
                    onToggle={() => toggleKb(kb.id)}
                    icon={Database}
                    title={kb.name}
                    description={kb.description ?? undefined}
                    className="h-full"
                  />
                  {/* Align the action cluster's vertical center with the card's selection check
                      (mt-0.5 h-5): top-3.5 + h-5 buttons put both centers at the same y. */}
                  <div className="absolute top-3.5 right-9 flex items-center gap-0.5">
                    <Tooltip content={t("knowledge.documents", "Documents")}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          km.openDocs({ id: kb.id, name: kb.name });
                        }}
                        aria-label={t("knowledge.documents", "Documents")}
                        className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-primary"
                      >
                        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </Tooltip>
                    <Tooltip content={t("common.edit", "Edit")}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void km.openEditById(kb.id);
                        }}
                        aria-label={t("common.edit", "Edit")}
                        className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-primary"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
          {selectedKbs.size === 0 && catalog.knowledgeBases.length > 0 && (
            <p className="text-warning text-xs">
              {t(
                "editor.knowledge.noneSelected",
                "Select at least one base, or retrieval returns nothing.",
              )}
            </p>
          )}
        </section>
      )}

      {enabled && suggestAvailable && (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-bg-secondary p-4">
          <SwitchField
            checked={suggestEnabled}
            onCheckedChange={setSuggest}
            label={t(
              "editor.knowledge.suggestEnable",
              "Let the agent suggest new entries",
            )}
          />
          <p className="text-text-muted text-xs">
            {t(
              "editor.knowledge.suggestDesc",
              "When on, the agent can propose new knowledge-base entries for your approval. Nothing is added without review.",
            )}
          </p>
        </section>
      )}

      {km.modals}
    </div>
  );
}
