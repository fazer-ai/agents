import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Filter,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import {
  Button,
  Card,
  ComboBox,
  EmptyState,
  PageContainer,
  Skeleton,
  Tooltip,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import {
  AUDIT_PERIOD_PRESETS,
  type AuditPeriodPreset,
  auditPresetRange,
  isCommittableRange,
  msUntilNextLocalMidnight,
  selectedPreset,
  todayKey,
} from "@/client/lib/auditPeriod";
import { cn, formatDateTime } from "@/client/lib/utils";
import { AUDIT_ACTIONS, isFleetLevelAction } from "@/lib/audit/actions";
import { AUDIT_MARKER_KEYS, carriesAuditMarker } from "@/lib/audit/markers";
import { AUDIT_SCOPES, type AuditScope, isAuditScope } from "@/lib/audit/scope";
import { ACTOR_TYPES } from "@/lib/tenancy/actor";
import { clipText } from "@/lib/text";

// The audit trail viewer (TENANT_ADMIN). Rows newest first, filters in the URL, keyset pagination
// over a cursor stack — the same shape the Logs page uses, because it is the same kind of read.
//
// What it does that a list of rows does not: it renders `before`/`after` as a FIELD-LEVEL diff. Half
// the rows on a real tenant carry two full system prompts of ~11k characters each (measured on a
// self-hosted deployment, issue #401), and two JSON blobs there are not inconvenient, they are
// unreadable.
//
// IT DOES NOT RENDER `latestAt`, and that is a decision rather than an omission. The response still
// carries the trail-wide newest row for the REST and MCP transports, and this page used to print it
// above the filters as "Trail recorded up to", with help telling the operator to subtract a record's
// own `updatedAt` from it: a record newer than the line meant a change the trail had missed.
//
// Unfiltered, the line was a duplicate of the first card. Filtered, it was worse than useless for
// the one job it claimed, and the reason is that it is a MAXIMUM OVER THE WHOLE TRAIL. A row that
// fails to write is invisible to a global maximum unless it would have been the newest AND nothing
// has been recorded since — any later row from any other family carries the line past the gap, and
// the operator's subtraction then reads as "covered". It does not merely miss the case, it answers
// it wrongly.
//
// That case is REAL, and it is why this comment is not the shorter "audit writes are transactional".
// They are on every path this console can reach, but not on the MCP consent decision: `upsertApproval`
// commits, and `auditConsentDecision` then writes in its own transaction and swallows a failure with
// a warn (#528). The detector for that is the log line and the invariant, not a header that would
// have said "covered".

type AuditResponse = Awaited<ReturnType<typeof api.api.v1.audit.get>>["data"];
type AuditItem = NonNullable<AuditResponse>["entries"][number];

const selectCls =
  "h-9 rounded-lg border border-border bg-bg-tertiary px-3 text-sm text-text-primary focus:border-border-focus focus:outline-none";
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

function AuditRowCard({
  row,
  showTenant,
  onFilterAction,
}: {
  row: AuditItem;
  showTenant: boolean;
  onFilterAction: (action: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const diff = useMemo(
    () => diffProjection(row.before, row.after),
    [row.before, row.after],
  );
  return (
    <Card className="!p-0 overflow-hidden">
      {/* The toggle and the filter shortcut are SIBLINGS rather than nested, because a button inside
          a button is not markup a browser agrees about — the inner one's activation is swallowed in
          some engines and doubled in others. The row header is the flex container; the toggle keeps
          the whole width it had. */}
      <div className="flex w-full min-w-0 items-center gap-1 pr-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 select-none flex-wrap items-center gap-2 px-3 py-2.5 text-left"
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
          {/* WHICH TENANT, and only where the answer is not already the page's. On a tenant trail
              every row is that tenant's and the chip would be noise on every line; on a fleet or
              cross-tenant read it is the column that stops two rows of the same action from reading
              as the same event. `null` is not "missing": it is the fleet, and those are the rows
              that outlive the tenant. */}
          {showTenant && (
            <span className="whitespace-nowrap rounded-md bg-bg-tertiary px-1.5 py-0.5 font-mono text-text-secondary text-xs">
              {row.tenantId ? `#${row.tenantId}` : t("audit.fleetRow", "fleet")}
            </span>
          )}
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
        {/* The shortcut that makes the action filter usable without knowing how an action is
            spelled: the name is already on the row, so filtering to it should be a click on the row
            rather than a transcription into a box. */}
        <Tooltip
          content={t("audit.filterByAction", "Show only {{action}}", {
            action: row.action,
          })}
        >
          <button
            type="button"
            onClick={() => onFilterAction(row.action)}
            aria-label={t("audit.filterByAction", "Show only {{action}}", {
              action: row.action,
            })}
            className="shrink-0 rounded-lg p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-text-primary"
          >
            <Filter className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
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

export function AuditPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const action = searchParams.get("action") ?? "";
  const actorType = searchParams.get("actorType") ?? "";
  // A date, which is what an operator arrives with. Widened to an instant here, because the endpoint
  // refuses a bare date on purpose (a date is not an instant) and picking the boundary is the page's
  // job, not the caller's.
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  // WHICH PRESET IS SELECTED IS NOT DERIVABLE FROM THE DATES, and the first version of this control
  // tried: picking "Custom" wrote a window, the next render read that window back as "Today", and
  // the two date inputs never appeared. `custom` is a MODE — "I am choosing the bounds myself" — and
  // every window it can hold is also some preset's window, so no pair of dates can distinguish it.
  //
  // It lives in the URL beside the bounds rather than in component state, so a link carries what the
  // sender was looking at, which is what the rest of this page's filters already promise. A pasted
  // link with only dates still resolves: `auditPresetOf` names the preset, or says custom.
  const periodParam = searchParams.get("period") ?? "";
  // Only a SUPER_ADMIN can read past their own tenant, and the service refuses the wider scopes to
  // anyone else with a 403 rather than narrowing them. So the page must not ASK for one it cannot
  // have: a scope in the URL that this operator may not use is dropped from the URL as well as from
  // the query, the same way an unparseable date is below — left there, the address bar would claim a
  // trail the page is not showing.
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const scopeParam = searchParams.get("scope") ?? "";
  const scope: AuditScope =
    isSuperAdmin && isAuditScope(scopeParam) ? scopeParam : "tenant";
  const showTenant = scope !== "tenant";

  // THE DEBOUNCE IS GONE WITH THE TEXT BOX. It existed because every keystroke of a typed action
  // name was a URL change and therefore another scoped transaction against a table that only grows;
  // a combo box commits once, when a value is chosen. Its free-text row commits once too — on
  // confirm rather than per character.
  // The empty row FIRST, because a single-value ComboBox has no clear affordance of its own — the
  // chip's `X` belongs to the multi-select. Without it the only way to drop the action was the
  // page-wide Clear, which also discards the actor and the period: a regression against the text box
  // this replaced.
  const actionItems = useMemo(
    () => [
      { id: "", label: t("audit.anyAction", "Any action") },
      ...AUDIT_ACTIONS.map((id) => ({ id })),
    ],
    [t],
  );
  const [entries, setEntries] = useState<AuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Which load the state belongs to. Filters are edited a keystroke at a time and each edit starts a
  // request, so several are in flight at once and they do not come back in order: a slower response
  // for an older, WIDER filter arriving last would overwrite the rows and the cursor with a page
  // that does not match the URL on screen — and pagination would then walk from the wrong place.
  const reqRef = useRef(0);

  // NOTE: THE SCOPE IS ON THIS LIST BECAUSE IT CHOOSES THE TRAIL, not because it is another filter.
  // A keyset cursor is an id cut from the page before, and it only means "continue" against the rows
  // it was cut from; handed to a different trail it still means `id < N` and silently drops
  // everything newer, under a pager that goes on saying "Page 2".
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change only
  useEffect(() => {
    setCursorStack([null]);
  }, [action, actorType, from, to, scope]);

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

  // The calendar day the presets resolve against, read ONCE and handed down. `auditPeriod` takes it
  // as an argument for the same reason: a preset that reads its own clock cannot be tested at UTC,
  // where every local day is a UTC day and the wrong answer passes.
  // NOT MEMOISED: a value pinned on mount keeps calling yesterday's window "Today" for as long as
  // the tab is open. Recomputing per render costs nothing and is right whenever the page is doing
  // anything at all — but a render is not a clock, so the handlers below read `todayKey()` again
  // rather than close over this one.
  const today = todayKey();
  const preset = selectedPreset(periodParam, from, to, today);

  // The one thing that makes the day above move on a page nobody is touching. Re-arms because
  // `today` changes when it fires; the correction itself is `selectedPreset`'s, which drops a named
  // mode as soon as its arithmetic stops producing these bounds — so at midnight a trail filtered to
  // "Today" relabels itself "Yesterday", which is what its unchanged bounds now mean.
  const [, bumpDay] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setTimeout(bumpDay, msUntilNextLocalMidnight(today));
    return () => clearTimeout(id);
  }, [today]);

  const setRange = (
    nextFrom: string,
    nextTo: string,
    mode: AuditPeriodPreset | "",
  ) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        // NOTE: BOTH BOUNDS IN ONE WRITE. Setting them one at a time publishes an intermediate URL whose
        // pair is a window nobody asked for, and the page loads it.
        if (nextFrom) next.set("from", nextFrom);
        else next.delete("from");
        if (nextTo) next.set("to", nextTo);
        else next.delete("to");
        // NOTE: THE MODE TRAVELS WITH THE BOUNDS, all of them and not just `custom`. Two presets can name
        // the same window — `this-week` on a Monday is `today` — so a link carrying only dates loses
        // which row was picked. Staleness is answered on the reading side instead: `selectedPreset`
        // honours a named mode only while its arithmetic still yields these bounds, so `period=today`
        // pasted tomorrow falls through and reads "Yesterday".
        if (mode) next.set("period", mode);
        else next.delete("period");
        return next;
      },
      { replace: true },
    );
  };

  const [draft, setDraft] = useState({ from, to });
  // Resyncs from the URL and never from what we just asked it to be: writing the optimistic value
  // here made the draft disagree with the params and the next render put the operator's own edit
  // back. A real URL change is a preset click, a pasted link or the back button.
  // THE MODE IS PART OF THE COMMITTED STATE, because a preset can leave the bounds untouched: clear
  // one custom field and then pick a preset whose window is the one already applied, and only
  // `period` moves. Watching bounds alone kept the half-empty draft alive, so returning to Custom
  // showed a blank bound while the query was still filtering by the committed pair.
  const committed = useRef({ from, to, mode: periodParam });
  if (
    committed.current.from !== from ||
    committed.current.to !== to ||
    committed.current.mode !== periodParam
  ) {
    committed.current = { from, to, mode: periodParam };
    setDraft({ from, to });
  }

  // The preset labels, declared where `i18next-parser` reads them: the key is computed at the call
  // site, so these lines are its only sight of it. They must be `//` comments in code — the parser
  // does not read a magic comment written inside JSX braces, and the keys silently never appear.
  // The scope labels, declared here for the same reason the period ones are: the key is computed at
  // the call site, and `i18next-parser` does not read a magic comment written inside JSX braces.
  // t('audit.scope.tenant', 'This tenant')
  // t('audit.scope.fleet', 'Fleet (no tenant)')
  // t('audit.scope.all', 'Whole fleet')
  // t('audit.period.today', 'Today')
  // t('audit.period.yesterday', 'Yesterday')
  // t('audit.period.this-week', 'This week')
  // t('audit.period.last-week', 'Last week')
  // t('audit.period.this-month', 'This month')
  // t('audit.period.last-month', 'Last month')
  // t('audit.period.30d', 'Last 30 days')
  // t('audit.period.this-year', 'This year')
  // t('audit.period.last-year', 'Last year')
  // t('audit.period.custom', 'Custom')
  function selectPreset(next: AuditPeriodPreset | "") {
    if (!next) {
      setRange("", "", "");
      return;
    }
    if (next === "custom") {
      // NOTE: OPENING THE ROW NARROWS NOTHING. It keeps whatever window is already applied and commits
      // NOTHING when there is none: seeding today here filtered an unfiltered trail down to today
      // as a side effect of showing two inputs, which is a query the operator never asked for.
      setRange(from, to, "custom");
      return;
    }
    const range = auditPresetRange(next, todayKey());
    setRange(range.from, range.to, next);
  }

  function setBound(bound: "from" | "to", value: string) {
    const candidate = { ...draft, [bound]: value };
    setDraft(candidate);
    // NOTE: WHAT MAY BE COMMITTED DEPENDS ON WHAT IS APPLIED, and the rule lives in `auditPeriod` where it
    // is tested: a pair on screen commits only as a usable pair, but a one-sided window commits one
    // bound, because there the pair rule refuses every edit for as long as the page is open.
    if (!isCommittableRange(candidate, { from, to })) return;
    setRange(candidate.from, candidate.to, "custom");
  }

  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const load = useCallback(async () => {
    const mine = ++reqRef.current;
    const current = () => reqRef.current === mine;
    setLoading(true);
    setError(false);
    try {
      const query: Record<string, string> = {};
      if (scope !== "tenant") query.scope = scope;
      if (action) query.action = action;
      if (actorType) query.actorType = actorType;
      const since = from ? localDayBounds(from) : null;
      const until = to ? localDayBounds(to) : null;
      if (since) query.since = since.since;
      if (until) query.until = until.until;
      // NOTE: A date in the URL that is not a date is dropped from the URL too, not just from the query:
      // left there the page would say it is filtered by a day it is not filtering by.
      const staleScope = scopeParam !== "" && scopeParam !== scope;
      if ((from && !since) || (to && !until) || staleScope) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (from && !since) next.delete("from");
            if (to && !until) next.delete("to");
            // NOTE: a scope this operator cannot use, or that is not a scope at all, leaves the URL
            // as well as the query. Left there the address bar would name a trail the page is not
            // reading, which is the reading a shared link then carries to the next person.
            if (staleScope) next.delete("scope");
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
        return;
      }
      setEntries(data.entries);
      setNextCursor(data.nextCursor);
    } catch {
      if (current()) setError(true);
    } finally {
      // NOTE: Only the newest load owns the spinner: an older one finishing later would clear it while the
      // page it is not showing is still on its way.
      if (current()) setLoading(false);
    }
  }, [action, actorType, from, to, cursor, scope, scopeParam, setSearchParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageIdx = cursorStack.length - 1;
  const scoped = action || actorType || from || to || scope !== "tenant";
  // NOTE: An empty page has two very different reasons, and only one of them is "nothing happened".
  // These actions write rows keyed to no tenant, which a TENANT read cannot reach at all, so
  // answering the ordinary "no entries match" would be the page asserting something it did not
  // check. On `fleet` or `all` it DID check — those are the very rows it just read — and repeating
  // the disclaimer would turn a real answer into a warning about a read that did happen.
  const fleetOnly = scope === "tenant" && isFleetLevelAction(action);

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

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-56 flex-1">
          <ComboBox
            value={action}
            onChange={(next) => setFilter("action", next)}
            items={actionItems}
            placeholder={t("audit.actionPlaceholder", "Any action")}
            searchPlaceholder={t("audit.actionSearch", "Search actions")}
            aria-label={t("audit.filterAction", "Action")}
          />
        </div>
        {/* THE SELECTOR IS SUPER_ADMIN'S, and it is not merely hidden from everyone else: the service
            refuses `fleet` and `all` with a 403 rather than answering them narrowed, because a scope
            that quietly returned the caller's own rows would report an empty fleet trail — the exact
            misreading this exists to end. Hidden here, refused there, and the URL kept honest in
            between. */}
        {isSuperAdmin && (
          <select
            className={selectCls}
            value={scope}
            onChange={(e) => setFilter("scope", e.target.value)}
            aria-label={t("audit.filterScope", "Trail")}
          >
            {AUDIT_SCOPES.map((key) => (
              <option key={key} value={key}>
                {/* biome-ignore lint/plugin/no-dynamic-i18n-key: every key is listed above */}
                {t(`audit.scope.${key}`)}
              </option>
            ))}
          </select>
        )}
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
        <select
          className={selectCls}
          value={preset}
          onChange={(e) => selectPreset(e.target.value as AuditPeriodPreset)}
          aria-label={t("audit.filterPeriod", "Period")}
        >
          <option value="">{t("audit.anyPeriod", "Any period")}</option>
          {AUDIT_PERIOD_PRESETS.map((key) => (
            <option key={key} value={key}>
              {/* biome-ignore lint/plugin/no-dynamic-i18n-key: every key is listed below */}
              {t(`audit.period.${key}`)}
            </option>
          ))}
        </select>
        {/* THE TWO INPUTS ONLY EXIST UNDER `custom`, and they hold a DRAFT that commits the PAIR.
            Both halves were measured on the equivalent control in ~/dev/bi. A `<input type="date">`
            reports "" while a date is being typed, so validating each keystroke against the
            committed value snaps the input back and keyboard entry cannot progress. And a pair check
            applied one field at a time makes some windows unreachable: to move a long window
            forward, changing `from` first inverts the pair and changing `to` first does too, so both
            edits are refused and the window cannot be reached at all. */}
        {preset === "custom" && (
          <>
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setBound("from", e.target.value)}
              aria-label={t("audit.filterFrom", "From")}
              className={selectCls}
            />
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setBound("to", e.target.value)}
              aria-label={t("audit.filterTo", "To")}
              className={selectCls}
            />
          </>
        )}
        {scoped && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSearchParams({}, { replace: true })}
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
              fleetOnly
                ? t(
                    "audit.emptyFleetTitle",
                    "This action is not recorded on a tenant's trail",
                  )
                : scoped
                  ? t(
                      "audit.emptyFilteredTitle",
                      "No entries match these filters",
                    )
                  : t("audit.emptyTitle", "No entries yet")
            }
            description={
              fleetOnly
                ? t(
                    "audit.emptyFleetDescription",
                    "{{action}} changes something the whole deployment shares, so its record belongs to no tenant. An empty list here does not mean it never happened.",
                    { action },
                  )
                : scoped
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
            <AuditRowCard
              key={row.id}
              row={row}
              showTenant={showTenant}
              onFilterAction={(next) => setFilter("action", next)}
            />
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
