import { BookOpen, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, DataBoundary, EmptyState } from "@/client/components";
import { api } from "@/client/lib/api";
import { KnowledgeApprovals } from "./KnowledgeApprovals";
import { useResourcesContext } from "./ResourcesContext";
import { type Base, useKnowledgeManager } from "./useKnowledgeManager";

export function KnowledgePanel() {
  const { t } = useTranslation();
  const { setApprovalsCount } = useResourcesContext();
  const [bases, setBases] = useState<Base[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.knowledge.bases.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setBases(data.bases);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const km = useKnowledgeManager({
    onChanged: load,
    allowDocumentEdits: true,
  });

  return (
    <div className="flex flex-col gap-4">
      <KnowledgeApprovals onCountChange={setApprovalsCount} />

      <div className="flex items-center justify-between gap-3">
        <p className="text-text-muted text-sm">
          {t(
            "knowledge.subtitle",
            "Knowledge bases your agents can search to answer questions.",
          )}
        </p>
        <Button size="sm" onClick={() => km.openCreate()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("knowledge.add", "New base")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={bases.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={BookOpen}
            title={t("knowledge.emptyTitle", "No knowledge bases yet")}
            description={t(
              "knowledge.emptyDesc",
              "Create one and ingest your FAQs, docs or product info.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {bases.map((b) => (
            <Card
              key={b.id}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <span className="text-text-primary truncate font-medium">
                  {b.name}
                </span>
                <p className="text-text-muted mt-0.5 truncate text-xs">
                  {b.description ? `${b.description} · ` : ""}
                  {b.embeddingModel}
                  {` · `}
                  {b.documentCount === 1
                    ? t("knowledge.docCountSingular", "1 document")
                    : t("knowledge.docCountPlural", "{{count}} documents", {
                        count: b.documentCount,
                      })}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => km.openDocs(b)}
                >
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  {t("knowledge.documents", "Documents")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => km.openEdit(b)}
                  aria-label={t("common.edit", "Edit")}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => km.askDelete(b)}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>

      {km.modals}
    </div>
  );
}
