import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Plus,
  RadioTower,
  Search,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  EmptyState,
  FilterPills,
  FormField,
  Input,
  Modal,
  OutOfHoursBadge,
  PageContainer,
  TestModeBadge,
  Tooltip,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { providerLabel } from "@/client/lib/providerLabels";
import { formatDateTime, formatRelativeTime } from "@/client/lib/utils";

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type Agent = NonNullable<AgentsData>["agents"][number];

type SortField = "updatedAt" | "createdAt" | "name";
type StatusFilter = "all" | "active" | "inactive";

const PAGE_SIZE = 20;

export function AgentsPage() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const createModal = useModalController();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<SortField>("updatedAt");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  function modelLabel(modelConfig: Record<string, unknown>): string {
    const provider =
      typeof modelConfig.provider === "string" ? modelConfig.provider : null;
    const model =
      typeof modelConfig.model === "string" ? modelConfig.model : null;
    if (!provider || !model) return "";
    return `${providerLabel(provider, t)} · ${model}`;
  }

  // Debounce the search box so each keystroke doesn't fire a request.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // A new query, sort or status filter resets to the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset page on query/sort/status change only.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, sort, status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.agents.get({
        query: {
          q: debouncedSearch || undefined,
          orderBy: sort,
          order: sort === "name" ? "asc" : "desc",
          enabled: status === "all" ? undefined : status === "active",
          page,
          pageSize: PAGE_SIZE,
        },
      });
      if (err || !data) {
        setError(true);
        return;
      }
      setAgents(data.agents);
      setTotal(data.total);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, sort, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const searching = debouncedSearch.trim() !== "";
  // Keep the toolbar visible when a status filter is active even if it returns nothing, so the
  // operator can switch back (otherwise an empty "Inactive" result would hide the controls).
  const showToolbar = total > 0 || searching || status !== "all";

  function openCreate() {
    setName("");
    createModal.open();
  }

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setImporting(true);
    try {
      const parsed = JSON.parse(await file.text());
      const { data, error: err } = await api.api.v1.agents.import.post({
        export: parsed,
      });
      if (err || !data) throw err ?? new Error("no data");
      showToast(
        data.warnings.length
          ? t(
              "agents.importedWithWarnings",
              "Imported with {{n}} warning(s).",
              {
                n: data.warnings.length,
              },
            )
          : t("agents.imported", "Agent imported (disabled)."),
        data.warnings.length ? "warning" : "success",
      );
      // Carry the warning STRINGS to the editor so it can surface exactly what was skipped/unset
      // (deep-linkable), instead of only a count (item 1). Navigate straight to the /general tab route
      // (NOT the bare /agents/:id, whose index `<Navigate to="general">` redirect would drop the
      // location.state and hide the import-warnings panel).
      navigate(`/agents/${data.agent.id}/general`, {
        state: data.warnings.length
          ? { importWarnings: data.warnings }
          : undefined,
      });
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("agents.importError", "Could not import (invalid file?)."),
        "error",
      );
    } finally {
      setImporting(false);
    }
  }

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const { data, error: err } = await api.api.v1.agents.post({
        name: name.trim(),
      });
      if (err || !data) throw err ?? new Error("no data");
      createModal.close();
      navigate(`/agents/${data.agent.id}`);
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("agents.createError", "Could not create the agent."),
        "error",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-semibold text-text-primary text-xl">
              {t("agents.title", "Agents")}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "agents.subtitle",
                "Build and configure each AI agent: prompt, model, tools and behavior.",
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onImportFile}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={importing}
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            {t("agents.import", "Import")}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("agents.new", "New agent")}
          </Button>
        </div>
      </header>

      {showToolbar && (
        <div className="flex flex-col gap-3">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("agents.search", "Search by name…")}
              aria-label={t("agents.search", "Search by name…")}
              className="w-full rounded-lg border border-border bg-bg-tertiary py-2 pr-4 pl-9 text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <FilterPills
              aria-label={t("agents.statusLabel", "Status")}
              value={status}
              onChange={(k) => setStatus(k as StatusFilter)}
              items={[
                { key: "all", label: t("agents.statusAll", "All") },
                { key: "active", label: t("agents.statusActive", "Active") },
                {
                  key: "inactive",
                  label: t("agents.statusInactive", "Inactive"),
                },
              ]}
            />
            <FilterPills
              aria-label={t("agents.sortLabel", "Sort by")}
              value={sort}
              onChange={(k) => setSort(k as SortField)}
              items={[
                {
                  key: "updatedAt",
                  label: t("agents.sortUpdated", "Last modified"),
                },
                { key: "createdAt", label: t("agents.sortCreated", "Newest") },
                { key: "name", label: t("agents.sortName", "Name") },
              ]}
            />
          </div>
        </div>
      )}

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={total === 0 && !searching && status === "all"}
        onRetry={load}
        loadingLabel={t("agents.loading", "Loading agents…")}
        errorLabel={t("agents.error", "Could not load agents.")}
        empty={
          <EmptyState
            icon={Bot}
            title={t("agents.emptyTitle", "No agents yet")}
            description={t(
              "agents.emptyDesc",
              "Create your first agent and give it a prompt, a model and tools.",
            )}
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("agents.new", "New agent")}
              </Button>
            }
          />
        }
      >
        {agents.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t("agents.noResultsTitle", "No matches")}
            description={t(
              "agents.noResults",
              "No agents match the current search or filters.",
            )}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {agents.map((a, i) => {
              const label = modelLabel(a.modelConfig);
              return (
                <Link key={a.id} to={`/agents/${a.id}`} className="block">
                  <Card className="flex items-center justify-between gap-4 transition-colors hover:bg-bg-hover">
                    <span className="w-6 shrink-0 text-right text-text-muted text-xs tabular-nums">
                      {(page - 1) * PAGE_SIZE + i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-text-primary">
                          {a.name}
                        </span>
                        <Badge variant={a.enabled ? "success" : "secondary"}>
                          {a.enabled
                            ? t("agents.on", "Enabled")
                            : t("agents.off", "Disabled")}
                        </Badge>
                        {a.mode === "test" && <TestModeBadge state="agent" />}
                        {a.outOfHours && <OutOfHoursBadge />}
                      </div>
                      <p className="mt-0.5 truncate text-text-muted text-xs">
                        {label || t("agents.noModel", "No model configured")}
                      </p>
                      {a.inboxes.length > 0 && (
                        <p className="mt-0.5 flex items-center gap-1 truncate text-text-muted text-xs">
                          <RadioTower
                            className="h-3 w-3 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {a.inboxes.map((ib) => ib.name).join(", ")}
                          </span>
                        </p>
                      )}
                      <p className="mt-0.5 truncate text-text-muted text-xs">
                        {t("agents.createdRelative", "Created {{when}}", {
                          when: formatRelativeTime(a.createdAt, i18n.language),
                        })}
                        {" · "}
                        <Tooltip
                          content={formatDateTime(a.updatedAt, i18n.language)}
                        >
                          <span>
                            {t("agents.modifiedRelative", "modified {{when}}", {
                              when: formatRelativeTime(
                                a.updatedAt,
                                i18n.language,
                              ),
                            })}
                          </span>
                        </Tooltip>
                      </p>
                    </div>
                    <ChevronRight
                      className="h-5 w-5 shrink-0 text-text-muted"
                      aria-hidden="true"
                    />
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

        {pageCount > 1 && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-text-muted text-xs">
              {t("agents.resultsCount", "{{total}} agents", { total })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                {t("common.previous", "Previous")}
              </Button>
              <span className="text-text-muted text-xs tabular-nums">
                {t("agents.pageOf", "Page {{page}} of {{pages}}", {
                  page,
                  pages: pageCount,
                })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                {t("common.next", "Next")}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </DataBoundary>

      <Modal
        modal={createModal}
        title={t("agents.createTitle", "New agent")}
        unsavedChanges={name.trim() !== ""}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => createModal.close()}
              disabled={creating}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={create} loading={creating} disabled={!name.trim()}>
              {t("common.create", "Create")}
            </Button>
          </div>
        }
      >
        <FormField
          label={t("agents.name", "Name")}
          required
          description={t(
            "agents.createHint",
            "You'll configure the prompt, model and tools next.",
          )}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </FormField>
      </Modal>
    </PageContainer>
  );
}
