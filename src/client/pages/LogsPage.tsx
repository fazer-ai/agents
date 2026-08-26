import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  MessageSquare,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageContainer,
  Skeleton,
  useModalController,
} from "@/client/components";
import { Tooltip } from "@/client/components/Tooltip";
import { api } from "@/client/lib/api";
import { flowLevelLabel, flowStageLabel } from "@/client/lib/flowLabels";
import { type LogGroupTitle, logGroupTitle } from "@/client/lib/logGroupTitle";
import { cn, formatDateTime } from "@/client/lib/utils";
import { FLOW_LEVELS, FLOW_STAGES } from "@/modules/flowlog/stages";
import { LogsExportModal } from "./LogsExportModal";

// Execution-flow log viewer (TENANT_ADMIN). Rows are grouped by turn into collapsible cards;
// filters (stage / level / source / search) live in the URL; keyset pagination walks a cursor
// stack (Prev/Next). Loading uses an inline skeleton (admin-style pages don't use DataBoundary).

type LogsResponse = Awaited<ReturnType<typeof api.api.v1.logs.get>>["data"];
type LogItem = NonNullable<LogsResponse>["items"][number];

const SEARCH_DEBOUNCE_MS = 300;
// Shared by the search <input> and the filter <select>s. A fixed height keeps them aligned: native
// <input> and <select> render at slightly different heights from identical padding alone.
const selectCls =
  "h-9 rounded-lg border border-border bg-bg-tertiary px-3 text-sm text-text-primary focus:border-border-focus focus:outline-none";
const LOG_SKELETON_KEYS = ["lg-0", "lg-1", "lg-2", "lg-3", "lg-4"];

const LEVEL_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };

const LEVEL_PILL: Record<string, string> = {
  error: "bg-error-soft text-error",
  warn: "bg-warning-soft text-warning",
  info: "bg-bg-tertiary text-text-muted",
};

function LevelPill({ level }: { level: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-medium text-xs",
        LEVEL_PILL[level] ?? LEVEL_PILL.info,
      )}
    >
      {flowLevelLabel(level, t)}
    </span>
  );
}

interface TurnGroup {
  turnId: string;
  rows: LogItem[];
  worstLevel: string;
  newestAt: string;
  conversationId: string | null;
  threadId: string | null;
}

function groupByTurn(items: LogItem[]): TurnGroup[] {
  const order: string[] = [];
  const map = new Map<string, LogItem[]>();
  for (const it of items) {
    const arr = map.get(it.turnId);
    if (arr) arr.push(it);
    else {
      map.set(it.turnId, [it]);
      order.push(it.turnId);
    }
  }
  return order.map((turnId) => {
    const rows = map.get(turnId) as LogItem[];
    let worst = "info";
    for (const r of rows) {
      if ((LEVEL_RANK[r.level] ?? 0) > (LEVEL_RANK[worst] ?? 0))
        worst = r.level;
    }
    return {
      turnId,
      rows,
      worstLevel: worst,
      newestAt: rows[0]?.createdAt ?? "",
      conversationId:
        rows.find((r) => r.conversationId)?.conversationId ?? null,
      threadId: rows.find((r) => r.threadId)?.threadId ?? null,
    };
  });
}

function StageRow({ row }: { row: LogItem }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetail =
    row.errorMessage ||
    (row.detail && Object.keys(row.detail as object).length > 0);
  const meta = [
    row.provider,
    row.model,
    row.durationMs != null ? `${row.durationMs}ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {hasDetail ? (
        expanded ? (
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-text-muted"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="h-3.5 w-3.5 shrink-0 text-text-muted"
            aria-hidden="true"
          />
        )
      ) : (
        // Spacer so rows without a detail toggle stay aligned with the ones that have it.
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <Badge variant="secondary">{flowStageLabel(row.stage, t)}</Badge>
      {row.level !== "info" && <LevelPill level={row.level} />}
      {row.status && (
        <span className="text-text-muted text-xs">{row.status}</span>
      )}
      {meta && <span className="text-text-muted text-xs">{meta}</span>}
      <span className="ml-auto text-text-muted text-xs tabular-nums">
        {formatDateTime(row.createdAt, i18n.language)}
      </span>
    </div>
  );
  if (!hasDetail) return <div className="px-3 py-2">{body}</div>;
  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full select-none text-left"
      >
        {body}
      </button>
      {expanded && (
        <div className="mt-2 flex flex-col gap-2">
          {row.errorMessage && (
            <p className="rounded-md border border-error/40 bg-error-soft px-2 py-1 text-error text-xs">
              {row.errorMessage}
            </p>
          )}
          {(() => {
            const detail = row.detail as Record<string, unknown> | null;
            if (!detail || Object.keys(detail).length === 0) return null;
            // The resolved system prompt (item 15) reads as a wall of escaped JSON in the generic
            // dump, so surface it as readable text; the remaining keys keep the JSON view.
            const sysPrompt =
              typeof detail.systemPrompt === "string"
                ? detail.systemPrompt
                : null;
            const rest = Object.fromEntries(
              Object.entries(detail).filter(([k]) => k !== "systemPrompt"),
            );
            return (
              <>
                {sysPrompt && (
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-[10px] text-text-muted uppercase tracking-wider">
                      {t("logs.systemPrompt", "System prompt")}
                    </span>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-bg-tertiary px-2 py-1 text-text-secondary text-xs">
                      {sysPrompt}
                    </pre>
                  </div>
                )}
                {Object.keys(rest).length > 0 && (
                  <pre className="overflow-auto rounded-md bg-bg-tertiary px-2 py-1 text-text-secondary text-xs">
                    {JSON.stringify(rest, null, 2)}
                  </pre>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// The group's name, rendered. `logGroupTitle` decides WHICH of the four it is (issue #357); this
// only turns that answer into text, so a stage that has no `case` in `flowStageLabel` degrades to
// its slug here exactly as it does on every row.
function groupTitleText(title: LogGroupTitle, t: TFunction): string {
  switch (title.kind) {
    case "conversation":
      return t("logs.conversation", "Conversation #{{id}}", {
        id: title.conversationId,
      });
    case "thread":
      return title.threadId;
    case "stage":
      return flowStageLabel(title.stage, t);
    case "turn":
      return t("logs.turn", "Turn");
  }
}

// One turn group: a controlled disclosure (chevron inline, no native triangle) plus per-group
// actions when the turn is tied to a conversation — filter the log list to it (C2) or jump to the
// conversation (C3). Error groups start expanded.
function TurnGroupCard({
  group,
  onFilterConversation,
}: {
  group: TurnGroup;
  onFilterConversation: (conversationId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(group.worstLevel === "error");
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 select-none items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          )}
          <LevelPill level={group.worstLevel} />
          <span className="truncate text-sm text-text-secondary">
            {groupTitleText(logGroupTitle(group), t)}
          </span>
          <span className="text-text-muted text-xs">
            {t("logs.steps", "{{n}} steps", { n: group.rows.length })}
          </span>
          <span className="ml-auto whitespace-nowrap text-text-muted text-xs tabular-nums">
            {formatDateTime(group.newestAt, i18n.language)}
          </span>
        </button>
        {group.conversationId && (
          <div className="flex items-center gap-1">
            <Tooltip
              content={t(
                "logs.filterConversation",
                "Filter logs from this conversation",
              )}
            >
              <button
                type="button"
                onClick={() =>
                  group.conversationId &&
                  onFilterConversation(group.conversationId)
                }
                aria-label={t(
                  "logs.filterConversation",
                  "Filter logs from this conversation",
                )}
                className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
              >
                <Filter className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip content={t("logs.openConversation", "Open conversation")}>
              <Link
                to={`/conversations/${group.conversationId}`}
                aria-label={t("logs.openConversation", "Open conversation")}
                className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
              >
                <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Tooltip>
          </div>
        )}
      </div>
      {expanded && (
        <div className="divide-y divide-border border-border border-t">
          {group.rows.map((r) => (
            <StageRow key={r.id} row={r} />
          ))}
        </div>
      )}
    </Card>
  );
}

export function LogsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const stage = searchParams.get("stage") ?? "";
  const level = searchParams.get("level") ?? "";
  const source = searchParams.get("source") ?? "inbox";
  const q = searchParams.get("q") ?? "";
  // Deep-link filters (set by "view this conversation's logs"): scope to one conversation or turn.
  const conversationId = searchParams.get("conversationId") ?? "";
  const turnId = searchParams.get("turnId") ?? "";

  const exportModal = useModalController();

  const [searchInput, setSearchInput] = useState(q);
  const [items, setItems] = useState<LogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Cursor stack: each entry is the start cursor of a page (null = first page). The last entry is
  // the current page.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Debounce the search box into the `q` URL param (resets pagination via the filter effect).
  useEffect(() => {
    const id = setTimeout(() => {
      if (searchInput === q) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (searchInput) next.set("q", searchInput);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput, q, setSearchParams]);

  // Reset to the first page whenever a filter changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change only
  useEffect(() => {
    setCursorStack([null]);
  }, [stage, level, source, q, conversationId, turnId]);

  const setFilter = (key: string, value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const query: Record<string, string> = { source };
      if (stage) query.stage = stage;
      if (level) query.level = level;
      if (q) query.search = q;
      if (conversationId) query.conversationId = conversationId;
      if (turnId) query.turnId = turnId;
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await api.api.v1.logs.get({ query });
      if (err || !data) {
        setError(true);
        return;
      }
      setItems(data.items);
      setNextCursor(data.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [stage, level, source, q, conversationId, turnId, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupByTurn(items), [items]);
  // The chip that says what the page is scoped to, when the scope is a `turnId`. It names the group
  // exactly as the group's own card names it (`logGroupTitle`, issue #357) and adds the id, which is
  // the thing the chip exists to point at — before issue #374 it said "Turn <id>" whatever the rows
  // were, so one screen carried two different answers about one group.
  //
  // Matched by id rather than taken as the first group: the rows in state still belong to the
  // PREVIOUS filter for the render between a URL change and its response landing, and naming this id
  // with that group's answer is the same class of lie in a shorter window. No match is the id alone.
  const scopedTurnLabel = useMemo(() => {
    const scoped = groups.find((g) => g.turnId === turnId);
    if (!scoped) return turnId;
    return `${groupTitleText(logGroupTitle(scoped), t)} · ${turnId}`;
  }, [groups, t, turnId]);
  const pageIdx = cursorStack.length - 1;

  // The active filters, keyed to the export endpoint's query params (the server bounds + serializes).
  const exportFilters = useMemo(() => {
    const f: Record<string, string> = { source };
    if (stage) f.stage = stage;
    if (level) f.level = level;
    if (q) f.search = q;
    if (conversationId) f.conversationId = conversationId;
    if (turnId) f.turnId = turnId;
    return f;
  }, [source, stage, level, q, conversationId, turnId]);

  return (
    <PageContainer size="wide" className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <ScrollText className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-bold text-2xl text-text-primary">
              {t("logs.title", "Logs")}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                "logs.subtitle",
                "Per-step execution flow for each agent turn: transcription, generation, audio, delivery and handoffs.",
              )}
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => exportModal.open()}
          disabled={loading || items.length === 0}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("logs.export", "Export")}
        </Button>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("logs.searchPlaceholder", "Search error messages…")}
            aria-label={t("logs.search", "Search")}
            className={cn(selectCls, "w-full pl-9")}
          />
        </div>
        <select
          className={selectCls}
          value={stage}
          onChange={(e) => setFilter("stage", e.target.value)}
          aria-label={t("logs.filterStage", "Stage")}
        >
          <option value="">{t("logs.allStages", "All stages")}</option>
          {FLOW_STAGES.map((s) => (
            <option key={s} value={s}>
              {flowStageLabel(s, t)}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={level}
          onChange={(e) => setFilter("level", e.target.value)}
          aria-label={t("logs.filterLevel", "Level")}
        >
          <option value="">{t("logs.allLevels", "All levels")}</option>
          {FLOW_LEVELS.map((l) => (
            <option key={l} value={l}>
              {flowLevelLabel(l, t)}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={source}
          onChange={(e) => setFilter("source", e.target.value)}
          aria-label={t("logs.filterSource", "Source")}
        >
          <option value="inbox">{t("logs.source.inbox", "Real")}</option>
          <option value="playground">
            {t("logs.source.playground", "Playground")}
          </option>
          <option value="all">{t("logs.source.all", "All")}</option>
        </select>
      </div>

      {(conversationId || turnId) && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-text-secondary text-xs">
            {conversationId
              ? t("logs.scopedConversation", "Conversation #{{id}}", {
                  id: conversationId,
                })
              : scopedTurnLabel}
            <button
              type="button"
              onClick={() =>
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.delete("conversationId");
                    next.delete("turnId");
                    return next;
                  },
                  { replace: true },
                )
              }
              aria-label={t("logs.clearScope", "Clear filter")}
              className="text-text-muted hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3" role="status">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          {LOG_SKELETON_KEYS.map((k) => (
            <Card key={k} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-72" />
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card>
          <EmptyState
            icon={ScrollText}
            title={t("logs.errorTitle", "Could not load logs")}
            description={t("logs.errorDesc", "Try again in a moment.")}
            action={
              <Button onClick={() => void load()}>
                {t("common.retry", "Retry")}
              </Button>
            }
          />
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={ScrollText}
            title={t("logs.emptyTitle", "No logs yet")}
            description={t(
              "logs.emptyDescription",
              "Execution-flow entries appear here as agents handle conversations.",
            )}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <TurnGroupCard
              key={g.turnId}
              group={g}
              onFilterConversation={(cid) => setFilter("conversationId", cid)}
            />
          ))}
        </div>
      )}

      {/* Keyset pagination */}
      {!loading && !error && (groups.length > 0 || pageIdx > 0) && (
        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            disabled={pageIdx === 0}
            onClick={() => setCursorStack((s) => s.slice(0, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {t("common.previous", "Previous")}
          </Button>
          <span className="text-text-muted text-xs">
            {t("logs.page", "Page {{n}}", { n: pageIdx + 1 })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!nextCursor}
            onClick={() =>
              nextCursor && setCursorStack((s) => [...s, nextCursor])
            }
          >
            {t("common.next", "Next")}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}

      <LogsExportModal modal={exportModal} filters={exportFilters} />
    </PageContainer>
  );
}
