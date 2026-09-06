import { Code2, Link2, Trash2, Webhook, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
import { CodeToolEditModal, type CodeToolListed } from "./CodeToolEditModal";
import { type Tool, ToolEditModal } from "./ToolEditModal";

// One kind of tool, in the merged list. Both are the operator's own; the badge and the subtitle are
// what tell them apart at a glance (an HTTP tool by its method and URL, a code tool by the arguments
// it declares).
type ToolKind = "http" | "code";
type MergedTool = {
  kind: ToolKind;
  id: string;
  label: string;
  enabled: boolean;
  subtitle: ReactNode;
};

export function ToolsPanel() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [httpTools, setHttpTools] = useState<Tool[]>([]);
  const [codeTools, setCodeTools] = useState<CodeToolListed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const editModal = useModalController<{ id?: string }>();
  const codeEditModal = useModalController<{ id?: string }>();
  const refsModal = useModalController<{ id: string; name: string }>();
  const deleteModal = useModalController<{
    kind: ToolKind;
    id: string;
    name: string;
  }>();
  const [refs, setRefs] = useState<AgentRef[] | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<AgentRef[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [httpRes, codeRes] = await Promise.all([
        api.api.v1.tools.get(),
        api.api.v1["code-tools"].get(),
      ]);
      if (httpRes.error || !httpRes.data || codeRes.error || !codeRes.data) {
        setError(true);
        return;
      }
      setHttpTools(httpRes.data.tools);
      setCodeTools(codeRes.data.tools);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reverse refs (which agents granted this tool) come from the endpoint of the tool's own kind. The
  // shape is the same either way, so the modal renders one component.
  async function loadRefs(
    kind: ToolKind,
    id: string,
  ): Promise<AgentRef[] | null> {
    const { data } =
      kind === "http"
        ? await api.api.v1.tools({ id }).references.get()
        : await api.api.v1["code-tools"]({ id }).references.get();
    return data ? [...data.references.agents] : null;
  }

  async function openRefs(tool: MergedTool) {
    setRefs(null);
    refsModal.open({ id: tool.id, name: tool.label });
    setRefs(await loadRefs(tool.kind, tool.id));
  }

  function openEdit(tool: MergedTool) {
    if (tool.kind === "http") editModal.open({ id: tool.id });
    else codeEditModal.open({ id: tool.id });
  }

  async function askDelete(tool: MergedTool) {
    setDeleteRefs(null);
    deleteModal.open({ kind: tool.kind, id: tool.id, name: tool.label });
    setDeleteRefs(await loadRefs(tool.kind, tool.id));
  }

  async function confirmDelete() {
    const target = deleteModal.payload;
    if (!target) return;
    setDeleting(true);
    try {
      const { error: err } =
        target.kind === "http"
          ? await api.api.v1.tools({ id: target.id }).delete()
          : await api.api.v1["code-tools"]({ id: target.id }).delete();
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

  // The declared argument names of a code tool, for its row subtitle: the schema keys, or a note
  // when it takes none. The catalog stores the compact field map, so the keys ARE the argument
  // names the agent fills in.
  function codeSubtitle(tool: CodeToolListed): ReactNode {
    const names = Object.keys(
      (tool.inputSchema ?? {}) as Record<string, unknown>,
    );
    return names.length > 0
      ? names.join(", ")
      : t("codeTools.noArguments", "No arguments");
  }

  const merged: MergedTool[] = [
    ...httpTools.map(
      (tool): MergedTool => ({
        kind: "http",
        id: tool.id,
        label: tool.label,
        enabled: tool.enabled,
        subtitle: (
          <>
            <span className="font-medium">{tool.method}</span>{" "}
            {tool.urlTemplate}
          </>
        ),
      }),
    ),
    ...codeTools.map(
      (tool): MergedTool => ({
        kind: "code",
        id: tool.id,
        label: tool.label,
        enabled: tool.enabled,
        subtitle: codeSubtitle(tool),
      }),
    ),
  ].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-4">
      {/* Every sibling panel has ONE short button here and survives `justify-between` on a phone.
          This one has two, both long, and `shrink-0` on the pair, so the sentence beside them was
          crushed to two words a line at 390px. Stacked below `sm`, side by side above it. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-muted">
          {t("tools.subtitle", "HTTP and code tools your agents can call.")}
        </p>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => editModal.open({})}
          >
            <Webhook className="h-4 w-4" aria-hidden="true" />
            {t("tools.addHttp", "New HTTP tool")}
          </Button>
          {/* Peers, so both are secondary. The kind that was NEW when the pair was introduced (#517)
              kept the primary variant, which reads as a recommendation the page has no business
              making: an HTTP tool and a code tool answer different questions, and the page lists
              them in ONE list precisely because neither leads. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => codeEditModal.open({})}
          >
            <Code2 className="h-4 w-4" aria-hidden="true" />
            {t("tools.addCode", "New code tool")}
          </Button>
        </div>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={merged.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={Wrench}
            title={t("tools.emptyTitle", "No tools yet")}
            description={t(
              "tools.emptyDesc",
              "Define a tool once, then grant it to the agents that need it.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {merged.map((tool) => (
            <Card
              key={`${tool.kind}:${tool.id}`}
              // The three actions are ~230px of the 390px a phone has, and the name had the rest
              // with `truncate` on top: at that width "Buscar pedido" rendered as nothing at all,
              // so the row identified the tool by its badge. Stacked below `sm`.
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {tool.label}
                  </span>
                  <Badge variant={tool.kind === "code" ? "info" : "secondary"}>
                    {tool.kind === "code"
                      ? t("tools.kindCode", "Code")
                      : "HTTP"}
                  </Badge>
                  {!tool.enabled && (
                    <Badge variant="secondary">
                      {t("common.disabled", "Disabled")}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-text-muted text-xs">
                  {tool.subtitle}
                </p>
              </div>
              <div className="flex flex-wrap gap-1 sm:shrink-0">
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
                  onClick={() => openEdit(tool)}
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
      <CodeToolEditModal modal={codeEditModal} onSaved={() => load()} />

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
