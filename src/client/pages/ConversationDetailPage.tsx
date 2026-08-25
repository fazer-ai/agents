import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Lock,
  Megaphone,
  Paperclip,
  RotateCcw,
  ScrollText,
  Settings,
  Sparkles,
  Tag,
  Type,
  User,
  UserCheck,
  Volume2,
  Wrench,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  Markdown,
  MediaAudio,
  MediaImage,
  OutOfHoursBadge,
  PageContainer,
  Skeleton,
  TestModeBadge,
  ToolCallDetails,
  Tooltip,
  useToast,
} from "@/client/components";
import { useTenantEvents } from "@/client/hooks/useTenantEvents";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { cn, formatRelativeTime } from "@/client/lib/utils";

// Eden-derived types for the dynamic /conversations/:id routes (metadata shell + the separate
// thread, fetched independently so a slow Chatwoot only spins the messages area).
type MetaResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.conversations>["get"]>
>;
type ConversationDetail = NonNullable<MetaResp["data"]>["conversation"];
type MessagesResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.conversations>["messages"]["get"]>
>;
type Message = NonNullable<MessagesResp["data"]>["messages"][number];
type TrailEntry = NonNullable<ConversationDetail>["trail"][number];

type BadgeVariant = "primary" | "secondary" | "success" | "warning" | "info";
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  open: "info",
  pending: "warning",
  resolved: "success",
  snoozed: "secondary",
};

type Attachment = NonNullable<Message["attachments"]>[number];

// One attachment, proxied through our origin (/conversations/:id/media) so it renders under a strict
// CSP and carries the tenant selector. Audio shows a player + the STT transcription (when present);
// images render inline; anything else is a link that opens the proxied bytes.
function MessageAttachment({
  convId,
  att,
  outgoing,
}: {
  convId: string;
  att: Attachment;
  outgoing: boolean;
}) {
  const { t } = useTranslation();
  if (!att.dataUrl) return null;
  const src = `/api/v1/conversations/${convId}/media?url=${encodeURIComponent(
    att.dataUrl,
  )}`;
  if (att.fileType === "audio") {
    return (
      <div className="flex flex-col gap-1">
        <MediaAudio src={src} />
        {att.transcribedText && (
          <p
            className={cn(
              "whitespace-pre-wrap text-xs italic",
              outgoing ? "text-accent-foreground/70" : "text-text-muted",
            )}
          >
            {att.transcribedText}
          </p>
        )}
      </div>
    );
  }
  if (att.fileType === "image") {
    return <MediaImage src={src} className="max-h-60" />;
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 text-sm underline",
        outgoing ? "text-accent-foreground" : "text-text-primary",
      )}
    >
      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
      {t("conversation.attachment", "Attachment")}
    </a>
  );
}

type FollowUpBadgeInfo = { step: number | null; total: number };

function MessageBubble({
  m,
  convId,
  followUpBadge,
  quotedText,
  quotedLabel,
}: {
  m: Message;
  convId: string;
  followUpBadge?: FollowUpBadgeInfo;
  // The quoted/replied-to message's preview (item 11): a short snippet + who said it. null when this
  // message is not a reply, or the referenced message isn't in the loaded window.
  quotedText?: string | null;
  quotedLabel?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const when = m.createdAt
    ? new Date(m.createdAt * 1000).toLocaleString(i18n.language)
    : null;
  // Chatwoot message_type: 0 incoming, 1 outgoing, others = activity/system.
  const outgoing = m.messageType === 1;
  const incoming = m.messageType === 0;

  if (m.private) {
    return (
      <div className="mx-auto w-full max-w-xl rounded-lg border border-warning/40 bg-warning-soft px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-warning text-xs">
          <Lock className="h-3 w-3" aria-hidden="true" />
          {t("conversation.privateNote", "Private note")}
          {m.senderName ? ` · ${m.senderName}` : ""}
        </div>
        <p className="whitespace-pre-wrap text-sm text-text-primary">
          {m.content}
        </p>
      </div>
    );
  }

  if (!incoming && !outgoing) {
    return (
      <p className="text-center text-text-muted text-xs">
        {m.content}
        {when ? ` · ${when}` : ""}
      </p>
    );
  }

  return (
    <div className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2",
          outgoing
            ? "bg-accent text-accent-foreground"
            : "bg-bg-tertiary text-text-primary",
        )}
      >
        {m.senderName && (
          <p
            className={cn(
              "mb-0.5 font-medium text-xs",
              outgoing ? "text-accent-foreground/80" : "text-text-muted",
            )}
          >
            {m.senderName}
          </p>
        )}
        {quotedText && (
          <div
            className={cn(
              "mb-1 rounded border-l-2 px-2 py-1 text-xs",
              outgoing
                ? "border-accent-foreground/50 bg-accent-foreground/10 text-accent-foreground/80"
                : "border-border bg-bg-secondary text-text-muted",
            )}
          >
            {quotedLabel && (
              <p className="font-medium opacity-90">{quotedLabel}</p>
            )}
            <p className="line-clamp-2 whitespace-pre-wrap">{quotedText}</p>
          </div>
        )}
        {m.content &&
          (outgoing ? (
            // Agent/bot (and human-agent) replies carry Markdown; render it (item 6). Incoming customer
            // text stays literal — a customer typing * or _ must not become emphasis.
            <Markdown tone="onAccent" className="text-sm">
              {m.content}
            </Markdown>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{m.content}</p>
          ))}
        {m.attachments?.length ? (
          <div className="mt-1 flex flex-col gap-1.5">
            {m.attachments.map((att) => (
              <MessageAttachment
                key={att.id ?? att.dataUrl ?? "att"}
                convId={convId}
                att={att}
                outgoing={outgoing}
              />
            ))}
          </div>
        ) : null}
        {followUpBadge && (
          <span
            className={cn(
              "mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[10px]",
              outgoing
                ? "bg-accent-foreground/15 text-accent-foreground/90"
                : "bg-bg-secondary text-text-muted",
            )}
          >
            <Megaphone className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
            {followUpBadge.step != null
              ? t(
                  "conversation.followUp.badgeN",
                  "Follow-up {{step}}/{{total}}",
                  {
                    step: followUpBadge.step,
                    total: followUpBadge.total,
                  },
                )
              : t("conversation.followUp.badge", "Follow-up")}
          </span>
        )}
        {when && (
          <p
            className={cn(
              "mt-1 text-[10px]",
              outgoing ? "text-accent-foreground/70" : "text-text-muted",
            )}
          >
            {when}
          </p>
        )}
      </div>
    </div>
  );
}

// loadMessages replaces the whole array on every realtime event, but most bubbles are identical
// across fetches. Compare by value so memo skips re-rendering the unchanged ones (id never changes;
// content/transcription can — e.g. the eager-STT write-back fills an audio bubble's transcription).
function sameMessage(a: Message, b: Message): boolean {
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.messageType === b.messageType &&
    a.private === b.private &&
    a.createdAt === b.createdAt &&
    a.senderName === b.senderName &&
    (a.attachments?.length ?? 0) === (b.attachments?.length ?? 0) &&
    (a.attachments ?? []).every(
      (att, i) =>
        att.dataUrl === b.attachments?.[i]?.dataUrl &&
        att.transcribedText === b.attachments?.[i]?.transcribedText,
    )
  );
}

// Merge an incoming page into the current thread by message id (chronological). The server only ever
// returns ONE page (~20): the latest on a refresh, or an OLDER page on "load older". A union (not a
// replace) is what lets paged-in older messages survive a subsequent background refresh of the latest
// page. Reuses the previous object reference for every unchanged message so MessageBubbleMemo skips
// re-rendering it (no flicker on the realtime-driven refreshes). Returns the same array identity when
// nothing changed so React skips the list reconcile entirely.
function unionMessages(prev: Message[], incoming: Message[]): Message[] {
  if (prev.length === 0) return incoming;
  const keyOf = (m: Message) =>
    m.id != null
      ? `id:${m.id}`
      : `k:${m.messageType}:${m.createdAt}:${m.content ?? ""}`;
  const byKey = new Map<string, Message>();
  for (const m of prev) byKey.set(keyOf(m), m);
  let changed = false;
  for (const m of incoming) {
    const k = keyOf(m);
    const old = byKey.get(k);
    if (old && sameMessage(old, m)) continue;
    byKey.set(k, m);
    changed = true;
  }
  if (!changed && byKey.size === prev.length) return prev;
  return [...byKey.values()].sort((a, b) => {
    const ai = a.id ?? 0;
    const bi = b.id ?? 0;
    if (ai !== bi) return ai - bi;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

const MessageBubbleMemo = memo(
  MessageBubble,
  (a, b) =>
    a.convId === b.convId &&
    sameMessage(a.m, b.m) &&
    a.followUpBadge?.step === b.followUpBadge?.step &&
    a.followUpBadge?.total === b.followUpBadge?.total &&
    (a.followUpBadge == null) === (b.followUpBadge == null) &&
    a.quotedText === b.quotedText &&
    a.quotedLabel === b.quotedLabel,
);

// Safety net: a live indicator that never received its "finished" event (e.g. the socket dropped
// mid-turn) self-clears after this long. Tool calls no longer need a minimum-display floor — a fast
// tool now leaves a PERSISTENT marker in the timeline (the trail), so the live bubble can switch
// immediately to the next step without flashing.
const ACTIVITY_STUCK_MS = 30_000;

// The translated label for a known native tool name; null for an unknown/absent name (caller picks a
// generic fallback). Static t() keys so the i18n extractor sees them.
// Humanize a raw tool name as a last resort when no friendly label is mapped (custom HTTP / MCP
// tools, and native tools without a dedicated phrase): snake_case → "Snake case". Beats the generic
// "Used a tool" so the operator can tell WHICH tool ran (item 5).
function prettyToolName(name: string): string {
  const words = name.replace(/_+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function useToolLabel(tool: string | null): string | null {
  const { t } = useTranslation();
  switch (tool) {
    case "handoff_to_human":
      return t("conversation.activity.handoff", "Transferring to a human");
    case "private_note":
      return t("conversation.activity.note", "Writing an internal note");
    case "set_custom_attribute":
      return t("conversation.activity.attr", "Updating details");
    case "resolve_conversation":
      return t("conversation.activity.resolve", "Wrapping up the conversation");
    case "react_to_message":
      return t("conversation.activity.react", "Reacting to a message");
    case "skip_reply":
      return t("conversation.activity.skip", "Decided not to respond");
    case "search_knowledge":
      return t("conversation.activity.search", "Searching the knowledge base");
    case "suggest_kb_entry":
      return t(
        "conversation.activity.suggest",
        "Preparing a knowledge suggestion",
      );
    default:
      return null;
  }
}

type ActivityStage = "thinking" | "tool" | "debounce" | "delivering";
type ActivityState = {
  stage: ActivityStage | null;
  tool: string | null;
  // For "debounce": ISO flush time, drives a live countdown. Absent otherwise.
  runAt?: string | null;
} | null;

// A compact, persistent activity marker drawn inline in the timeline (a tool call that ran, or a
// proactive follow-up that was sent). Distinct from the transient AgentActivityIndicator below. A tool
// marker that captured args/result is EXPANDABLE: clicking it reveals the arguments and the result
// (same rendering as the playground trace, via ToolCallDetails).
function TrailMarker({ entry }: { entry: TrailEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toolLabel = useToolLabel(entry.kind === "tool" ? entry.name : null);
  const failed = entry.status === "error";
  let label: string;
  let Icon = Wrench;
  if (entry.kind === "reminder") {
    Icon = CalendarClock;
    label = t("conversation.trail.reminderSent", "Reminder sent");
  } else if (entry.kind === "followup") {
    Icon = Megaphone;
    label =
      entry.step != null
        ? t("conversation.trail.followUpSentN", "Follow-up {{step}} sent", {
            step: entry.step,
          })
        : t("conversation.trail.followUpSent", "Follow-up sent");
  } else {
    label =
      toolLabel ??
      (entry.kind === "tool" && entry.name
        ? prettyToolName(entry.name)
        : t("conversation.trail.tool", "Used a tool"));
  }
  const duration =
    entry.durationMs != null && entry.durationMs >= 0
      ? entry.durationMs < 1000
        ? `${entry.durationMs}ms`
        : `${(entry.durationMs / 1000).toFixed(1)}s`
      : null;
  const hasDetails =
    entry.kind === "tool" &&
    ((entry.args != null &&
      !(
        typeof entry.args === "object" &&
        Object.keys(entry.args as object).length === 0
      )) ||
      (entry.output != null && entry.output !== "") ||
      (entry.errorMessage != null && entry.errorMessage !== ""));

  const line = (
    <div className="flex items-center justify-center gap-1.5 text-text-muted text-xs">
      {hasDetails &&
        (expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        ))}
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      <span aria-hidden="true">·</span>
      <span className={cn(failed ? "text-error" : "text-success")}>
        {failed ? "✗" : "✓"}
      </span>
      {duration && (
        <>
          <span aria-hidden="true">·</span>
          <span>{duration}</span>
        </>
      )}
    </div>
  );

  if (!hasDetails) return line;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="rounded px-1 py-0.5 hover:bg-bg-tertiary"
      >
        {line}
      </button>
      {failed && entry.errorMessage && !expanded && (
        <span className="max-w-xs truncate text-error text-xs">
          {entry.errorMessage}
        </span>
      )}
      {expanded && (
        <div className="w-full max-w-xl">
          <ToolCallDetails
            args={entry.args}
            output={entry.output}
            error={entry.errorMessage}
          />
        </div>
      )}
    </div>
  );
}

// The transient "agent is working" indicator (a chat-style typing bubble). Maps the coarse realtime
// stage/tool to a specific, already-translated label. For "debounce" it runs a live countdown to the
// coalescing flush (runAt); for "delivering" it sits below the freshly-posted balloons until they
// land. Pulsing dots are CSS-only (animate-bounce) so nothing inline trips the CSP.
function AgentActivityIndicator({ activity }: { activity: ActivityState }) {
  const { t } = useTranslation();
  const toolLabel = useToolLabel(
    activity?.stage === "tool" ? activity.tool : null,
  );
  const [remaining, setRemaining] = useState<number | null>(null);
  const runAt =
    activity?.stage === "debounce" ? (activity.runAt ?? null) : null;
  useEffect(() => {
    if (!runAt) {
      setRemaining(null);
      return;
    }
    const target = Date.parse(runAt);
    const tick = () =>
      setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [runAt]);

  if (!activity) return null;
  let label: string;
  if (activity.stage === "tool") {
    label =
      toolLabel ??
      (activity.tool
        ? prettyToolName(activity.tool)
        : t("conversation.activity.tool", "Using a tool"));
  } else if (activity.stage === "debounce") {
    label =
      remaining != null && remaining > 0
        ? t(
            "conversation.activity.debounceCountdown",
            "Waiting for more messages · ~{{seconds}}s",
            { seconds: remaining },
          )
        : t("conversation.activity.debounce", "Waiting for more messages");
  } else if (activity.stage === "delivering") {
    label = t("conversation.activity.delivering", "Delivering the reply");
  } else {
    label = t("conversation.activity.thinking", "Thinking");
  }
  return (
    <div className="flex justify-start" aria-live="polite">
      <div className="flex max-w-[80%] items-center gap-2 rounded-2xl bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">
        <Bot className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <span>{label}</span>
        <span className="flex items-center gap-0.5" aria-hidden="true">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

// Merge the message thread and the activity trail into one time-ordered timeline. Messages carry a
// unix-seconds createdAt; trail markers an ISO `at`. A message with no timestamp (system/activity
// line) inherits the previous item's time so it keeps its place instead of jumping to the top. `seq`
// is a stable tiebreaker for equal timestamps.
type TimelineItem =
  | { kind: "message"; at: number; seq: number; key: string; m: Message }
  | { kind: "trail"; at: number; seq: number; key: string; entry: TrailEntry };

type Timeline = {
  items: TimelineItem[];
  // message key → the follow-up badge to stamp on that outgoing bubble (item 20).
  followUpBadges: Map<string, FollowUpBadgeInfo>;
  // the key of the LAST (latest) follow-up bubble — where the "sequence complete" line anchors (item 19).
  lastFollowUpKey: string | null;
};

function messageKey(m: Message, i: number): string {
  return m.id != null ? `m-${m.id}` : `m-idx-${i}`;
}

function buildTimeline(
  messages: Message[],
  trail: TrailEntry[],
  totalSteps: number,
): Timeline {
  // A follow-up send no longer draws its own trail line (item 20): match it to the outgoing bubble it
  // produced (the reply posted right after the generate log) and stamp a badge on that bubble. One
  // bubble per send; a send we can't match (message not loaded / timing window missed) falls back to a
  // trail marker so nothing is silently lost.
  const followUpEntries = trail.filter((e) => e.kind === "followup");
  const otherEntries = trail.filter((e) => e.kind !== "followup");
  const followUpBadges = new Map<string, FollowUpBadgeInfo>();
  const claimed = new Set<number>();
  const matched: { key: string; at: number }[] = [];
  const unmatched: TrailEntry[] = [];
  const sortedFollowUps = [...followUpEntries].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  for (const f of sortedFollowUps) {
    const fAt = Date.parse(f.at);
    let bestIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (claimed.has(i)) continue;
      const m = messages[i];
      if (m?.messageType !== 1 || m.createdAt == null) continue;
      const mAt = m.createdAt * 1000;
      // The reply lands at or shortly after the generate log (small back-tolerance for clock skew).
      if (mAt >= fAt - 5_000 && mAt <= fAt + 300_000) {
        bestIdx = i;
        break;
      }
    }
    const m = bestIdx === -1 ? undefined : messages[bestIdx];
    if (!m) {
      unmatched.push(f);
      continue;
    }
    claimed.add(bestIdx);
    const key = messageKey(m, bestIdx);
    followUpBadges.set(key, { step: f.step, total: totalSteps });
    matched.push({ key, at: (m.createdAt ?? 0) * 1000 });
  }
  const lastFollowUpKey = matched.length
    ? matched.reduce((a, b) => (b.at >= a.at ? b : a)).key
    : null;

  const items: TimelineItem[] = [];
  let last = 0;
  messages.forEach((m, i) => {
    const at = m.createdAt != null ? m.createdAt * 1000 : last;
    last = at;
    items.push({ kind: "message", at, seq: i, key: messageKey(m, i), m });
  });
  // Tool markers + any follow-up sends we couldn't pin to a bubble.
  [...otherEntries, ...unmatched].forEach((e, i) => {
    items.push({
      kind: "trail",
      at: Date.parse(e.at),
      seq: messages.length + i,
      key: `t-${e.id}`,
      entry: e,
    });
  });
  items.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return { items, followUpBadges, lastFollowUpKey };
}

// Compact cadence unit for the sequence tooltip ("2 min", "1 h", "3 d"). Abbreviations read the same
// in pt-BR/en, so they need no translation.
function formatDelayShort(value: number, unit: string): string {
  const u = unit === "hours" ? "h" : unit === "days" ? "d" : "min";
  return `${value} ${u}`;
}

// Absolute clock for the follow-up estimate. Same calendar day as now → just the time ("14:30");
// a different day → prefix a short date ("23/06 14:30") so the estimate isn't ambiguous across days.
function formatRunAt(iso: string, lang: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(lang, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString(lang, { day: "2-digit", month: "short" });
  return `${date} ${time}`;
}

// Localized short weekday name. 2024-01-07 is a Sunday, so Date.UTC(2024,0,7+d) maps d=0..6 → Sun..Sat
// (windowSpec.day convention). timeZone UTC keeps the weekday stable regardless of the viewer's zone.
function dayShort(d: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 7 + d)));
}

// Compact send-window summary for the tooltip: group windows by time range, list their days with
// consecutive runs collapsed (e.g. "Mon-Fri 09:00-18:00", "Sat 09:00-12:00").
function formatHoursWindows(
  windows: { day: number; start: string; end: string }[],
  lang: string,
): string[] {
  const byRange = new Map<string, number[]>();
  for (const w of windows) {
    const range = `${w.start}-${w.end}`;
    const days = byRange.get(range) ?? [];
    days.push(w.day);
    byRange.set(range, days);
  }
  const lines: string[] = [];
  for (const [range, daysRaw] of byRange) {
    const days = [...new Set(daysRaw)].sort((a, b) => a - b);
    const runs: [number, number][] = [];
    for (const d of days) {
      const last = runs.at(-1);
      if (last && d === last[1] + 1) last[1] = d;
      else runs.push([d, d]);
    }
    const daysLabel = runs
      .map(([s, e]) =>
        s === e
          ? dayShort(s, lang)
          : `${dayShort(s, lang)}-${dayShort(e, lang)}`,
      )
      .join(", ");
    lines.push(`${daysLabel} ${range}`);
  }
  return lines;
}

// The "follow-up sequence complete" marker (item 19). Anchored right after the last follow-up bubble in
// the timeline (not pinned at the foot), so it reads as the closing beat of the sequence it belongs to.
function FollowUpComplete() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-1.5 text-text-muted text-xs">
      <CheckCircle2
        className="h-3 w-3 shrink-0 text-success"
        aria-hidden="true"
      />
      <span>
        {t("conversation.followUp.done", "Follow-up sequence complete")}
      </span>
    </div>
  );
}

// The proactive follow-up journey, drawn at the foot of the timeline (item 12/13): the next pending
// step + its estimated time + the absolute clock time, the "complete" state, or "none yet". Times are
// estimates (background job). A tooltip draws the FULL configured sequence (per-step cadence, labels,
// the resolving step). When the estimate is past due, the line is highlighted and the tooltip explains
// the send is imminent. Re-renders on a light timer so the relative ETA stays fresh between refetches.
function FollowUpLine({
  followUp,
  lang,
}: {
  followUp: NonNullable<ConversationDetail["followUp"]>;
  lang: string;
}) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(iv);
  }, []);

  let label: string;
  let imminent = false;
  let imminentHint: string | null = null;
  // A booked appointment pauses the sequence (the sweep skips the conversation and the handler
  // reschedules an armed job), so there is no time to count down to. Say WHY instead of hiding the
  // line: an empty indicator here reads exactly like a broken scheduler.
  const paused = followUp.pausedByAppointment;
  if (paused) {
    label = t(
      "conversation.followUp.pausedAppointment",
      "Follow-up paused · appointment booked",
    );
  } else if (followUp.nextStep != null && followUp.nextRunAt) {
    const deltaSec = (Date.parse(followUp.nextRunAt) - Date.now()) / 1000;
    let when: string;
    if (deltaSec <= 0) {
      imminent = true;
      when = t("conversation.followUp.imminent", "any moment now");
      imminentHint = t(
        "conversation.followUp.imminentHint",
        "The estimated time has passed; it runs on a background worker, so the follow-up will be sent at any moment.",
      );
    } else if (deltaSec < 60) {
      when = t("conversation.followUp.underMinute", "in under a minute");
    } else {
      when = formatRelativeTime(followUp.nextRunAt, lang);
    }
    const at = formatRunAt(followUp.nextRunAt, lang);
    label = t(
      "conversation.followUp.scheduled",
      "Follow-up {{step}}/{{total}} · {{when}} · {{at}}",
      { step: followUp.nextStep, total: followUp.totalSteps, when, at },
    );
  } else {
    // Only the forward-looking estimate lives at the foot now. "Complete" is anchored right after the
    // last follow-up bubble (FollowUpComplete, item 19); "none yet" is hidden (item 7).
    return null;
  }

  // Rich tooltip: a highlighted "imminent" callout (when overdue), then the full configured sequence.
  // Step 1 measures inactivity; later steps wait after the previous one. The next step is accented;
  // each row shows its optional label chip + a "resolves" marker.
  const tooltipContent = (
    <div className="flex flex-col gap-2 text-left">
      {imminentHint && (
        <div className="flex items-start gap-1.5 rounded bg-warning/15 px-2 py-1.5 text-warning">
          <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{imminentHint}</span>
        </div>
      )}
      {paused && (
        <div className="flex items-start gap-1.5 rounded bg-bg-tertiary px-2 py-1.5 text-text-secondary">
          <CalendarClock
            className="mt-0.5 h-3 w-3 shrink-0"
            aria-hidden="true"
          />
          <span>
            {t(
              "conversation.followUp.pausedAppointmentHint",
              "The contact has an appointment booked, and this agent pauses re-engagement until it passes or is cancelled. The sequence resumes on its own after that.",
            )}
          </span>
        </div>
      )}
      {!imminent && followUp.nextRunAtDeferred && (
        <div className="flex items-start gap-1.5 rounded bg-bg-tertiary px-2 py-1.5 text-text-secondary">
          <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {t(
              "conversation.followUp.deferredHint",
              "The step's delay landed outside the send schedule, so it was pushed to the next available time.",
            )}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold text-[10px] text-text-muted uppercase tracking-wider">
          {t("conversation.followUp.sequenceTitle", "Follow-up sequence")}
        </span>
        <ul className="flex flex-col gap-1">
          {followUp.steps.map((s, i) => {
            const isNext = followUp.nextStep === i + 1;
            const cadence =
              i === 0
                ? t(
                    "conversation.followUp.cadenceFirst",
                    "after {{delay}} of silence",
                    { delay: formatDelayShort(s.delayValue, s.delayUnit) },
                  )
                : t(
                    "conversation.followUp.cadenceNext",
                    "{{delay}} after the previous",
                    { delay: formatDelayShort(s.delayValue, s.delayUnit) },
                  );
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional config (no stable id), rendered read-only
              <li key={i} className="flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-semibold text-[10px]",
                    isNext
                      ? "bg-accent text-accent-foreground"
                      : "bg-bg-tertiary text-text-secondary",
                  )}
                >
                  {i + 1}
                </span>
                <span
                  className={
                    isNext ? "text-text-primary" : "text-text-secondary"
                  }
                >
                  {cadence}
                </span>
                {s.assignLabels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary"
                  >
                    <Tag className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                    {label}
                  </span>
                ))}
                {s.resolve && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-success">
                    <CheckCircle2
                      className="h-2.5 w-2.5 shrink-0"
                      aria-hidden="true"
                    />
                    {t(
                      "conversation.followUp.stepResolve",
                      "resolves the conversation",
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {followUp.hours && (
        <div className="flex flex-col gap-0.5 border-border border-t pt-1.5">
          <span className="flex items-center gap-1 font-semibold text-[10px] text-text-muted uppercase tracking-wider">
            <CalendarClock
              className="h-2.5 w-2.5 shrink-0"
              aria-hidden="true"
            />
            {t("conversation.followUp.windowTitle", "Send window")}
          </span>
          {formatHoursWindows(followUp.hours.windows, lang).map((line) => (
            <span key={line} className="text-text-secondary">
              {line}
            </span>
          ))}
          {followUp.hours.exceptionToday && (
            // The weekly grid above is not what today looks like. Said here rather than by rewriting
            // the grid, because the operator still needs to know what the ordinary week is.
            <span className="text-warning">
              {followUp.hours.exceptionToday.ranges.length === 0
                ? t(
                    "conversation.followUp.closedToday",
                    "Closed today ({{label}})",
                    {
                      label:
                        followUp.hours.exceptionToday.label ||
                        followUp.hours.exceptionToday.date,
                    },
                  )
                : t(
                    "conversation.followUp.exceptionToday",
                    "Today only: {{hours}} ({{label}})",
                    {
                      hours: followUp.hours.exceptionToday.ranges
                        .map((r) => `${r.start}–${r.end}`)
                        .join(", "),
                      label:
                        followUp.hours.exceptionToday.label ||
                        followUp.hours.exceptionToday.date,
                    },
                  )}
            </span>
          )}
          <span className="text-[10px] text-text-muted">
            {followUp.hours.timezone}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <div
        className={cn(
          "flex items-center justify-center gap-1.5 text-xs",
          imminent ? "font-medium text-accent" : "text-text-muted",
        )}
      >
        <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </Tooltip>
  );
}

// The WhatsApp→chat redirect owns re-engagement for its two inboxes, so the generic follow-up estimate
// above is suppressed for this conversation (managedByRedirect). Drawn in its place: the next pending
// redirect follow-up (widget side) with a live ETA, or a static "handled by Redirect" note when nothing
// is pending. A tooltip explains why the standard sequence does not run here.
function RedirectFollowUpLine({
  redirectNext,
  lang,
}: {
  redirectNext: NonNullable<ConversationDetail["followUp"]>["redirectNext"];
  lang: string;
}) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(iv);
  }, []);

  let label: string;
  let imminent = false;
  if (redirectNext) {
    const stage =
      redirectNext.stage === "whatsapp"
        ? t("conversation.followUp.redirectStageWhatsapp", "on WhatsApp")
        : t("conversation.followUp.redirectStageChat", "in the chat");
    const deltaSec = (Date.parse(redirectNext.runAt) - Date.now()) / 1000;
    let when: string;
    if (deltaSec <= 0) {
      imminent = true;
      when = t("conversation.followUp.imminent", "any moment now");
    } else if (deltaSec < 60) {
      when = t("conversation.followUp.underMinute", "in under a minute");
    } else {
      when = formatRelativeTime(redirectNext.runAt, lang);
    }
    const at = formatRunAt(redirectNext.runAt, lang);
    label = t(
      "conversation.followUp.redirectScheduled",
      "Redirect follow-up · {{stage}} · {{when}} · {{at}}",
      { stage, when, at },
    );
  } else {
    label = t(
      "conversation.followUp.redirectManaged",
      "Re-engagement handled by Redirect",
    );
  }

  const tooltipContent = (
    <div className="flex flex-col gap-1.5 text-left">
      <span className="font-semibold text-[10px] text-text-muted uppercase tracking-wider">
        {t("conversation.followUp.redirectTitle", "WhatsApp → chat redirect")}
      </span>
      <span className="text-text-secondary">
        {t(
          "conversation.followUp.redirectHint",
          "This conversation's channel is managed by the redirect, so the standard follow-up does not run here. The redirect re-engages the lead across WhatsApp and the website chat.",
        )}
      </span>
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <div
        className={cn(
          "flex items-center justify-center gap-1.5 text-xs",
          imminent ? "font-medium text-accent" : "text-text-muted",
        )}
      >
        <ArrowRightLeft className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </Tooltip>
  );
}

// Pending appointment reminders, drawn at the foot of the timeline next to the follow-up estimate. Shows
// the NEXT reminder (soonest) with its exact run time; a tooltip lists all pending ones. Unlike the
// follow-up, these are armed scheduler jobs (exact times), so there is no "estimate" caveat.
function AppointmentRemindersLine({
  reminders,
  lang,
}: {
  reminders: ConversationDetail["appointmentReminders"];
  lang: string;
}) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(iv);
  }, []);
  const next = reminders[0];
  if (!next) return null;
  const when =
    Date.parse(next.runAt) - Date.now() < 60_000
      ? t("conversation.reminders.imminent", "any moment now")
      : formatRelativeTime(next.runAt, lang);
  const at = formatRunAt(next.runAt, lang);
  const label =
    reminders.length > 1
      ? t(
          "conversation.reminders.scheduledN",
          "Reminder · {{when}} · {{at}} (+{{more}})",
          { when, at, more: reminders.length - 1 },
        )
      : t("conversation.reminders.scheduled", "Reminder · {{when}} · {{at}}", {
          when,
          at,
        });

  const tooltipContent = (
    <div className="flex flex-col gap-1 text-left">
      <span className="font-medium">
        {t("conversation.reminders.title", "Scheduled reminders")}
      </span>
      {reminders.map((r) => (
        <span
          key={`${r.runAt}-${r.offsetHours}`}
          className="text-text-secondary"
        >
          {formatRunAt(r.runAt, lang)}
          {r.offsetHours != null
            ? ` · ${t("conversation.reminders.before", "{{n}}h before", {
                n: r.offsetHours,
              })}`
            : ""}
        </span>
      ))}
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <div className="flex items-center justify-center gap-1.5 text-text-muted text-xs">
        <CalendarClock className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </Tooltip>
  );
}

export function ConversationDetailPage() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const { id = "" } = useParams();
  // Metadata shell (fast) and the message thread (slow, live from Chatwoot) load independently so
  // the page renders immediately and only the messages area spins.
  const [conv, setConv] = useState<ConversationDetail | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesUnavailable, setMessagesUnavailable] = useState(false);
  // Whether the "load older" affordance shows. Driven by the server's hasMoreOlder (a full page ⇒
  // older history likely exists; a partial page ⇒ start reached). Declared here so the foreground
  // message load can seed it before loadOlder is defined.
  const [canLoadOlder, setCanLoadOlder] = useState(true);
  const [busy, setBusy] = useState(false);
  // After returning a conversation to the AI we reveal a "Respond now" action (it can answer the
  // pending tail immediately instead of waiting for the next inbound message). Reset once used.
  const [offerReengage, setOfferReengage] = useState(false);
  const [activity, setActivity] = useState<ActivityState>(null);
  // Safety net to self-clear a live indicator whose "finished" event was lost (socket gap).
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After "finished" with a multi-balloon split, the indicator stays on "delivering" until this
  // timer elapses (the paced balloons land over the webhook→mirror roundtrip, which lags the finish).
  const deliverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coalesce realtime-driven thread refreshes (split delivery emits several events in a burst).
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-scroll: keep pinned to the newest message UNLESS the operator scrolled up to read history.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // One-shot guard for the initial scroll-to-bottom: it must fire exactly once per conversation,
  // after BOTH the metadata (which gates the scroll container's mount) and the first message page
  // have loaded — whichever wins their independent fetch race. Reset when the conversation changes.
  const didInitialScroll = useRef(false);

  // `background` (realtime/post-op refreshes) updates in place: no loading skeleton, and a transient
  // failure keeps the current data instead of blanking the page. Only the first load and explicit
  // retries flip the loading/error states.
  const loadMeta = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background ?? false;
      if (!background) {
        setMetaLoading(true);
        setMetaError(false);
      }
      try {
        const { data, error: err } = await api.api.v1
          .conversations({ id })
          .get();
        if (err || !data) {
          if (!background) setMetaError(true);
          return;
        }
        setConv(data.conversation);
      } catch {
        if (!background) setMetaError(true);
      } finally {
        if (!background) setMetaLoading(false);
      }
    },
    [id],
  );

  // The slow part: keeps its own loading state (first load AND retry). Background refreshes merge by
  // id so unchanged bubbles keep their reference (no flicker). messagesUnavailable comes from the
  // server's graceful-degradation flag.
  const loadMessages = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background ?? false;
      if (!background) setMessagesLoading(true);
      try {
        const { data, error: err } = await api.api.v1
          .conversations({ id })
          .messages.get();
        if (err || !data) {
          if (!background) {
            setMessages([]);
            setMessagesUnavailable(true);
          }
          return;
        }
        setMessages((cur) => unionMessages(cur, data.messages));
        setMessagesUnavailable(data.messagesUnavailable);
        // Seed the "load older" affordance from the latest page only on a foreground load; a
        // background (realtime) refresh must not reset paging state the operator already advanced.
        if (!background) setCanLoadOlder(data.hasMoreOlder);
      } catch {
        if (!background) {
          setMessages([]);
          setMessagesUnavailable(true);
        }
      } finally {
        if (!background) setMessagesLoading(false);
      }
    },
    [id],
  );

  // "Load older": page backwards (?before=<oldest loaded message id>) and prepend, preserving the
  // scroll position so the view doesn't jump. canLoadOlder turns off once a page brings nothing new
  // older (start of history reached or fork returned an empty page).
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderInFlight = useRef(false);
  // Captured just before a prepend so the post-render layout effect can restore the visual position.
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);

  const loadOlder = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || olderInFlight.current) return;
    let oldest: number | null = null;
    for (const m of messages) {
      if (m.id != null && (oldest == null || m.id < oldest)) oldest = m.id;
    }
    if (oldest == null) return;
    olderInFlight.current = true;
    setLoadingOlder(true);
    prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      const { data, error: err } = await api.api.v1
        .conversations({ id })
        .messages.get({ query: { before: String(oldest) } });
      if (err || !data) return;
      const hasOlder = data.messages.some(
        (m) => m.id != null && m.id < (oldest as number),
      );
      if (!hasOlder) {
        setCanLoadOlder(false);
        prependAnchor.current = null;
        return;
      }
      setMessages((cur) => unionMessages(cur, data.messages));
      // A full older page means there is likely still more before it; a partial one is the start.
      setCanLoadOlder(data.hasMoreOlder);
    } catch {
      // Keep canLoadOlder true so the operator can retry by scrolling again.
      prependAnchor.current = null;
    } finally {
      olderInFlight.current = false;
      setLoadingOlder(false);
    }
  }, [id, messages]);

  // Apply an activity label now and (re)arm the stuck-clear safety net. No minimum-display throttle:
  // fast tools leave a persistent trail marker, so the live bubble may switch immediately.
  const commitActivity = useCallback((next: ActivityState) => {
    setActivity(next);
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
    if (next) {
      // The runtime emits "finished" in a finally; a stuck indicator means the socket dropped.
      stuckTimer.current = setTimeout(
        () => setActivity(null),
        ACTIVITY_STUCK_MS,
      );
    } else {
      stuckTimer.current = null;
    }
  }, []);

  // Reset thread state when navigating between conversations, so unionMessages never blends two
  // threads and the "load older" affordance starts fresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: id is the reset trigger, not a read.
  useEffect(() => {
    setMessages([]);
    setCanLoadOlder(true);
    stickToBottom.current = true;
    didInitialScroll.current = false;
  }, [id]);

  useEffect(() => {
    void loadMeta();
    void loadMessages();
  }, [loadMeta, loadMessages]);

  // Live updates: refetch when this conversation changes upstream; drive the
  // typing indicator from the agent's live graph progress.
  useTenantEvents({
    onConversation: (event) => {
      if (event.conversationId !== id) return;
      // Coalesce a burst of events into one in-place background refresh (no skeleton flash).
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void loadMeta({ background: true });
        void loadMessages({ background: true });
      }, 250);
    },
    onAgentActivity: (event) => {
      if (event.conversationId !== id) return;
      if (deliverTimer.current) {
        clearTimeout(deliverTimer.current);
        deliverTimer.current = null;
      }
      if (event.phase === "finished") {
        // A multi-balloon split keeps the indicator on "delivering" until the paced balloons land
        // (they arrive AFTER finish, over the webhook→mirror roundtrip), else clear immediately.
        if (event.balloons != null && event.balloons > 1) {
          commitActivity({ stage: "delivering", tool: null });
          deliverTimer.current = setTimeout(
            () => {
              deliverTimer.current = null;
              setActivity(null);
            },
            Math.min(event.balloons * 3000, 12_000),
          );
        } else {
          commitActivity(null);
        }
        // Pull the fresh trail markers + follow-up estimate now the turn is done.
        void loadMeta({ background: true });
        return;
      }
      commitActivity({
        stage: event.stage,
        tool: event.tool,
        runAt: event.runAt ?? null,
      });
    },
  });

  // Time-based fields (the follow-up estimate) drift between webhook events; a light periodic
  // background refresh of the metadata keeps them current without a skeleton flash.
  useEffect(() => {
    const iv = setInterval(() => void loadMeta({ background: true }), 45_000);
    return () => clearInterval(iv);
  }, [loadMeta]);

  // Clear all transient timers on unmount so none fire into a dead component.
  useEffect(() => {
    return () => {
      if (stuckTimer.current) clearTimeout(stuckTimer.current);
      if (deliverTimer.current) clearTimeout(deliverTimer.current);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  // Pin to the newest message when the thread or activity changes, unless the operator scrolled up.
  // useLayoutEffect (not useEffect) so the pin lands in the same paint as the new content. When a
  // "load older" prepend just happened, restore the prior visual position instead (the content above
  // grew, so keep the same messages under the viewport rather than jumping).
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/activity are scroll triggers, not reads.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = prependAnchor.current;
    if (anchor) {
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      prependAnchor.current = null;
      return;
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  // Initial scroll-to-bottom, race-proof. The scroll container only mounts once the metadata (conv)
  // has loaded, but the auto-pin effect above keys off `messages`; when the message fetch WINS the
  // race against the metadata fetch, `messages` is already set by the time the container mounts, so
  // that effect never re-fires and the thread opens scrolled to the top. This one-shot waits for BOTH
  // loads to finish (container present + messages in the DOM) and pins once, in whichever order they
  // complete. useLayoutEffect so the pin lands before paint. Resets per conversation (didInitialScroll).
  useLayoutEffect(() => {
    if (didInitialScroll.current) return;
    if (metaLoading || messagesLoading) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    didInitialScroll.current = true;
  }, [metaLoading, messagesLoading]);

  // Late-loading media (images/audio) grows a bubble AFTER its message arrives, so a one-shot pin lands
  // short. A ResizeObserver on the scroll container + its children re-pins to the bottom as content
  // grows, but only while the operator hasn't scrolled up (stickToBottom). Re-attached when the thread
  // changes so it always observes the current bubbles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the re-attach trigger, not a read.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [messages]);

  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Re-arm auto-scroll only while near the bottom; reading older messages suspends it.
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Near the top → page older history in (preserving scroll position via prependAnchor).
    if (el.scrollTop < 120 && canLoadOlder && !olderInFlight.current) {
      void loadOlder();
    }
  }

  // Interleave the message thread with the activity trail (tool calls / follow-up sends) by time.
  const timeline = useMemo(
    () =>
      buildTimeline(
        messages,
        conv?.trail ?? [],
        conv?.followUp?.totalSteps ?? 0,
      ),
    [messages, conv?.trail, conv?.followUp?.totalSteps],
  );
  // Resolve a reply's quoted message (item 11): map id → message, so a bubble that quotes another can
  // show a WhatsApp-style preview when the referenced message is in the loaded window.
  const messagesById = useMemo(() => {
    const map = new Map<number, Message>();
    for (const m of messages) if (m.id != null) map.set(m.id, m);
    return map;
  }, [messages]);
  // The follow-up sequence has finished firing (a follow-up went out and nothing is pending). The
  // "complete" marker is drawn inline after the last follow-up bubble; only when that bubble couldn't be
  // matched (e.g. older than the loaded window) does it fall back to the foot.
  const followUpComplete =
    conv?.followUp?.enabled === true &&
    conv.followUp.managedByRedirect !== true &&
    conv.followUp.lastFollowUpAt != null &&
    conv.followUp.nextStep == null &&
    // NOTE: a paused sequence also has no next step, and it is not complete — it resumes once the
    // appointment passes. Neither is a sequence with a step still queued that the handler is going to
    // drop (a human took the conversation, the agent was disabled, follow-up was switched off):
    // nothing is pending, but nothing completed either.
    conv.followUp.pausedByAppointment !== true &&
    conv.followUp.abandoned !== true;

  // Caller passes the already-translated success message (static t() at the call
  // site, so the extractor sees the key).
  async function runOp(
    op: () => Promise<{ error: unknown }>,
    successMsg: string,
  ) {
    setBusy(true);
    try {
      const { error: err } = await op();
      if (err) throw err;
      showToast(successMsg, "success");
      void loadMeta({ background: true });
      void loadMessages({ background: true });
    } catch (e) {
      showToast(
        apiErrorMessage(e) || t("conversation.opError", "Action failed."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Return the conversation to the AI (unassign + pending), then reveal "Respond now" so the operator
  // can have it answer immediately rather than only on the next inbound message.
  async function returnToAi(successMsg: string) {
    setBusy(true);
    try {
      const { data, error: err } = await api.api.v1
        .conversations({ id })
        .return.post();
      if (err || !data) throw err ?? new Error("return failed");
      // The call succeeds either way — the status was set and the mirror corrected — so `error` alone
      // cannot tell the two apart. "taken-over" means a human claimed the conversation during the
      // request and still holds it, and the success toast would say the opposite of what the row now
      // reads. `reengage` below already branches on its outcome for the same reason.
      if (data.outcome === "taken-over") {
        showToast(
          t(
            "conversation.returnTakenOver",
            "Someone took the conversation while it was being returned, so it stays with them.",
          ),
          "warning",
        );
        // Set FALSE, not merely left unset. The offer is page state that survives the action that
        // raised it, so an earlier successful return leaves it standing and the button is still on
        // screen — and the server does set the status to `pending` here, so nothing else takes it
        // down. Omitting the write reads as "do not offer" and means "keep whatever was offered".
        setOfferReengage(false);
      } else {
        showToast(successMsg, "success");
        setOfferReengage(true);
      }
      void loadMeta();
      void loadMessages();
    } catch (e) {
      showToast(
        apiErrorMessage(e) || t("conversation.opError", "Action failed."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Re-engage (item 6): re-fire the agent turn over the unanswered tail, without waiting for a new
  // customer message. Toast reflects the outcome (posted / gate held by a human / contact not
  // authorized / nothing to answer).
  async function reengage() {
    setOfferReengage(false);
    setBusy(true);
    try {
      const { data, error: err } = await api.api.v1
        .conversations({ id })
        .reengage.post();
      if (err || !data) throw err ?? new Error("reengage failed");
      if (data.outcome === "posted") {
        showToast(
          t("conversation.reengage.posted", "The AI replied."),
          "success",
        );
      } else if (data.outcome === "gate-closed") {
        showToast(
          t(
            "conversation.reengage.gateClosed",
            "A human owns this conversation; return it to the AI first.",
          ),
          "warning",
        );
      } else if (data.outcome === "not-authorized") {
        showToast(
          t(
            "conversation.reengage.notAuthorized",
            "The authorization endpoint did not clear this contact, so the AI did not reply.",
          ),
          "warning",
        );
      } else if (data.outcome === "empty") {
        showToast(
          t("conversation.reengage.empty", "Nothing new to answer."),
          "info",
        );
      } else {
        showToast(
          t("conversation.reengage.noReply", "The AI produced no reply."),
          "info",
        );
      }
      void loadMeta({ background: true });
      void loadMessages({ background: true });
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("conversation.reengage.error", "Re-engage failed."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Who HOLDS the conversation, answered by the server. Not `assigneeType === "User"`: a conversation
  // assigned to ANOTHER persona's agent bot is equally out of this agent's hands — the ownership gate
  // compares the bot id — and the browser has no way to make that comparison. `isHuman` stays for the
  // places that genuinely mean a person (the header's assignee line).
  const heldByOther = conv?.heldByAnotherParty === true;
  const isHuman = conv?.assigneeType === "User";
  // Deep link to this conversation in the operator's Chatwoot (build from the instance origin/account).
  const chatwootUrl = conv
    ? `${conv.chatwootBaseUrl}/app/accounts/${conv.accountId}/conversations/${conv.chatwootConversationId}`
    : null;

  return (
    <PageContainer size="wide" className="flex h-full min-h-0 flex-col gap-4">
      <Link
        to="/conversations"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("conversation.back", "Back to conversations")}
      </Link>

      <DataBoundary
        loading={metaLoading}
        error={metaError || !conv}
        onRetry={loadMeta}
        errorLabel={t("conversation.error", "Could not load the conversation.")}
      >
        {conv && (
          <>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate font-semibold text-lg text-text-primary">
                    {conv.contact?.name ??
                      t("conversations.unknownContact", "Unknown contact")}
                  </h1>
                  <Badge variant={STATUS_VARIANT[conv.status] ?? "secondary"}>
                    {/* biome-ignore lint/plugin/no-dynamic-i18n-key: status keys extracted in ConversationsPage */}
                    {t(`conversations.status.${conv.status}`, conv.status)}
                  </Badge>
                  {conv.agentMode === "test" && (
                    <TestModeBadge
                      state={conv.testActivatedAt ? "active" : "waiting"}
                    />
                  )}
                  {conv.outOfHours && <OutOfHoursBadge />}
                </div>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-muted">
                  {isHuman ? (
                    <>
                      <User className="h-3.5 w-3.5" aria-hidden="true" />
                      {conv.assigneeName ??
                        t("conversations.assignee.human", "Human #{{id}}", {
                          id: conv.assigneeId ?? "?",
                        })}
                    </>
                  ) : (
                    <>
                      <Bot
                        className="h-3.5 w-3.5 text-accent"
                        aria-hidden="true"
                      />
                      {conv.agentName ?? t("conversations.assignee.ai", "AI")}
                    </>
                  )}
                  {conv.inbox?.name ? ` · ${conv.inbox.name}` : ""}
                  {!isHuman && conv.agentModel ? (
                    <span className="inline-flex items-center gap-1 rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                      {conv.agentModel}
                    </span>
                  ) : null}
                </p>
                {conv.contact && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs">
                    <span
                      className={cn("h-2 w-2 shrink-0 rounded-full", {
                        "bg-success": conv.contact.voiceReply === true,
                        "bg-info": conv.contact.voiceReply === false,
                        "bg-text-muted": conv.contact.voiceReply == null,
                      })}
                      aria-hidden="true"
                    />
                    {conv.contact.voiceReply === true ? (
                      <>
                        <Volume2
                          className="h-3.5 w-3.5 text-success"
                          aria-hidden="true"
                        />
                        <span className="text-text-secondary">
                          {t(
                            "conversation.voicePref.audio",
                            "Prefers audio replies",
                          )}
                        </span>
                      </>
                    ) : conv.contact.voiceReply === false ? (
                      <>
                        <Type
                          className="h-3.5 w-3.5 text-info"
                          aria-hidden="true"
                        />
                        <span className="text-text-secondary">
                          {t(
                            "conversation.voicePref.text",
                            "Prefers text replies",
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="text-text-muted">
                        {t(
                          "conversation.voicePref.none",
                          "No audio preference set",
                        )}
                      </span>
                    )}
                  </p>
                )}
              </div>
              {/* Actions + navigation. Below lg: one wrapping row (item 12) — below sm they stack
                  full-width; at sm+ they flow right-aligned and wrap as the width shrinks. The two
                  inner groups are `contents` here, so they vanish from layout and the buttons flow
                  flat exactly as before. At lg+ the outer turns into a right-aligned column and each
                  group becomes its own row: line 1 = status actions, line 2 = the links (item 4).
                  Status IS the AI on/off signal (pending = AI handling, open/snoozed = a human owns
                  it, resolved = closed). "Configure agent" stays last so it sits at the right edge. */}
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end lg:flex-col lg:flex-nowrap lg:items-end lg:gap-2">
                <div className="contents lg:flex lg:flex-row lg:flex-wrap lg:items-center lg:justify-end lg:gap-2">
                  {/* Who HOLDS it, not what the status says. `pending` is the AI's state and also
                      the state a takeover leaves behind — the hand-back sets it and then finds a
                      person there — so keying these two buttons on status alone offered "handoff to
                      human" on a conversation a human already had, and hid "Return to AI" on the one
                      conversation that needed it. That is the shape of the bug this whole change is
                      about, reappearing in the console. */}
                  {conv.status === "pending" && !heldByOther && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        runOp(
                          () =>
                            api.api.v1.conversations({ id }).handoff.post({}),
                          t("conversation.handedOff", "Handed off to a human."),
                        )
                      }
                    >
                      <UserCheck className="h-4 w-4" aria-hidden="true" />
                      {t("conversation.handoff", "Handoff to human")}
                    </Button>
                  )}
                  {conv.status === "resolved" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        returnToAi(
                          t("conversation.reopened", "Reopened for the AI."),
                        )
                      }
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      {t("conversation.reopen", "Reopen")}
                    </Button>
                  )}
                  {/* `resolved` is excluded on BOTH sides: "Reopen" above already runs this exact
                      operation, so letting the holder clause add "Return to AI" there rendered two
                      differently labelled buttons for one action. Reopen is the right label for a
                      closed conversation whoever holds it, so it keeps that state alone. */}
                  {conv.status !== "resolved" &&
                    (heldByOther || conv.status !== "pending") && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          returnToAi(
                            t("conversation.returned", "Returned to the AI."),
                          )
                        }
                      >
                        <Bot className="h-4 w-4" aria-hidden="true" />
                        {t("conversation.returnToAi", "Return to AI")}
                      </Button>
                    )}
                  {offerReengage &&
                    conv.status === "pending" &&
                    !heldByOther && (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={reengage}
                      >
                        <Sparkles className="h-4 w-4" aria-hidden="true" />
                        {t("conversation.respondNow", "Respond now")}
                      </Button>
                    )}
                  {conv.status !== "resolved" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        runOp(
                          () =>
                            api.api.v1
                              .conversations({ id })
                              .status.post({ status: "resolved" }),
                          t("conversation.resolved", "Conversation resolved."),
                        )
                      }
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      {t("conversation.resolve", "Resolve")}
                    </Button>
                  )}
                </div>
                <div className="contents lg:flex lg:flex-row lg:flex-wrap lg:items-center lg:justify-end lg:gap-2">
                  <Link
                    to={`/logs?conversationId=${id}`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  >
                    <ScrollText className="h-4 w-4" aria-hidden="true" />
                    {t("conversation.viewLogs", "View logs")}
                  </Link>
                  {chatwootUrl && (
                    <a
                      href={chatwootUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    >
                      <ExternalLink className="h-4 w-4" aria-hidden="true" />
                      {t("conversation.openInChatwoot", "Open in Chatwoot")}
                    </a>
                  )}
                  {conv.agentId && (
                    <Link
                      to={`/agents/${conv.agentId}/general?from=/conversations/${id}`}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Settings className="h-4 w-4" aria-hidden="true" />
                      {t("conversation.configureAgent", "Configure agent")}
                    </Link>
                  )}
                </div>
              </div>
            </Card>

            {conv.lastError && (
              <Card className="flex flex-wrap items-center justify-between gap-3 border-warning/40 bg-warning-soft">
                <div className="flex min-w-0 items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-text-primary">
                      {t(
                        "conversation.reengage.failedTitle",
                        "The AI couldn't finish its last turn",
                      )}
                    </p>
                    <p className="mt-0.5 break-words text-text-muted text-xs">
                      {conv.lastError}
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={reengage}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  {t("conversation.reengage.action", "Re-engage")}
                </Button>
              </Card>
            )}

            <div
              ref={scrollRef}
              onScroll={onMessagesScroll}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-bg-secondary p-6"
            >
              {messagesLoading ? (
                <div className="flex flex-col gap-3" role="status">
                  <span className="sr-only">
                    {t("conversation.loadingMessages", "Loading messages…")}
                  </span>
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl bg-bg-tertiary/40 px-3 py-2">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="mt-1.5 h-3.5 w-48" />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl bg-accent/10 px-3 py-2">
                      <Skeleton className="h-3.5 w-32" />
                    </div>
                  </div>
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-2xl bg-bg-tertiary/40 px-3 py-2">
                      <Skeleton className="h-3.5 w-56" />
                      <Skeleton className="mt-1.5 h-3.5 w-40" />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-2xl bg-accent/10 px-3 py-2">
                      <Skeleton className="h-3.5 w-44" />
                    </div>
                  </div>
                </div>
              ) : messagesUnavailable ? (
                // The live Chatwoot thread is unreachable, but the activity trail is OUR data
                // (execution_logs) — still show it (incl. tool errors) below a non-blocking retry
                // notice, instead of hiding the whole timeline.
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col items-center gap-3 py-6 text-center">
                    <p className="text-sm text-text-muted">
                      {t(
                        "conversation.messagesUnavailable",
                        "Couldn't load the messages from Chatwoot.",
                      )}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => loadMessages()}
                    >
                      {t("conversation.retry", "Retry")}
                    </Button>
                  </div>
                  {timeline.items.map((item) =>
                    item.kind !== "message" ? (
                      <TrailMarker key={item.key} entry={item.entry} />
                    ) : null,
                  )}
                </div>
              ) : timeline.items.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-muted">
                  {t("conversation.noMessages", "No messages yet.")}
                </p>
              ) : (
                <>
                  {canLoadOlder && (
                    <div className="flex justify-center py-1">
                      <button
                        type="button"
                        onClick={() => void loadOlder()}
                        disabled={loadingOlder}
                        className="rounded-full border border-border px-3 py-1 text-text-muted text-xs hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-60"
                      >
                        {loadingOlder
                          ? t(
                              "conversation.loadingOlder",
                              "Loading older messages…",
                            )
                          : t("conversation.loadOlder", "Load older messages")}
                      </button>
                    </div>
                  )}
                  {timeline.items.map((item) => {
                    if (item.kind !== "message") {
                      return <TrailMarker key={item.key} entry={item.entry} />;
                    }
                    const qm =
                      item.m.inReplyTo != null
                        ? messagesById.get(item.m.inReplyTo)
                        : undefined;
                    const quotedText = qm
                      ? qm.content?.trim() ||
                        (qm.attachments?.length
                          ? t("conversation.quotedAttachment", "Attachment")
                          : null) ||
                        null
                      : null;
                    const quotedLabel = qm
                      ? (qm.senderName ??
                        (qm.messageType === 1
                          ? t("conversation.quotedAgent", "Agent")
                          : t("conversation.quotedCustomer", "Customer")))
                      : null;
                    return (
                      <Fragment key={item.key}>
                        <MessageBubbleMemo
                          m={item.m}
                          convId={id}
                          quotedText={quotedText}
                          quotedLabel={quotedLabel}
                          followUpBadge={timeline.followUpBadges.get(item.key)}
                        />
                        {followUpComplete &&
                          item.key === timeline.lastFollowUpKey && (
                            <FollowUpComplete />
                          )}
                      </Fragment>
                    );
                  })}
                </>
              )}
              {/* Foot: the forward-looking estimate, and the "complete" marker only as a fallback when
                  its follow-up bubble wasn't in the loaded window (else it renders inline above). */}
              {conv.appointmentReminders.length > 0 && (
                <AppointmentRemindersLine
                  reminders={conv.appointmentReminders}
                  lang={i18n.language}
                />
              )}
              {conv.followUp?.managedByRedirect ? (
                <RedirectFollowUpLine
                  redirectNext={conv.followUp.redirectNext}
                  lang={i18n.language}
                />
              ) : (
                conv.followUp?.enabled && (
                  <FollowUpLine followUp={conv.followUp} lang={i18n.language} />
                )
              )}
              {followUpComplete && timeline.lastFollowUpKey == null && (
                <FollowUpComplete />
              )}
              {activity && <AgentActivityIndicator activity={activity} />}
            </div>
          </>
        )}
      </DataBoundary>
    </PageContainer>
  );
}
