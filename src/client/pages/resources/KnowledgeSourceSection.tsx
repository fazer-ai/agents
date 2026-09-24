import { ExternalLink, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  FormField,
  Input,
  Skeleton,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { cn } from "@/client/lib/utils";

// A knowledge base's help center source, in the console (issue #798). #794 built the source over
// REST and MCP only: an operator could not see that a base mirrors a portal, when it last ran or
// whether that run failed, and could not set one up. This is that view, over the same three routes.

type BaseDetail = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof api.api.v1.knowledge.bases>["get"]>
  >["data"]
>["base"];
export type KnowledgeSource = NonNullable<BaseDetail["source"]>;

// How often, and for how long, the section re-reads the source after it armed a run. The run is a
// scheduler job, so its outcome lands on the row some seconds later and nothing announces it.
const POLL_MS = 3_000;
const POLL_TRIES = 20;

interface Draft {
  baseUrl: string;
  slug: string;
  locale: string;
  excludeIds: string;
  intervalMinutes: string;
}

function draftOf(s: KnowledgeSource | null): Draft {
  return {
    baseUrl: s?.baseUrl ?? "",
    slug: s?.slug ?? "",
    locale: s?.locale ?? "",
    excludeIds: s?.excludeIds.join(", ") ?? "",
    intervalMinutes: s ? String(s.intervalMinutes) : "10",
  };
}

// "12, 40 ,7" → [12, 40, 7]; null when a token is not a positive integer, so the form can say so
// instead of sending the API a list it would refuse without naming the token.
export function parseExcludeIds(text: string): number[] | null {
  const tokens = text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
  const ids: number[] = [];
  for (const tok of tokens) {
    if (!/^\d+$/.test(tok)) return null;
    const n = Number(tok);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

function lastRunTime(s: KnowledgeSource): number | null {
  return s.lastSyncAt ? new Date(s.lastSyncAt).getTime() : null;
}

export function KnowledgeSourceSection({
  baseId,
  canManage,
  onSourceChange,
}: {
  baseId: string;
  // Whether this console may change the source (the Knowledge page; the agent editor only reads).
  canManage: boolean;
  // Told whether the base has a source, which is what makes its documents read-only.
  onSourceChange: (hasSource: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const confirm = useModalController<ConfirmPayload>();
  // undefined = still loading; null = the base has no source.
  const [source, setSource] = useState<KnowledgeSource | null | undefined>(
    undefined,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // The base this section is about right now: a read that answers for another one is dropped.
  const current = useRef(baseId);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSourceChangeRef = useRef(onSourceChange);
  onSourceChangeRef.current = onSourceChange;

  const load = useCallback(async (): Promise<
    KnowledgeSource | null | undefined
  > => {
    const asked = baseId;
    try {
      const { data, error } = await api.api.v1.knowledge
        .bases({ id: asked })
        .get();
      if (current.current !== asked) return undefined;
      if (error || !data) {
        setLoadFailed(true);
        return undefined;
      }
      const next = data.base.source ?? null;
      setLoadFailed(false);
      setSource(next);
      onSourceChangeRef.current(next !== null);
      return next;
    } catch {
      if (current.current === asked) setLoadFailed(true);
      return undefined;
    }
  }, [baseId]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setSyncing(false);
  }, []);

  // Re-reads until the last run is newer than `since`, which is how a run the scheduler finishes
  // later reaches the screen without the operator reloading.
  const pollUntilRun = useCallback(
    (since: number | null) => {
      stopPolling();
      setSyncing(true);
      let tries = 0;
      const tick = async () => {
        tries += 1;
        const next = await load();
        const ran = next ? lastRunTime(next) : null;
        if (
          next === null ||
          (ran !== null && (since === null || ran > since)) ||
          tries >= POLL_TRIES
        ) {
          stopPolling();
          return;
        }
        pollTimer.current = setTimeout(tick, POLL_MS);
      };
      pollTimer.current = setTimeout(tick, POLL_MS);
    },
    [load, stopPolling],
  );

  useEffect(() => {
    current.current = baseId;
    setSource(undefined);
    setLoadFailed(false);
    setEditing(false);
    setFormError(null);
    void load();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
  }, [baseId, load]);

  function startEditing() {
    setDraft(draftOf(source ?? null));
    setFormError(null);
    setEditing(true);
  }

  // Local validation of the form, before anything is sent: there is no server sentence to show yet.
  function draftProblem(): string | null {
    if (parseExcludeIds(draft.excludeIds) === null) {
      return t(
        "knowledge.source.excludeIdsError",
        "Excluded article ids must be whole numbers separated by commas.",
      );
    }
    if (!Number.isInteger(Number(draft.intervalMinutes))) {
      return t(
        "knowledge.source.intervalError",
        "The interval must be a whole number of minutes.",
      );
    }
    return null;
  }

  async function save() {
    const problem = draftProblem();
    if (problem) {
      setFormError(problem);
      return;
    }
    const excludeIds = parseExcludeIds(draft.excludeIds) ?? [];
    const interval = Number(draft.intervalMinutes);
    setBusy(true);
    setFormError(null);
    try {
      const { error } = await api.api.v1.knowledge
        .bases({ id: baseId })
        .source.put({
          kind: "chatwoot_portal",
          baseUrl: draft.baseUrl.trim(),
          ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
          ...(draft.locale.trim() ? { locale: draft.locale.trim() } : {}),
          excludeIds,
          intervalMinutes: interval,
        });
      if (error) {
        setFormError(
          apiErrorMessage(error) ||
            t("knowledge.source.saveError", "Could not save the source."),
        );
        return;
      }
      const since = source ? lastRunTime(source) : null;
      setEditing(false);
      showToast(
        t(
          "knowledge.source.saved",
          "Source saved. The first sync runs in a moment.",
        ),
        "success",
      );
      await load();
      // Setting a source arms a run right away, so its outcome is worth waiting for too.
      pollUntilRun(since);
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    if (!source) return;
    const since = lastRunTime(source);
    setSyncing(true);
    const { error } = await api.api.v1.knowledge
      .bases({ id: baseId })
      .source.sync.post();
    if (error) {
      setSyncing(false);
      showToast(
        apiErrorMessage(error) ||
          t("knowledge.source.syncError", "Could not start the sync."),
        "error",
      );
      return;
    }
    showToast(t("knowledge.source.syncStarted", "Sync started."), "success");
    pollUntilRun(since);
  }

  function askRemove() {
    confirm.open({
      title: t("knowledge.source.removeTitle", "Remove help center source"),
      message: t(
        "knowledge.source.removeMessage",
        "The base stops syncing from the portal. The documents it synced stay in the base and become ordinary documents you can edit.",
      ),
      danger: true,
      confirmLabel: t("knowledge.source.removeAction", "Remove source"),
      onConfirm: async () => {
        const { error } = await api.api.v1.knowledge
          .bases({ id: baseId })
          .source.delete();
        if (error) {
          showToast(
            apiErrorMessage(error) ||
              t("knowledge.source.removeError", "Could not remove the source."),
            "error",
          );
          throw error;
        }
        stopPolling();
        showToast(
          t(
            "knowledge.source.removed",
            "Source removed. The documents stay in the base.",
          ),
          "success",
        );
        await load();
      },
    });
  }

  function statusBadge(status: string) {
    const label =
      status === "ok"
        ? t("knowledge.source.status.ok", "OK")
        : status === "warning"
          ? t("knowledge.source.status.warning", "Warning")
          : status === "error"
            ? t("knowledge.source.status.error", "Error")
            : status;
    return (
      <span
        data-status={status}
        className={cn("rounded-full px-2 py-0.5 text-xs", {
          "bg-success/10 text-success": status === "ok",
          "bg-warning-soft text-warning": status === "warning",
          "bg-error/10 text-error": status === "error",
          "bg-bg-tertiary text-text-muted":
            status !== "ok" && status !== "warning" && status !== "error",
        })}
      >
        {label}
      </span>
    );
  }

  const heading = (
    <h3 className="font-medium text-sm text-text-primary">
      {t("knowledge.source.title", "Help center source")}
    </h3>
  );

  if (source === undefined) {
    return (
      <section className="rounded-lg border border-border px-3 py-2">
        {heading}
        {loadFailed ? (
          <p className="mt-1 text-text-muted text-xs">
            {t(
              "knowledge.source.loadError",
              "Could not load this base's source.",
            )}
          </p>
        ) : (
          <div role="status" className="mt-2">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-8 w-full" />
          </div>
        )}
      </section>
    );
  }

  const form = (
    <div className="mt-2 flex flex-col gap-2">
      <FormField
        label={t("knowledge.source.baseUrl", "Portal URL")}
        hint={t(
          "knowledge.source.baseUrlHint",
          "The portal's public https address, e.g. the help center domain or the Chatwoot URL.",
        )}
        required
      >
        <Input
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          placeholder="https://"
          disabled={busy}
        />
      </FormField>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <FormField label={t("knowledge.source.slug", "Portal slug")}>
          <Input
            value={draft.slug}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
            disabled={busy}
          />
        </FormField>
        <FormField label={t("knowledge.source.locale", "Locale")}>
          <Input
            value={draft.locale}
            onChange={(e) => setDraft({ ...draft, locale: e.target.value })}
            placeholder="pt-BR"
            disabled={busy}
          />
        </FormField>
      </div>
      <FormField
        label={t("knowledge.source.excludeIds", "Excluded article ids")}
        hint={t(
          "knowledge.source.excludeIdsHint",
          "Articles to leave out of the base, separated by commas.",
        )}
      >
        <Input
          value={draft.excludeIds}
          onChange={(e) => setDraft({ ...draft, excludeIds: e.target.value })}
          placeholder="12, 40"
          disabled={busy}
        />
      </FormField>
      <FormField
        label={t("knowledge.source.interval", "Sync interval (minutes)")}
      >
        <Input
          type="number"
          value={draft.intervalMinutes}
          onChange={(e) =>
            setDraft({ ...draft, intervalMinutes: e.target.value })
          }
          disabled={busy}
        />
      </FormField>
      {formError && (
        <p role="alert" className="text-error text-xs">
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setEditing(false);
            setFormError(null);
          }}
          disabled={busy}
        >
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            void save();
          }}
          disabled={busy || draft.baseUrl.trim() === ""}
        >
          {t("knowledge.source.save", "Save source")}
        </Button>
      </div>
    </div>
  );

  if (source === null) {
    return (
      <section className="rounded-lg border border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          {heading}
          {canManage && !editing && (
            <Button size="sm" variant="secondary" onClick={startEditing}>
              {t("knowledge.source.setUp", "Set up source")}
            </Button>
          )}
        </div>
        {!editing && (
          <p className="mt-1 text-text-muted text-xs">
            {t(
              "knowledge.source.none",
              "This base does not mirror a help center. Its documents are managed here.",
            )}
          </p>
        )}
        {editing && form}
      </section>
    );
  }

  const ran = source.lastSyncAt ? new Date(source.lastSyncAt) : null;
  const rows: Array<[string, string]> = [
    [
      t("knowledge.source.kind", "Kind"),
      source.kind === "chatwoot_portal"
        ? t("knowledge.source.kindChatwoot", "Chatwoot help center")
        : source.kind,
    ],
    [t("knowledge.source.baseUrl", "Portal URL"), source.baseUrl],
    [t("knowledge.source.slug", "Portal slug"), source.slug],
    [t("knowledge.source.locale", "Locale"), source.locale],
    [
      t("knowledge.source.excludeIds", "Excluded article ids"),
      source.excludeIds.length > 0
        ? source.excludeIds.join(", ")
        : t("knowledge.source.noExcluded", "None"),
    ],
    [
      t("knowledge.source.intervalLabel", "Syncs every"),
      t("knowledge.source.intervalValue", "{{count}} minutes", {
        count: source.intervalMinutes,
      }),
    ],
  ];

  return (
    <section className="rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {heading}
        {canManage && !editing && (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void syncNow()}
              disabled={syncing}
            >
              <RefreshCw
                className={cn("h-4 w-4", { "animate-spin": syncing })}
                aria-hidden="true"
              />
              {t("knowledge.source.syncNow", "Sync now")}
            </Button>
            <Button size="sm" variant="secondary" onClick={startEditing}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t("common.edit", "Edit")}
            </Button>
            <Button size="sm" variant="secondary" onClick={askRemove}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t("knowledge.source.remove", "Remove")}
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        form
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-text-muted">{label}</dt>
                <dd className="break-all text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-text-muted">
              {t("knowledge.source.lastRun", "Last sync")}
            </span>
            {ran ? (
              <>
                <time
                  dateTime={ran.toISOString()}
                  className="text-text-primary"
                >
                  {ran.toLocaleString(i18n.language)}
                </time>
                {source.lastStatus && statusBadge(source.lastStatus)}
              </>
            ) : (
              <span className="text-text-primary">
                {t("knowledge.source.neverRan", "Not run yet")}
              </span>
            )}
            {syncing && (
              <span className="animate-pulse text-text-muted">
                {t("knowledge.source.syncing", "Syncing…")}
              </span>
            )}
          </div>
          {ran && source.lastMessage && (
            <p
              className={cn("mt-1 break-words text-xs", {
                "text-error": source.lastStatus === "error",
                "text-warning": source.lastStatus === "warning",
                "text-text-muted":
                  source.lastStatus !== "error" &&
                  source.lastStatus !== "warning",
              })}
            >
              {source.lastMessage}
            </p>
          )}
        </>
      )}
      <ConfirmDialog modal={confirm} />
    </section>
  );
}

// A synced document's row marker: what it is, where it comes from, and why it cannot be edited here.
export function SyncedDocNote({ sourceUrl }: { sourceUrl: string | null }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-1 text-text-muted text-xs">
      <span className="rounded-full bg-bg-tertiary px-2 py-0.5">
        {t("knowledge.source.synced", "Synced")}
      </span>
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 underline underline-offset-2"
        >
          {t("knowledge.source.openArticle", "Open article")}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </span>
  );
}
