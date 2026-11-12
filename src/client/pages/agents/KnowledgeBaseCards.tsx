import { Database, FileText, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SelectableCard } from "@/client/components";
import { Tooltip } from "@/client/components/Tooltip";
import {
  type KnowledgeManager,
  useKnowledgeManager,
} from "@/client/pages/resources/useKnowledgeManager";
import type { ToolCatalog } from "./types";

interface Props {
  bases: ToolCatalog["knowledgeBases"];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  // Opens a base's documents and its edit form from the card.
  manager: KnowledgeManager;
}

// The agent editor's way of picking knowledge bases: one selectable card per base, with its documents
// and its edit form a click away. The Knowledge tab picks what the agent searches with it, and the
// factual-grounding section of Guardrails picks what the reviewer always reads.
export function KnowledgeBaseCards({
  bases,
  selected,
  onToggle,
  manager: km,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {bases.map((kb) => (
        <div key={kb.id} className="relative h-full">
          <SelectableCard
            selected={selected.has(kb.id)}
            onToggle={() => onToggle(kb.id)}
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
                className="text-text-muted hover:text-text-primary flex h-5 w-5 items-center justify-center rounded"
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
                className="text-text-muted hover:text-text-primary flex h-5 w-5 items-center justify-center rounded"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        </div>
      ))}
    </div>
  );
}

// The same cards with a knowledge manager of their own, for a tab that does not already hold one.
export function ManagedKnowledgeBaseCards({
  onChanged,
  ...cards
}: Omit<Props, "manager"> & { onChanged: () => void | Promise<void> }) {
  const km = useKnowledgeManager({ onChanged, allowDocumentEdits: true });
  return (
    <>
      <KnowledgeBaseCards {...cards} manager={km} />
      {km.modals}
    </>
  );
}
