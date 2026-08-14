import {
  AlertTriangle,
  Bot,
  ChevronRight,
  MessagesSquare,
  Search,
  User,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  type FilterPillItem,
  FilterPills,
  OutOfHoursBadge,
  PageContainer,
  Skeleton,
} from "@/client/components";
import { useTenantEvents } from "@/client/hooks/useTenantEvents";
import { api } from "@/client/lib/api";

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type ConversationsData = Awaited<
  ReturnType<typeof api.api.v1.conversations.get>
>["data"];
type Conversation = NonNullable<ConversationsData>["conversations"][number];

type BadgeVariant = "primary" | "secondary" | "success" | "warning" | "info";

// t('conversations.status.open', 'Open')
// t('conversations.status.pending', 'Pending')
// t('conversations.status.resolved', 'Resolved')
// t('conversations.status.snoozed', 'Snoozed')
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  open: "info",
  pending: "warning",
  resolved: "success",
  snoozed: "secondary",
};

function ConversationRow({ c, active }: { c: Conversation; active: boolean }) {
  const { t, i18n } = useTranslation();
  const isHuman = c.assigneeType === "User";
  const when = c.lastEventAt
    ? new Date(c.lastEventAt).toLocaleString(i18n.language)
    : null;
  return (
    <li>
      <Link
        to={`/conversations/${c.id}`}
        className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-hover"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-text-primary">
              {c.contact?.name ??
                t("conversations.unknownContact", "Unknown contact")}
            </span>
            <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>
              {/* biome-ignore lint/plugin/no-dynamic-i18n-key: status keys extracted via magic comments above STATUS_VARIANT */}
              {t(`conversations.status.${c.status}`, c.status)}
            </Badge>
            {c.lastError && (
              <Badge variant="error" className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {t("conversations.errorBadge", "Error")}
              </Badge>
            )}
            {c.outOfHours && <OutOfHoursBadge />}
          </div>
          <p className="mt-0.5 truncate text-text-muted text-xs">
            {c.inbox?.name ?? t("conversations.noInbox", "No inbox")}
            {when ? ` · ${when}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-text-secondary text-xs">
          {active && (
            <span
              className="flex items-center gap-1 text-accent"
              aria-live="polite"
            >
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                aria-hidden="true"
              />
              {t("conversations.working", "Working…")}
            </span>
          )}
          {isHuman ? (
            <>
              <User className="h-3.5 w-3.5" aria-hidden="true" />
              {c.assigneeName ??
                t("conversations.assignee.human", "Human #{{id}}", {
                  id: c.assigneeId ?? "?",
                })}
            </>
          ) : (
            <>
              <Bot className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              {c.agentName ?? t("conversations.assignee.ai", "AI")}
            </>
          )}
          <ChevronRight
            className="h-4 w-4 text-text-muted"
            aria-hidden="true"
          />
        </div>
      </Link>
    </li>
  );
}

// NOTE: Static keys so the skeleton rows don't key off the array index.
const CONV_SKELETON_KEYS = [
  "conv-0",
  "conv-1",
  "conv-2",
  "conv-3",
  "conv-4",
  "conv-5",
];

// Bespoke loading placeholder mirroring the conversation list rows
// (title + status badge, contact sub-line, the working dot + timestamp + chevron).
function ConversationsSkeleton() {
  return (
    <Card className="p-1.5">
      <ul aria-hidden="true" className="flex flex-col gap-0.5">
        {CONV_SKELETON_KEYS.map((key) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-16" />
              </div>
              <Skeleton className="mt-0.5 h-3 w-56" />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Skeleton className="h-3.5 w-3.5 rounded-full" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-4 w-4" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ConversationsPage() {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Keyset pagination: the cursor for the next (older) page, null when fully loaded.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Conversations with a live agent turn in flight (the "working" indicator).
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const activityTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Debounce the search box so each keystroke doesn't fire a request.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const fetchConversations = useCallback(async () => {
    const { data, error: err } = await api.api.v1.conversations.get({
      query: {
        excludeGroups: true,
        ...(status ? { status } : {}),
        ...(debouncedSearch ? { q: debouncedSearch } : {}),
      },
    });
    if (err || !data) {
      setError(true);
      return;
    }
    setError(false);
    setConversations(data.conversations);
    setNextCursor(data.nextCursor);
  }, [status, debouncedSearch]);

  // Append the next page (older conversations), de-duping by id since a live re-sort may have
  // pulled a row into an earlier page meanwhile.
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const { data, error: err } = await api.api.v1.conversations.get({
        query: {
          excludeGroups: true,
          ...(status ? { status } : {}),
          ...(debouncedSearch ? { q: debouncedSearch } : {}),
          cursor: nextCursor,
        },
      });
      if (err || !data) return;
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...data.conversations.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, status, debouncedSearch]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchConversations().finally(() => {
      if (active) setLoading(false);
    });
    // Refetch on reconnect catches anything missed while disconnected (Bun
    // publish is a no-op for an absent socket).
    return () => {
      active = false;
    };
  }, [fetchConversations]);

  // Live updates on the active tenant's channel. Known rows merge in place (and
  // re-sort by recency); an unknown id (a brand-new conversation) triggers a
  // lightweight refetch so it appears without a full reload.
  useTenantEvents({
    onConversation: (event) => {
      setConversations((prev) => {
        const current = prev.find((c) => c.id === event.conversationId);
        if (!current) {
          void fetchConversations();
          return prev;
        }
        const merged: Conversation = {
          ...current,
          status: event.status ?? current.status,
          assigneeId: event.assigneeId,
          assigneeType: event.assigneeType,
          lastEventAt: event.lastEventAt ?? current.lastEventAt,
        };
        return prev
          .map((c) => (c.id === merged.id ? merged : c))
          .sort((a, b) => {
            const ta = a.lastEventAt ? Date.parse(a.lastEventAt) : 0;
            const tb = b.lastEventAt ? Date.parse(b.lastEventAt) : 0;
            return tb - ta;
          });
      });
    },
    // Toggle the per-row "working" indicator. A per-id TTL is the safety net for
    // a "finished" lost to a socket gap (the runtime always emits it otherwise).
    onAgentActivity: (event) => {
      const timers = activityTimers.current;
      const existing = timers.get(event.conversationId);
      if (existing) clearTimeout(existing);
      const clear = () => {
        timers.delete(event.conversationId);
        setActiveIds((prev) => {
          if (!prev.has(event.conversationId)) return prev;
          const next = new Set(prev);
          next.delete(event.conversationId);
          return next;
        });
      };
      if (event.phase === "finished") {
        clear();
        return;
      }
      setActiveIds((prev) => {
        if (prev.has(event.conversationId)) return prev;
        const next = new Set(prev);
        next.add(event.conversationId);
        return next;
      });
      timers.set(event.conversationId, setTimeout(clear, 30_000));
    },
  });

  // Clear all pending TTL timers on unmount.
  useEffect(() => {
    const timers = activityTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <MessagesSquare className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-semibold text-text-primary text-xl">
              {t("conversations.title", "Conversations")}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "conversations.subtitle",
                "Live conversations with their assignment status (AI or a human).",
              )}
            </p>
          </div>
        </div>
      </header>

      <div className="relative min-w-0">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(
            "conversations.search",
            "Search by contact or conversation #…",
          )}
          aria-label={t(
            "conversations.search",
            "Search by contact or conversation #…",
          )}
          className="w-full rounded-lg border border-border bg-bg-tertiary py-2 pr-4 pl-9 text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none"
        />
      </div>

      <FilterPills
        value={status}
        onChange={setStatus}
        aria-label={t("conversations.filterStatus", "Filter by status")}
        items={
          [
            { key: "", label: t("conversations.allStatuses", "All") },
            { key: "open", label: t("conversations.status.open", "Open") },
            {
              key: "pending",
              label: t("conversations.status.pending", "Pending"),
            },
            {
              key: "resolved",
              label: t("conversations.status.resolved", "Resolved"),
            },
            {
              key: "snoozed",
              label: t("conversations.status.snoozed", "Snoozed"),
            },
          ] satisfies FilterPillItem[]
        }
      />

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={conversations.length === 0}
        onRetry={fetchConversations}
        loadingLabel={t("conversations.loading", "Loading conversations…")}
        errorLabel={t("conversations.error", "Could not load conversations.")}
        skeleton={<ConversationsSkeleton />}
        empty={
          <p className="px-4 py-10 text-center text-sm text-text-muted">
            {t("conversations.empty", "No conversations yet.")}
          </p>
        }
      >
        <div className="flex flex-col gap-3">
          <Card className="p-1.5">
            <ul className="flex flex-col gap-0.5">
              {conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  c={c}
                  active={activeIds.has(c.id)}
                />
              ))}
            </ul>
          </Card>
          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={loadMore}
                loading={loadingMore}
              >
                {t("conversations.loadMore", "Load more")}
              </Button>
            </div>
          )}
        </div>
      </DataBoundary>
    </PageContainer>
  );
}
