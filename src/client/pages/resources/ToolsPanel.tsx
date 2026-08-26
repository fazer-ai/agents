import { Link2, Plus, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentRef,
  AgentReferences,
  Badge,
  Button,
  Card,
  DataBoundary,
  EmptyState,
  Modal,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { NATIVE_TOOL_CATEGORY, NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { type Tool, ToolEditModal } from "./ToolEditModal";

export function ToolsPanel() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const editModal = useModalController<{ id?: string }>();
  const refsModal = useModalController<{ id: string; name: string }>();
  const deleteModal = useModalController<{ id: string; name: string }>();
  const [refs, setRefs] = useState<AgentRef[] | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<AgentRef[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const toolsRes = await api.api.v1.tools.get();
      if (toolsRes.error || !toolsRes.data) {
        setError(true);
        return;
      }
      setTools(toolsRes.data.tools);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reverse refs (which agents granted this tool): same async pattern as the vault Usage flow — open
  // the modal first (loading state), then fill it.
  async function loadRefs(id: string): Promise<AgentRef[] | null> {
    const { data } = await api.api.v1.tools({ id }).references.get();
    return data ? [...data.references.agents] : null;
  }

  async function openRefs(tool: Tool) {
    setRefs(null);
    refsModal.open({ id: tool.id, name: tool.label });
    setRefs(await loadRefs(tool.id));
  }

  async function askDelete(tool: Tool) {
    setDeleteRefs(null);
    deleteModal.open({ id: tool.id, name: tool.label });
    setDeleteRefs(await loadRefs(tool.id));
  }

  async function confirmDelete() {
    const id = deleteModal.payload?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const { error: err } = await api.api.v1.tools({ id }).delete();
      if (err) {
        showToast(
          apiErrorMessage(err) || t("tools.deleteError", "Could not delete."),
          "error",
        );
        return;
      }
      showToast(t("tools.deleted", "Tool deleted."), "success");
      deleteModal.close();
      load();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t("tools.subtitle", "HTTP tools your agents can call.")}
        </p>
        <Button size="sm" onClick={() => editModal.open({})}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("tools.add", "New tool")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={tools.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={Wrench}
            title={t("tools.emptyTitle", "No HTTP tools yet")}
            description={t(
              "tools.emptyDesc",
              "Define a tool once, then grant it to the agents that need it.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {tools.map((tool) => (
            <Card
              key={tool.id}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {tool.label}
                  </span>
                  {!tool.enabled && (
                    <Badge variant="secondary">
                      {t("common.disabled", "Disabled")}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-text-muted text-xs">
                  <span className="font-medium">{tool.method}</span>{" "}
                  {tool.urlTemplate}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openRefs(tool)}
                >
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                  {t("resources.usage", "Usage")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => editModal.open({ id: tool.id })}
                >
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => askDelete(tool)}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>

      {/* Native tools come AFTER the custom HTTP tools (item 13): they are built-in and read-only
          here, so the operator's own tools lead. */}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4">
        <div>
          <h3 className="font-medium text-sm text-text-primary">
            {t("tools.nativeTitle", "Native tools")}
          </h3>
          <p className="mt-0.5 text-text-muted text-xs">
            {t(
              "tools.nativeSubtitle",
              "Built-in actions every agent can be granted. Pick them per agent in the agent editor's Tools tab.",
            )}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {NATIVE_TOOL_NAMES.map((name) => {
            const meta = nativeToolMeta(name, t);
            const Icon = meta.icon;
            return (
              <div
                key={name}
                className="flex items-start gap-3 rounded-lg border border-border bg-bg-tertiary p-3"
              >
                <Icon
                  className="mt-0.5 h-5 w-5 shrink-0 text-text-muted"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm text-text-primary">
                      {meta.label}
                    </span>
                    <Badge variant="secondary">
                      {NATIVE_TOOL_CATEGORY[name] === "utility"
                        ? t("tools.category.utility", "Utility")
                        : t("tools.category.conversation", "Conversation")}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-text-muted text-xs">
                    {meta.description}
                  </p>
                  <p className="mt-0.5 font-mono text-[0.6875rem] text-text-muted">
                    {name}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <ToolEditModal modal={editModal} onSaved={() => load()} />

      <Modal
        modal={refsModal}
        title={t("resources.usageTitle", "Where this is used")}
      >
        <AgentReferences agents={refs} />
      </Modal>

      <Modal
        modal={deleteModal}
        size="sm"
        title={t("tools.deleteTitle", "Delete tool")}
        onCloseRequest={deleting ? () => undefined : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => deleteModal.close()}
              disabled={deleting}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleting}>
              {t("common.delete", "Delete")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {t("tools.deleteMessage", 'Delete "{{name}}"?', {
              name: deleteModal.payload?.name ?? "",
            })}
          </p>
          {deleteRefs && deleteRefs.length > 0 && (
            <p className="text-sm text-warning">
              {t(
                "resources.deleteRefsWarning",
                "{{count}} agent uses this and will stop working if you delete it.",
                { count: deleteRefs.length },
              )}
            </p>
          )}
          <AgentReferences agents={deleteRefs} />
        </div>
      </Modal>
    </div>
  );
}
