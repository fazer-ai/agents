import type { TFunction } from "i18next";
import type { api } from "@/client/lib/api";

// The conversation page's timeline: the message thread and the activity trail merged in time order,
// and the proactive bubbles badged with where they came from. Pure, so it is tested without the page.

type MetaResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.conversations>["get"]>
>;
type ConversationDetail = NonNullable<MetaResp["data"]>["conversation"];
type MessagesResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.conversations>["messages"]["get"]>
>;
export type Message = NonNullable<MessagesResp["data"]>["messages"][number];
export type TrailEntry = NonNullable<ConversationDetail>["trail"][number];
export type TurnUsageEntry =
  NonNullable<ConversationDetail>["usage"]["turns"][number];

// What a proactive bubble says about where it came from: an inactivity follow-up (with its step), a
// channel-redirect follow-up, or an inbound integration's event, named when the integration still
// exists.
export type FollowUpBadgeInfo = {
  kind: "followup" | "redirect" | "event" | "approval";
  step: number | null;
  total: number;
  integrationName: string | null;
};

// The words on a proactive bubble. `t` is passed in so this stays pure; the page hands it
// `useTranslation`'s, and a test hands it the defaults.
export function followUpBadgeText(b: FollowUpBadgeInfo, t: TFunction): string {
  if (b.kind === "event") {
    return b.integrationName
      ? t("conversation.followUp.badgeEvent", "Event: {{name}}", {
          name: b.integrationName,
        })
      : t("conversation.followUp.badgeEventUnnamed", "External event");
  }
  if (b.kind === "approval") {
    return t("conversation.followUp.badgeApproval", "Approved document");
  }
  if (b.kind === "redirect") {
    return t("conversation.followUp.badgeRedirect", "Redirect follow-up");
  }
  return b.step != null
    ? t("conversation.followUp.badgeN", "Follow-up {{step}}/{{total}}", {
        step: b.step,
        total: b.total,
      })
    : t("conversation.followUp.badge", "Follow-up");
}

// Merge the message thread and the activity trail into one time-ordered timeline. Messages carry a
// unix-seconds createdAt; trail markers an ISO `at`. A message with no timestamp (system/activity
// line) inherits the previous item's time so it keeps its place instead of jumping to the top. `seq`
// is a stable tiebreaker for equal timestamps.
export type TimelineItem =
  | { kind: "message"; at: number; seq: number; key: string; m: Message }
  | { kind: "trail"; at: number; seq: number; key: string; entry: TrailEntry }
  | {
      kind: "usage";
      at: number;
      seq: number;
      key: string;
      turn: TurnUsageEntry;
    };

export type Timeline = {
  items: TimelineItem[];
  // message key → the follow-up badge to stamp on that outgoing bubble.
  followUpBadges: Map<string, FollowUpBadgeInfo>;
  // the key of the LAST (latest) follow-up bubble, where the "sequence complete" line anchors.
  lastFollowUpKey: string | null;
  // message key → the turn whose usage sits at the foot of that bubble: the last loaded message among
  // the ones the turn created.
  usageOnMessage: Map<string, TurnUsageEntry>;
};

export function messageKey(m: Message, i: number): string {
  return m.id != null ? `m-${m.id}` : `m-idx-${i}`;
}

export function buildTimeline(
  messages: Message[],
  trail: TrailEntry[],
  totalSteps: number,
  turnUsage: TurnUsageEntry[] = [],
  // Whether the thread has older messages still to page in.
  olderPending = false,
): Timeline {
  // A proactive send whose bubble can be found draws no trail line: the bubble carries a badge
  // instead; one whose bubble cannot be found keeps a marker, so nothing is lost. A line that recorded
  // the Chatwoot id of the message it sent badges only that message (none if it sent none). A line
  // with no recorded id falls back to a guess: the first unclaimed outgoing message from five seconds
  // before the line to five minutes after.
  const badgeable = (e: TrailEntry) =>
    e.kind === "followup" ||
    e.kind === "redirect" ||
    e.kind === "event" ||
    e.kind === "approval";
  const followUpEntries = trail.filter(badgeable);
  const otherEntries = trail.filter((e) => !badgeable(e));
  const followUpBadges = new Map<string, FollowUpBadgeInfo>();
  const claimed = new Set<number>();
  const matched: { key: string; at: number }[] = [];
  const unmatched: TrailEntry[] = [];
  const sortedFollowUps = [...followUpEntries].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  // Every id a recorded entry names is reserved before an unrecorded line guesses, so a
  // guess's time window cannot take the bubble a recorded line names.
  const reserved = new Set(
    followUpEntries.flatMap((e) =>
      e.originRecorded && e.messageId != null ? [e.messageId] : [],
    ),
  );
  for (const f of sortedFollowUps) {
    let bestIdx = -1;
    if (f.originRecorded) {
      if (f.messageId != null) {
        bestIdx = messages.findIndex(
          (m, i) => !claimed.has(i) && m.id === f.messageId,
        );
      }
    } else {
      const fAt = Date.parse(f.at);
      for (let i = 0; i < messages.length; i++) {
        if (claimed.has(i)) continue;
        const m = messages[i];
        if (m?.messageType !== 1 || m.createdAt == null) continue;
        if (m.id != null && reserved.has(m.id)) continue;
        const mAt = m.createdAt * 1000;
        // The reply lands at or shortly after the generate log (small back-tolerance for clock skew).
        if (mAt >= fAt - 5_000 && mAt <= fAt + 300_000) {
          bestIdx = i;
          break;
        }
      }
    }
    const m = bestIdx === -1 ? undefined : messages[bestIdx];
    if (!m) {
      unmatched.push(f);
      continue;
    }
    claimed.add(bestIdx);
    const key = messageKey(m, bestIdx);
    const kind = f.kind as FollowUpBadgeInfo["kind"];
    followUpBadges.set(key, {
      kind,
      step: f.step,
      total: totalSteps,
      integrationName: f.integrationName,
    });
    // Only the inactivity sequence has a "complete" line to anchor.
    if (kind === "followup") {
      matched.push({ key, at: (m.createdAt ?? 0) * 1000 });
    }
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
  // What each turn spent sits at the foot of the last message the turn created that is on
  // screen; a turn with none (silent, messages not loaded or never recorded) keeps its own line at the
  // time of its last billed call, so the header's total stays accounted for. While older messages are
  // still to page in, a line older than the oldest loaded message waits for them rather than stacking
  // above the first bubble; with the whole thread loaded every line shows.
  const keyById = new Map<number, string>();
  messages.forEach((m, i) => {
    if (m.id != null) keyById.set(m.id, messageKey(m, i));
  });
  const usageOnMessage = new Map<string, TurnUsageEntry>();
  const unplaced: TurnUsageEntry[] = [];
  for (const u of turnUsage) {
    const key = [...u.messageIds]
      .reverse()
      .map((id) => keyById.get(id))
      .find((k) => k !== undefined);
    if (key && !usageOnMessage.has(key)) usageOnMessage.set(key, u);
    else unplaced.push(u);
  }
  const oldest = messages.reduce<number | null>(
    (min, m) =>
      m.createdAt == null
        ? min
        : min === null
          ? m.createdAt * 1000
          : Math.min(min, m.createdAt * 1000),
    null,
  );
  unplaced.forEach((u, i) => {
    const at = Date.parse(u.at);
    if (olderPending && oldest !== null && at < oldest) return;
    items.push({
      kind: "usage",
      at,
      seq: messages.length + trail.length + i,
      key: `u-${u.turnId}`,
      turn: u,
    });
  });
  items.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return { items, followUpBadges, lastFollowUpKey, usageOnMessage };
}
