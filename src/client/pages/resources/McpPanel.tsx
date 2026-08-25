import { Link2, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import {
  type DiscoveredMcpTool,
  McpServerInstructions,
  McpToolArgs,
} from "@/client/components/mcp/DiscoveredMcpTools";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { McpEditModal } from "./McpEditModal";

type McpData = Awaited<
  ReturnType<(typeof api.api.v1)["mcp-connections"]["get"]>
>["data"];
type Connection = NonNullable<McpData>["connections"][number];

const TRANSPORTS = ["streamableHttp", "sse", "stdio"] as const;

export function McpPanel() {
  const { t } = useTranslation();
  const transportLabel = (tr: (typeof TRANSPORTS)[number]) => {
    switch (tr) {
      case "streamableHttp":
        return t("mcp.transportLabel.streamableHttp", "Streamable HTTP");
      case "sse":
        return t("mcp.transportLabel.sse", "SSE");
      default:
        return t("mcp.transportLabel.stdio", "stdio");
    }
  };
  const { showToast } = useToast();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [discovering, setDiscovering] = useState<string | null>(null);

  const editModal = useModalController<{ id?: string }>();
  const toolsModal = useModalController<{ name: string }>();
  const refsModal = useModalController<{ id: string; name: string }>();
  const deleteModal = useModalController<{ id: string; name: string }>();
  const [refs, setRefs] = useState<AgentRef[] | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<AgentRef[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredMcpTool[]>([]);
  const [discoveredInstructions, setDiscoveredInstructions] = useState<
    string | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const mcpRes = await api.api.v1["mcp-connections"].get();
      if (mcpRes.error || !mcpRes.data) {
        setError(true);
        return;
      }
      setConnections(mcpRes.data.connections);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function discover(c: Connection) {
    setDiscovering(c.id);
    try {
      const { data, error: err } = await api.api.v1["mcp-connections"]({
        id: c.id,
      }).discover.post();
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ||
            t("mcp.discoverError", "Could not reach the server."),
          "error",
        );
        return;
      }
      setDiscovered(data.tools);
      setDiscoveredInstructions(data.instructions ?? null);
      toolsModal.open({ name: c.name });
    } catch {
      showToast(t("mcp.discoverError", "Could not reach the server."), "error");
    } finally {
      setDiscovering(null);
    }
  }

  // Reverse refs (which agents granted this MCP server): open the modal first (loading state), then
  // fill it — same async pattern as the vault Usage flow.
  async function loadRefs(id: string): Promise<AgentRef[] | null> {
    const { data } = await api.api.v1["mcp-connections"]({
      id,
    }).references.get();
    return data ? [...data.references.agents] : null;
  }

  async function openRefs(c: Connection) {
    setRefs(null);
    refsModal.open({ id: c.id, name: c.name });
    setRefs(await loadRefs(c.id));
  }

  async function askDelete(c: Connection) {
    setDeleteRefs(null);
    deleteModal.open({ id: c.id, name: c.name });
    setDeleteRefs(await loadRefs(c.id));
  }

  async function confirmDelete() {
    const id = deleteModal.payload?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const { error: err } = await api.api.v1["mcp-connections"]({
        id,
      }).delete();
      if (err) {
        showToast(
          apiErrorMessage(err) || t("mcp.deleteError", "Could not delete."),
          "error",
        );
        return;
      }
      showToast(t("mcp.deleted", "Deleted."), "success");
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
          {t("mcp.subtitle", "External MCP servers your agents can use.")}
        </p>
        <Button size="sm" onClick={() => editModal.open({})}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("mcp.add", "New MCP server")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={connections.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={Plug}
            title={t("mcp.emptyTitle", "No MCP servers yet")}
            description={t(
              "mcp.emptyDesc",
              "Connect a server, discover its tools, then grant a subset per agent.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {connections.map((c) => (
            <Card
              key={c.id}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-text-primary">
                    {c.name}
                  </span>
                  <Badge variant="secondary">
                    {transportLabel(c.transport as (typeof TRANSPORTS)[number])}
                  </Badge>
                  {!c.enabled && (
                    <Badge variant="secondary">
                      {t("common.disabled", "Disabled")}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-text-muted text-xs">
                  {c.url ?? c.command ?? "—"}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={discovering === c.id}
                  onClick={() => discover(c)}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  {t("mcp.discover", "Discover")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openRefs(c)}
                >
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                  {t("resources.usage", "Usage")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => editModal.open({ id: c.id })}
                >
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => askDelete(c)}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>

      <McpEditModal modal={editModal} onSaved={() => load()} />

      <Modal
        modal={toolsModal}
        title={t("mcp.discoveredTitle", "Discovered tools")}
      >
        <div className="flex flex-col gap-3">
          <McpServerInstructions instructions={discoveredInstructions} />
          {discovered.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t("mcp.noTools", "No tools advertised by this server.")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-text-muted text-xs">
                {t("mcp.discoveredCount", "Tools advertised: {{n}}", {
                  n: discovered.length,
                })}
              </p>
              {discovered.map((tool) => (
                <div
                  key={tool.name}
                  className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg-secondary p-3"
                >
                  <span className="font-medium font-mono text-sm text-text-primary">
                    {tool.name}
                  </span>
                  {tool.description && (
                    <p className="text-text-secondary text-xs">
                      {tool.description}
                    </p>
                  )}
                  <McpToolArgs args={tool.args} />
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        modal={refsModal}
        title={t("resources.usageTitle", "Where this is used")}
      >
        <AgentReferences agents={refs} />
      </Modal>

      <Modal
        modal={deleteModal}
        size="sm"
        title={t("mcp.deleteTitle", "Delete MCP server")}
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
            {t("mcp.deleteMessage", 'Delete "{{name}}"?', {
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
