import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import {
  Button,
  Card,
  EmptyState,
  PageContainer,
  Skeleton,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { cn, formatDateTime } from "@/client/lib/utils";
import { AUDIT_MARKER_KEYS, carriesAuditMarker } from "@/lib/audit/markers";
import { ACTOR_TYPES } from "@/lib/tenancy/actor";
import { clipText } from "@/lib/text";

// The audit trail viewer (TENANT_ADMIN). Rows newest first, filters in the URL, keyset pagination
// over a cursor stack — the same shape the Logs page uses, because it is the same kind of read.
//
// Two things this page does that a list of rows does not. It shows the newest row of the WHOLE
// trail on its own, because comparing that against a record's own updatedAt is how an operator
// learns a change happened that the trail cannot describe. And it renders `before`/`after` as a
// FIELD-LEVEL diff: half the rows on a real tenant carry two full system prompts of ~11k characters
// each (measured on a self-hosted deployment, issue #401), and two JSON blobs there are not
// inconvenient, they are unreadable.

type AuditResponse = Awaited<ReturnType<typeof api.api.v1.audit.get>>["data"];
type AuditItem = NonNullable<AuditResponse>["entries"][number];

const selectCls =
  "h-9 rounded-lg border border-border bg-bg-tertiary px-3 text-sm text-text-primary focus:border-border-focus focus:outline-none";
// The same pause the Logs page's search box takes.
const ACTION_DEBOUNCE_MS = 300;
const ROW_SKELETON_KEYS = ["au-0", "au-1", "au-2", "au-3", "au-4"];

// Long enough to read a name, an id or a short sentence whole; short enough that a system prompt
// does not take the page over. The full value is one click away.
const VALUE_PREVIEW = 160;

const ACTOR_PILL: Record<string, string> = {
  user: "bg-accent-soft text-accent",
  mcp: "bg-bg-tertiary text-text-secondary",
  api_key: "bg-bg-tertiary text-text-secondary",
  system: "bg-bg-tertiary text-text-muted",
};

function actorTypeLabel(kind: string, t: (k: string, d: string) => string) {
  switch (kind) {
    case "user":
      return t("audit.actor.user", "User");
    case "mcp":
      return t("audit.actor.mcp", "MCP client");
    case "api_key":
      return t("audit.actor.apiKey", "API key");
    case "system":
      return t("audit.actor.system", "System");
    default:
      return kind;
  }
}

function ActorPill({ kind }: { kind: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-medium text-xs",
        ACTOR_PILL[kind] ?? ACTOR_PILL.system,
      )}
    >
      {actorTypeLabel(kind, t)}
    </span>
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// A value as one line of text. Objects and arrays are stringified rather than rendered as a tree:
// the projections written to this table are flat by construction, and a nested one is rare enough
// that showing its JSON is better than a component nobody exercises.
function asText(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// A calendar day the OPERATOR sees, turned into the instants that bound it.
//
// The rows are rendered in the browser's own timezone, so the day has to be that browser's day and
// not UTC's. Suffixing `Z` filters a UTC day, and in São Paulo a row shown as Jan 1 at 22:00 carries
// a Jan 2 UTC stamp: it disappears from a Jan 1 filter, on the same screen that is displaying it as
// Jan 1. The upper bound is the next local midnight minus a millisecond, because a `23:59:59` cut
// drops the last fractional second, and because a day is 24 hours except on the two days a year it
// is 23 or 25.
//
// The boundary is the ENGINE's answer for that date and never arithmetic on an offset: a zone that
// springs forward AT midnight has no midnight that day (America/Santiago does this), and asking
// `getTimezoneOffset` for an instant that does not exist gives the offset from the OTHER side of the
// transition — added to a nominal UTC midnight it lands an hour off, dropping that day's last hour
// and lending it to the next.
//
// It is an ARGUMENT and not ambient state, which is the only reason any of this is testable: the
// suite runs at UTC (measured), where every local day is a UTC day and a version that got this wrong
// passes everything.
export function localMidnight(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d).getTime();
}

// `<input type="date">` emits exactly this and blanks anything else, so a value that is not in this
// shape came from a hand-edited URL. Accepting `2026-1-1` would filter by a day the input cannot
// display, leaving the page filtered by something the operator cannot see or clear.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function localDayBounds(
  value: string,
  midnightAt: (y: number, m: number, d: number) => number = localMidnight,
): { since: string; until: string } | null {
  if (!ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  // NOTE: A date that does not exist is REFUSED and never normalised. Date arithmetic turns February
  // 30 into March 2 without saying so, and this value can arrive from a URL somebody pasted: the
  // page would then query a different day than the one its own input is displaying, while presenting
  // itself as filtered. Round-tripping the components is the whole check.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return {
    since: new Date(midnightAt(y, m, d)).toISOString(),
    until: new Date(midnightAt(y, m, d + 1) - 1).toISOString(),
  };
}

export interface FieldChange {
  key: string;
  before: unknown;
  after: unknown;
}

// The keys the write side puts on a projection when a change moved a value the row does not show:
// an encrypted secret, a header block, a settings key no canonical reader looks at. They are
// deliberately identical on the two sides, which means a diff by equality erases them: the one row
// that says "something you cannot see here changed" would render as "nothing was recorded", the
// exact opposite. So they leave the field list and come back as their own answer.
//
// BOTH of them, from `lib/audit/markers`, and the second is why that list exists. #394's marker
// (`unreadConfigChanged`) rides on the FIELD's projection rather than on the top level, so a
// top-level check never sees it, and an edit that moved only unread configuration puts an equal
// marker object on each side, which this diff then drops as unchanged: the card said "this action
// recorded no field values" over a change the row was written precisely to report.

export interface ProjectionDiff {
  changes: FieldChange[];
  // A value the projection deliberately does not carry moved. Not a field, and not a count.
  undisclosed: boolean;
}

// The changed keys only, over the union of both sides, so a key that only one side has still shows.
// A row whose projection is not an object (or which carries only one side, as a create or a delete
// does) has no diff to compute and falls back to the whole value under its own key.
export function diffProjection(
  before: unknown,
  after: unknown,
): ProjectionDiff {
  const b = asRecord(before);
  const a = asRecord(after);
  const undisclosed = carriesAuditMarker(b) || carriesAuditMarker(a);
  const shown = (o: Record<string, unknown>) =>
    Object.keys(o).filter(
      (k) => !(AUDIT_MARKER_KEYS as readonly string[]).includes(k),
    );
  if (!b || !a) {
    const only = a ?? b;
    if (!only) return { changes: [], undisclosed };
    return {
      changes: shown(only)
        .sort()
        .map((key) => ({
          key,
          before: a ? undefined : only[key],
          after: a ? only[key] : undefined,
        })),
      undisclosed,
    };
  }
  const keys = [...new Set([...shown(b), ...shown(a)])].sort();
  return {
    changes: keys
      .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
      .map((key) => ({ key, before: b[key], after: a[key] })),
    undisclosed,
  };
}

function Value({
  value,
  tone,
  label,
}: {
  value: unknown;
  tone: "before" | "after";
  label: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = asText(value);
  const long = text.length > VALUE_PREVIEW;
  return (
    <div className="min-w-0">
      {/* The column header is the label, and it is only rendered from `sm` up. Below that the two
          values stack with nothing saying which is which, so each carries its own — visible on the
          narrow layout, and announced on every layout for a reader that never sees the header. */}
      <span className="mb-0.5 block text-text-muted text-xs sm:sr-only">
        {label}
      </span>
      <span
        className={cn(
          "block whitespace-pre-wrap break-words font-mono text-xs",
          tone === "before" ? "text-text-muted" : "text-text-primary",
        )}
      >
        {long && !open ? `${clipText(text, VALUE_PREVIEW)}…` : text}
      </span>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-accent text-xs hover:underline"
        >
          {open
            ? t("audit.showLess", "Show less")
            : t("audit.showAll", "Show all {{count}} characters", {
                count: text.length,
              })}
        </button>
      )}
    </div>
  );
}

function FieldDiff({ diff }: { diff: ProjectionDiff }) {
  const { t } = useTranslation();
  const { changes, undisclosed } = diff;
  if (changes.length === 0 && !undisclosed) {
    return (
      <p className="px-3 py-2.5 text-text-muted text-xs">
        {t("audit.noProjection", "This action recorded no field values.")}
      </p>
    );
  }
  return (
    <div className="divide-y divide-border">
      {undisclosed && (
        <p className="px-3 py-2.5 text-text-secondary text-xs">
          {t(
            "audit.undisclosed",
            "A value this entry does not show was changed, such as a secret or a header.",
          )}
        </p>
      )}
      {changes.map((c) => (
        <div
          key={c.key}
          className="grid gap-2 px-3 py-2.5 sm:grid-cols-[10rem_1fr_1fr]"
        >
          <span className="font-medium text-sm text-text-secondary">
            {c.key}
          </span>
          <Value
            value={c.before}
            tone="before"
            label={t("audit.before", "Before")}
          />
          <Value
            value={c.after}
            tone="after"
            label={t("audit.after", "After")}
          />
        </div>
      ))}
    </div>
  );
}

function AuditRowCard({ row }: { row: AuditItem }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const diff = useMemo(
    () => diffProjection(row.before, row.after),
    [row.before, row.after],
  );
  return (
    <Card className="!p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 select-none flex-wrap items-center gap-2 px-3 py-2.5 text-left"
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
        <span className="font-medium font-mono text-sm text-text-primary">
          {row.action}
        </span>
        <ActorPill kind={row.actorType} />
        {row.actorId && (
          <span className="text-text-muted text-xs">{`#${row.actorId}`}</span>
        )}
        {row.target && (
          <span className="truncate font-mono text-text-secondary text-xs">
            {row.target}
          </span>
        )}
        <span className="ml-auto whitespace-nowrap text-text-muted text-xs tabular-nums">
          {formatDateTime(row.createdAt, i18n.language)}
        </span>
        <span className="text-text-muted text-xs">
          {t("audit.fields", "{{count}} fields", {
            count: diff.changes.length,
          })}
        </span>
      </button>
      {expanded && (
        <div className="border-border border-t">
          <div className="hidden gap-2 border-border border-b px-3 py-1.5 text-text-muted text-xs sm:grid sm:grid-cols-[10rem_1fr_1fr]">
            <span>{t("audit.field", "Field")}</span>
            <span>{t("audit.before", "Before")}</span>
            <span>{t("audit.after", "After")}</span>
          </div>
          <FieldDiff diff={diff} />
        </div>
      )}
    </Card>
  );
}

// The newest row of the trail, on its own. Not decoration and not a duplicate of the first row: it
// stays put while the list below is filtered, and it is the number an operator subtracts a record's
// own updatedAt from to find a change nothing here can describe.
function TrailFreshness({
  latestAt,
  state,
}: {
  latestAt: string | null;
  state: "loading" | "ready" | "unavailable";
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm text-text-secondary">
          {t("audit.latest", "Newest entry in the trail")}
        </span>
        {/* `null` means two different things and only one of them is a fact: "the trail is empty"
            and "we have not asked yet, or the ask failed". Rendering the sentence before a response
            landed states the stronger one on no evidence — and on a failed load it stays there. */}
        {state === "ready" && (
          <span className="font-medium text-sm text-text-primary tabular-nums">
            {latestAt
              ? formatDateTime(latestAt, i18n.language)
              : t("audit.latestNone", "no entries yet")}
          </span>
        )}
        {/* A failed load is not a slow load: leaving the skeleton up would keep announcing "Loading…"
            for as long as the page stays in its error state, on an element that is telling a screen
            reader something is on its way. */}
        {state === "unavailable" && (
          <span className="text-sm text-text-muted">
            {t("audit.latestUnavailable", "could not be read")}
          </span>
        )}
        {state === "loading" && (
          <span role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-4 w-40" />
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto inline-flex items-center gap-1 text-text-muted text-xs hover:text-text-primary"
        >
          {t("audit.whatIsThis", "What is this for?")}
          {open ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      {open && (
        <p className="text-text-secondary text-xs">
          {t(
            "audit.latestHelp",
            "It does not change when you filter the list. Compare it with the last-updated time of a record you know was changed: if the record is newer, that change is not on the trail.",
          )}
        </p>
      )}
    </Card>
  );
}

export function AuditPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const action = searchParams.get("action") ?? "";
  const actorType = searchParams.get("actorType") ?? "";
  // A date, which is what an operator arrives with. Widened to an instant here, because the endpoint
  // refuses a bare date on purpose (a date is not an instant) and picking the boundary is the page's
  // job, not the caller's.
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  // The action box types into local state and lands in the URL on a pause. Without it every
  // keystroke of an action name is a URL change, and every URL change opens another scoped
  // transaction against a table that only grows — while the screen flips back to skeletons each
  // time. The request counter below keeps the ANSWERS honest; it does not stop the work.
  const [actionInput, setActionInput] = useState(action);
  // The URL can change from outside this input: the sidebar link back to `/audit`, a deep link, the
  // browser's own back button. Without this the box keeps the old text and the debounce below writes
  // it straight back, so navigating cannot clear or change the action filter.
  useEffect(() => {
    setActionInput(action);
  }, [action]);
  const [entries, setEntries] = useState<AuditItem[]>([]);
  const [latestAt, setLatestAt] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Which load the state belongs to. Filters are edited a keystroke at a time and each edit starts a
  // request, so several are in flight at once and they do not come back in order: a slower response
  // for an older, WIDER filter arriving last would overwrite the rows and the cursor with a page
  // that does not match the URL on screen — and pagination would then walk from the wrong place.
  const reqRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change only
  useEffect(() => {
    setCursorStack([null]);
  }, [action, actorType, from, to]);

  useEffect(() => {
    const id = setTimeout(() => {
      if (actionInput === action) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (actionInput) next.set("action", actionInput);
          else next.delete("action");
          return next;
        },
        { replace: true },
      );
    }, ACTION_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [actionInput, action, setSearchParams]);

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
    const mine = ++reqRef.current;
    const current = () => reqRef.current === mine;
    setLoading(true);
    setError(false);
    try {
      const query: Record<string, string> = {};
      if (action) query.action = action;
      if (actorType) query.actorType = actorType;
      const since = from ? localDayBounds(from) : null;
      const until = to ? localDayBounds(to) : null;
      if (since) query.since = since.since;
      if (until) query.until = until.until;
      // A date in the URL that is not a date is dropped from the URL too, not just from the query:
      // left there the page would say it is filtered by a day it is not filtering by.
      if ((from && !since) || (to && !until)) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (from && !since) next.delete("from");
            if (to && !until) next.delete("to");
            return next;
          },
          { replace: true },
        );
      }
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await api.api.v1.audit.get({ query });
      if (!current()) return;
      if (err || !data) {
        setError(true);
        setFreshness("unavailable");
        return;
      }
      setEntries(data.entries);
      setNextCursor(data.nextCursor);
      setLatestAt(data.latestAt);
      setFreshness("ready");
    } catch {
      if (current()) {
        setError(true);
        setFreshness("unavailable");
      }
    } finally {
      // Only the newest load owns the spinner: an older one finishing later would clear it while the
      // page it is not showing is still on its way.
      if (current()) setLoading(false);
    }
  }, [action, actorType, from, to, cursor, setSearchParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageIdx = cursorStack.length - 1;
  const scoped = action || actorType || from || to;

  return (
    <PageContainer size="wide" className="space-y-6">
      <header className="flex items-center gap-3">
        <ClipboardList className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <h1 className="font-bold text-2xl text-text-primary">
            {t("audit.title", "Audit trail")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t(
              "audit.subtitle",
              "Every configuration change, who made it and how they were authenticated. Values are recorded when the change happens and are never re-read from the live record.",
            )}
          </p>
        </div>
      </header>

      <TrailFreshness latestAt={latestAt} state={freshness} />

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={actionInput}
          onChange={(e) => setActionInput(e.target.value)}
          placeholder={t("audit.actionPlaceholder", "Action (exact)")}
          aria-label={t("audit.filterAction", "Action")}
          className={cn(selectCls, "min-w-48 flex-1")}
        />
        <select
          className={selectCls}
          value={actorType}
          onChange={(e) => setFilter("actorType", e.target.value)}
          aria-label={t("audit.filterActor", "Authenticated as")}
        >
          <option value="">{t("audit.allActors", "Any door")}</option>
          {ACTOR_TYPES.map((a) => (
            <option key={a} value={a}>
              {actorTypeLabel(a, t)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFilter("from", e.target.value)}
          aria-label={t("audit.filterFrom", "From")}
          className={selectCls}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setFilter("to", e.target.value)}
          aria-label={t("audit.filterTo", "To")}
          className={selectCls}
        />
        {scoped && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setActionInput("");
              setSearchParams({}, { replace: true });
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {t("audit.clearFilters", "Clear")}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col gap-3" role="status">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          {ROW_SKELETON_KEYS.map((k) => (
            <Card key={k} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-72" />
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={t("audit.errorTitle", "Could not load the trail")}
            description={t("audit.errorDesc", "Try again in a moment.")}
            action={
              <Button onClick={() => void load()}>
                {t("common.retry", "Retry")}
              </Button>
            }
          />
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title={
              scoped
                ? t(
                    "audit.emptyFilteredTitle",
                    "No entries match these filters",
                  )
                : t("audit.emptyTitle", "No entries yet")
            }
            description={
              scoped
                ? t(
                    "audit.emptyFilteredDescription",
                    "Widen the date range, or clear the filters to see the whole trail.",
                  )
                : t(
                    "audit.emptyDescription",
                    "Changes to agents, channels, knowledge and settings are recorded here as they are made.",
                  )
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map((row) => (
            <AuditRowCard key={row.id} row={row} />
          ))}
        </div>
      )}

      {!loading && !error && (entries.length > 0 || pageIdx > 0) && (
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
            {t("audit.page", "Page {{n}}", { n: pageIdx + 1 })}
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
    </PageContainer>
  );
}
