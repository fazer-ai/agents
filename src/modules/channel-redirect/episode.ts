import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import type { ChannelRedirectConfig } from "./service";

// Test-mode activation is a property of the PERSON being served, not of a channel, and a redirect
// episode is two conversations of one contact (`service.ts`'s header). The link-time propagation
// runs once and one way, so the halves can disagree; every reader (the ladder, the reactive gate,
// `/reset`) therefore asks the EPISODE's question, and this module answers it.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Which half of a redirect episode a conversation is, read from its inbox. `null` means the
// conversation is not part of one: the episode question does not arise, and nothing is looked up.
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
  // Agent.mode: a production agent is never silenced, so it never asks.
  agentMode: string;
  // The stamp on the conversation the caller already has in hand.
  ownTestActivatedAt: Date | null;
  // Which half of an episode that conversation is; null = not part of one.
  side: "entry" | "widget" | null;
}

// Pure: whether the sibling has to be read at all (the reactive gate runs on EVERY inbound). No for
// a production agent, for a row already stamped (either half activates the episode), and for a
// conversation outside a redirect episode.
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

// The episode's activation stamp: this conversation's own, or, when it has none, its redirect
// sibling's (the same contact's conversation on the OTHER side's inbox). Null when not activated
// anywhere, which `isTestSilenced` already reads. A failed sibling read answers null, so the test
// agent stays quiet: silence is the safe failure here, unlike the ladder's fail-open liveness fence.
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
      // NOTE: The activated sibling FIRST, so a newer unstamped conversation on that inbox cannot
      // hide the activation. Ordering, not filtering: the greatest stamp is the episode's answer.
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

// WHICH conversation is the WhatsApp entry half of a widget conversation's episode, asked by the
// cross-link and by the follow-up ladder (which may RESOLVE it). Read, not inferred: the fork's token
// resolve writes the origin, and `redirectOriginDisplayId` IS the answer whenever it is there. The
// most-recently-active predicate is only the fallback for episodes and Chatwoots with no stored answer.
export interface EpisodeOriginParams {
  tenantId: bigint;
  instanceId: bigint;
  entryInboxId: number;
  widget: {
    // The widget conversation's stored pairing, straight off the mirror. Non-null: this is the answer.
    redirectOriginDisplayId: number | null;
    // The pairing's version mark, read for one bit: whether the fork has EVER spoken about this
    // conversation, since a null origin means either "never told" or "told there is no WhatsApp
    // half". Required so a caller cannot get the fallback by omission.
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
// keeps its own `select` and shares which row to select. `null`: nothing to look up, no sibling.
// Why the origin is read and never inferred: docs/channel-redirect.md, "Which conversation is the
// episode's WhatsApp half".
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
  // NOTE: A STATED clear is an answer, not a gap: falling back to recency would hand the ladder a
  // WhatsApp thread this episode was said not to have, which it then messages and RESOLVES. A
  // Chatwoot too old to send `updated_at` stamps no mark, so its clear still takes the fallback.
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
