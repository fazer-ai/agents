import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import type { ChannelRedirectConfig } from "./service";

// Test-mode activation is a property of the PERSON being served, not of a channel: `/teste` means
// "this is me, testing", and that does not stop being true because the lead followed a link from
// WhatsApp into the website chat. A redirect episode is two conversations of one contact
// (`service.ts`'s header), so the stamp `/teste` writes on one row answers for an episode whose other
// half it does not hold.
//
// The bridge that exists today runs ONCE, at link time, in ONE direction (`shouldPropagateTestMode`,
// WhatsApp → widget). Every activation outside that instant leaves the two halves disagreeing, and
// each reader then judges by whichever row it happened to load: the ladder messages the WhatsApp
// conversation while asking the widget row, the reactive gate silences a chat whose sibling is
// activated, and `/reset` refuses to run from the unstamped side.
//
// So the question every one of them asks is the EPISODE's, and this module answers it.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Which half of a redirect episode a conversation is, read from its inbox. `null` means the
// conversation is not part of one — the episode question does not arise, and nothing is looked up.
//
// Pure, and the gate for everything below: a deployment with the feature off, or an inbox that is
// neither side, never pays for a sibling read.
export function redirectSide(
  cfg: ChannelRedirectConfig,
  chatwootInboxId: number | null,
): "entry" | "widget" | null {
  if (!cfg.enabled || chatwootInboxId === null) return null;
  if (cfg.entryInboxId !== null && cfg.entryInboxId === chatwootInboxId)
    return "entry";
  if (cfg.widgetInboxId !== null && cfg.widgetInboxId === chatwootInboxId)
    return "widget";
  return null;
}

export interface EpisodeLookupInputs {
  // Agent.mode — a production agent is never silenced, so it never asks.
  agentMode: string;
  // The stamp on the conversation the caller already has in hand.
  ownTestActivatedAt: Date | null;
  // Which half of an episode that conversation is; null = not part of one.
  side: "entry" | "widget" | null;
}

// Pure: whether the sibling has to be read at all. Three ways to answer without touching the
// database, and each one carries a real call site — the reactive gate runs on EVERY inbound message,
// so this predicate is what keeps that path free:
//
//   - a production agent has no activation question;
//   - a row already stamped IS the answer, whatever the sibling says (the episode is activated as
//     soon as either half is, so a stamped row can never be overturned);
//   - a conversation outside a redirect episode has no sibling to ask.
export function needsEpisodeLookup(s: EpisodeLookupInputs): boolean {
  return (
    s.agentMode === "test" && s.ownTestActivatedAt === null && s.side !== null
  );
}

export interface EpisodeActivationParams {
  tenantId: bigint;
  instanceId: bigint;
  cfg: ChannelRedirectConfig;
  agentMode: string;
  conv: {
    // The conversation the caller holds: its own stamp, its contact, and the inbox that says which
    // half of the episode it is.
    testActivatedAt: Date | null;
    contactId: bigint | null;
    chatwootInboxId: number | null;
  };
  base: PrismaClient;
  // The caller's connection when it has one. Same rule the ladder's fences follow: asked from inside
  // a thread claim, a second connection would stall on an exhausted pool while the advisory lock is
  // held, and DB_POOL_MAX=1 is a supported setting.
  scoped?: ScopedDb;
}

// The episode's activation stamp: this conversation's own, or — when it has none — its redirect
// sibling's. Returns null when the episode is not activated anywhere, which is the answer
// `isTestSilenced` already knows how to read, so every call site keeps the predicate it had.
//
// The sibling is the same contact's conversation on the OTHER side's inbox. That is the same pairing
// the ladder already uses to pick its destination (#222 covers what is wrong with it): this read
// makes no new assumption, it asks about the rows the callers were already acting on.
//
// A sibling read that fails falls back to the row's own answer — which, by the guard above, is null.
// So an unreadable sibling reads as "not activated" and the agent stays quiet. That is the OPPOSITE
// direction from the ladder's liveness fence, which fails open, and deliberately: there the cost of
// an unknown is a follow-up the customer should have received, here it is a test agent messaging a
// real lead. Silence is the safe failure for this question and only this one.
export async function episodeTestActivatedAt(
  p: EpisodeActivationParams,
): Promise<Date | null> {
  const side = redirectSide(p.cfg, p.conv.chatwootInboxId);
  if (
    !needsEpisodeLookup({
      agentMode: p.agentMode,
      ownTestActivatedAt: p.conv.testActivatedAt,
      side,
    })
  )
    return p.conv.testActivatedAt;
  if (p.conv.contactId === null) return null;
  const siblingInboxId =
    side === "widget" ? p.cfg.entryInboxId : p.cfg.widgetInboxId;
  if (siblingInboxId === null) return null;
  const read = (db: ScopedDb) =>
    db.conversation.findFirst({
      where: {
        contactId: p.conv.contactId,
        chatwootInstanceId: p.instanceId,
        inbox: { chatwootInboxId: siblingInboxId },
      },
      select: { testActivatedAt: true },
      // The activated sibling FIRST, so a contact with several conversations on that inbox cannot
      // hide the activation behind a newer unstamped one. Ordering, not filtering: `testActivatedAt`
      // is the answer, and asking for the greatest of them is the episode's answer whichever row
      // carries it.
      orderBy: { testActivatedAt: { sort: "desc", nulls: "last" } },
    });
  const sibling = await (p.scoped
    ? read(p.scoped)
    : runScopedOn(p.base, sysCtx(p.tenantId), read)
  ).catch((err: unknown) => {
    logger.warn(
      "channel-redirect: could not read the episode sibling's activation (contact=%s): %s",
      String(p.conv.contactId),
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });
  return sibling?.testActivatedAt ?? null;
}

// ── the episode's other half ──────────────────────────────────────────────────────────────────────

// WHICH conversation is the WhatsApp entry half of a widget conversation's episode. Two callers ask
// it — the cross-link (to post the pair of notes) and the follow-up ladder (to re-send the link and,
// at the closing stage, to RESOLVE that conversation) — and until #222 each answered it on its own by
// taking the contact's most-recently-active conversation on the entry inbox.
//
// That predicate is wrong, and so were the four others written before it: activity is not the funnel
// (writing into an old entry conversation makes it the latest); the most recent `redirectSentAt` can
// name a link that was never clicked while an older unconsumed one still is; `/reset` clears that
// anchor without revoking the link it already sent; and uniqueness on the inbox proves uniqueness,
// not origin. Each is an inference about an event this side never observes, and the consumers act on
// it destructively.
//
// So the answer is read, not inferred: the fork's token resolve writes the origin onto the widget
// conversation at the one moment both halves are known together, and it reaches us on the webhook
// payload. `redirectOriginDisplayId` IS the answer whenever it is there.
//
// The old predicate stays as the fallback, for the two populations that have no stored answer and
// never will: episodes that began before the fork carried the field, and instances running a Chatwoot
// that does not send it. It is not a second opinion — it is only consulted when there is no fact.
export interface EpisodeOriginParams {
  tenantId: bigint;
  instanceId: bigint;
  entryInboxId: number;
  widget: {
    // The widget conversation's stored pairing, straight off the mirror. Non-null ⇒ this is the answer.
    redirectOriginDisplayId: number | null;
    // The pairing's version mark, and here it is read for one bit only: whether the fork has EVER
    // spoken about this conversation. Stored null is two different facts — "nobody ever told us" and
    // "the fork said this episode has no WhatsApp half" — and they want opposite answers. Required
    // rather than optional so a caller that has not thought about it does not get the old behaviour
    // by omission.
    chatwootRedirectOriginAt: number | null;
    contactId: bigint | null;
  };
}

// Whether the pairing is a stored fact. Pure, and the reason a caller can tell the two apart when it
// reports what it acted on.
export function hasStoredOrigin(
  redirectOriginDisplayId: number | null,
): boolean {
  return redirectOriginDisplayId !== null;
}

// What to look the origin up BY, rather than the row itself: the two callers need different columns
// off it (the cross-link wants the activation stamp, the ladder wants the 24h-window inputs), so each
// keeps its own `select` and shares the only part that was ever wrong — which row to select.
//
// `null` ⇒ there is nothing to look up at all, and the caller has no sibling.
export function episodeOriginQuery(p: EpisodeOriginParams): {
  where: {
    chatwootInstanceId: bigint;
    chatwootConversationId?: number;
    contactId?: bigint;
    inbox?: { chatwootInboxId: number };
  };
  orderBy?: { lastEventAt: "desc" };
  // How the row was chosen, for the caller's log line: an episode acted on by inference is one whose
  // answer can be wrong, and that is worth being able to see from the outside.
  by: "stored" | "recency";
} | null {
  const stored = p.widget.redirectOriginDisplayId;
  if (stored !== null) {
    return {
      where: {
        chatwootInstanceId: p.instanceId,
        chatwootConversationId: stored,
      },
      by: "stored",
    };
  }
  // A STATED clear is an answer, not a gap. The fork writes it when a token resumes this conversation
  // naming no origin, and falling back to recency there would hand the ladder the contact's most
  // recent WhatsApp thread — one this episode was explicitly said not to have — on a consumer that
  // messages it and RESOLVES it. The fallback exists for the populations that have no stored answer
  // and never will, and a conversation the fork has spoken about is not one of them.
  //
  // The one case this cannot separate is a Chatwoot too old to send `updated_at`: it states the clear
  // and stamps no mark, so the clear reads as silence and takes the fallback. That is the same
  // degradation the pairing's ordering already has on those instances, and it fails to the behaviour
  // they had before the field existed.
  if (p.widget.chatwootRedirectOriginAt !== null) return null;
  if (p.widget.contactId === null) return null;
  return {
    where: {
      chatwootInstanceId: p.instanceId,
      contactId: p.widget.contactId,
      inbox: { chatwootInboxId: p.entryInboxId },
    },
    orderBy: { lastEventAt: "desc" },
    by: "recency",
  };
}
