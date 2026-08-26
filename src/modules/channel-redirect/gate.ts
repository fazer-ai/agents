import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { ChatwootApiError } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { buildWidgetUrl, normalizeWebsiteUrl } from "./link";
import {
  type ChannelRedirectConfig,
  REDIRECT_LINK_TTL_SECONDS,
  shouldSendRedirect,
} from "./service";

// The redirect gate's runtime side: given an incoming message on the designated entry (WhatsApp) inbox,
// send the fixed no-AI link to the web chat (one-shot + resend cooldown) and report the outcome. The
// webhook calls this from maybeConsumeCommandOrGate; "sent"/"silent" mean "consumed, do NOT run the AI",
// "misconfigured" means "fall through" (the operator enabled redirect but provisioning is incomplete, so
// serve the lead on WhatsApp as a fallback rather than dead-ending them).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type RedirectGateOutcome =
  | "sent"
  | "silent"
  | "misconfigured"
  // The link was composed but the sender declined to deliver it (the conversation stopped being the
  // bot's). Distinct from "silent", which means it was not time to send: this one still owes a link.
  | "withheld";

// Cap the cloned WhatsApp message stored in the redirect token so it stays a sane single message.
const MAX_CLONE_CHARS = 1000;

export interface ResolveRedirectLinkParams {
  tenantId: bigint;
  instanceId: bigint;
  chatwootContactId: number;
  widgetInboxId: number;
  // Stored in the token, injected into the widget on land (the cloned WhatsApp message). Omitted by the
  // proactive WhatsApp follow-up (nothing new to clone — the lead already saw their first message).
  clonedMessage?: string;
  // The WhatsApp entry conversation the link is being sent on (its chatwootConversationId). Rides in
  // the token so the fork can stamp it on the widget conversation, which is what turns the episode's
  // pairing from an inference into a fact (issue #222).
  originDisplayId: number;
  openWidget: boolean;
  ttlSeconds: number;
  base: PrismaClient;
}

// Whether an identifier a contact is already carrying is one this gate gave it: the base value, or the
// base with a suffix. Anything else (no identifier, a WhatsApp LID, another lead's value) is not ours,
// and the caller takes one instead.
export function isOurIdentifier(current: string, base: string): boolean {
  return current === base || current.startsWith(`${base}:`);
}

// Settle which redirect identifier this contact carries, and return it, because the token has to be
// minted for whatever the answer is.
//
// READ FIRST, and keep what is already there. `fzwa:<X>` is unique per Chatwoot account, so when
// another contact holds it the stamp is refused with a 422 and, with a fixed value, every later
// redirect for this lead fails the same way, permanently and in silence (#269). The answer to that
// refusal is to take `fzwa:<X>:<random>` instead. But an identifier this contact ALREADY carries is
// the one live tokens were minted for, and links outlive the resend cooldown by design (24h), so
// re-deriving a value on each delivery would detach the link issued minutes ago. That applies both
// ways: a contact that moved keeps its suffix even if the base has since become free, because a token
// is out there carrying the suffix.
//
// So this writes only when the contact has no identifier of ours yet, which also means the ordinary
// path costs one call, a read, instead of a pointless re-stamp of a value already in place.
//
// WHY IT MOVES INSTEAD OF TAKING THE VALUE BACK. The alternative is to find the holder and clear it,
// and that is unbuildable on this API: nothing there answers "who holds exactly this identifier".
// `/contacts/search` matches a substring across name, email, phone and identifier, 15 rows a page.
// `/contacts/filter` is exact but case-INSENSITIVE while the unique index is not, is paged the same
// way, and its `resolved_contacts` base narrows to `contact_type: 'lead'` once `crm_v2` is on, which
// hides the widget visitor it would be looking for. And there is no conditional write, so even a
// correct answer can go stale between the read and the PUT and clear an identifier nobody meant to
// touch. Moving needs none of it: the account cannot refuse a value nobody has, the write stays on OUR
// contact, and no other contact is read, trusted or modified. Squatting stops working too, since an
// identifier that does not exist until it is minted cannot be claimed in advance.
//
// Serialized per contact because the whole thing is read-then-write over the network: two deliveries
// for one lead arriving together would otherwise both read "nothing yet", mint two different suffixes
// and leave one of the two links pointing at a value the contact no longer holds. The queue is
// process-local, which is the same invariant the rest of the gate already runs under.
//
// Keyed by INSTANCE and contact, because a Chatwoot contact id is unique inside one account and not
// beyond it (schema.prisma says so on `Contact`, and `ChatwootClient.targetKey` scopes its own keys the
// same way). A bare contact id would put two tenants that happen to share the number behind one queue,
// so a slow round trip on one Chatwoot server would hold up a redirect on another.
export function identifierQueueKey(
  instanceId: bigint,
  chatwootContactId: number,
): string {
  return `redirect-identifier:${instanceId}:${chatwootContactId}`;
}

async function settleIdentifier(
  admin: Awaited<ReturnType<typeof loadChatwootClient>>,
  instanceId: bigint,
  chatwootContactId: number,
  base: string,
): Promise<string> {
  return withKeyedQueue(
    identifierQueueKey(instanceId, chatwootContactId),
    async () => {
      const current = await admin.getContactIdentifier(chatwootContactId);
      if (current !== null && isOurIdentifier(current, base)) return current;
      try {
        await admin.updateContact(chatwootContactId, { identifier: base });
        return base;
      } catch (err) {
        if (!(err instanceof ChatwootApiError) || err.status !== 422) throw err;
        // Random rather than a counter: a counter would have to be stored somewhere, and its next value
        // is as claimable in advance as the first one was.
        const moved = `${base}:${randomBytes(4).toString("hex")}`;
        logger.info(
          "channel-redirect: identifier %s is held by another contact; contact %d takes %s instead",
          base,
          chatwootContactId,
          moved,
        );
        // A second refusal is not a collision worth chasing: it means a 1-in-4-billion clash, or a 422
        // that was never about the identifier. Either belongs to the caller's catch.
        await admin.updateContact(chatwootContactId, { identifier: moved });
        return moved;
      }
    },
  );
}

// Stamp the `fzwa:` identifier on the WhatsApp contact (so the widget-side resolve merges the widget
// contact onto it) + mint a single-use redirect token, then build the widget link. Shared by the
// reactive gate (the first redirect) and the proactive WhatsApp follow-up (which re-sends the link).
// Returns null on any misconfig/failure (widget inbox with no website_url, mint failed) so the caller
// falls back. All admin-token.
export async function resolveRedirectLink(
  p: ResolveRedirectLinkParams,
): Promise<string | null> {
  try {
    const admin = await loadChatwootClient(p.tenantId, p.instanceId, {
      base: p.base,
    });
    // Minted for whatever this contact actually carries, which is not always the value it would be
    // asked for: one another contact holds is answered by taking a different one, and one already in
    // place is kept because a live token was minted for it.
    const identifier = await settleIdentifier(
      admin,
      p.instanceId,
      p.chatwootContactId,
      `fzwa:${p.chatwootContactId}`,
    );
    const { token, websiteUrl } = await admin.mintRedirectToken({
      inboxId: p.widgetInboxId,
      identifier,
      message: p.clonedMessage,
      ttlSeconds: p.ttlSeconds,
      originDisplayId: p.originDisplayId,
    });
    if (!websiteUrl) {
      logger.warn(
        "channel-redirect: widget inbox %d has no website_url set in Chatwoot",
        p.widgetInboxId,
      );
      return null;
    }
    // Repair a scheme-less website_url (https://) so a missing "https://" doesn't dead-end the
    // redirect; an unrecoverably invalid one gets a distinct, actionable warning (the operator sees
    // it surfaced in the editor's Redirect tab, not just here).
    const normalized = normalizeWebsiteUrl(websiteUrl);
    if (!normalized) {
      logger.warn(
        "channel-redirect: widget inbox %d has an invalid website_url (%s) — set a valid https:// URL in Chatwoot",
        p.widgetInboxId,
        websiteUrl,
      );
      return null;
    }
    if (normalized.recovered) {
      logger.info(
        "channel-redirect: widget inbox %d website_url was missing a scheme; using %s",
        p.widgetInboxId,
        normalized.url,
      );
    }
    return buildWidgetUrl({
      websiteUrl: normalized.url,
      token,
      open: p.openWidget,
    });
  } catch (err) {
    logger.warn(
      { err },
      "channel-redirect: resolveRedirectLink failed (updateContact/mint)",
    );
    return null;
  }
}

// Interpolate the per-lead link into a message template: replace every `{link}` (or append if the
// template lacks the placeholder). Shared by the gate (redirectMessage) and the follow-up
// (waFollowupMessage).
export function interpolateLink(template: string, url: string): string {
  return template.includes("{link}")
    ? template.replaceAll("{link}", url)
    : `${template} ${url}`;
}

export interface RunRedirectGateParams {
  tenantId: bigint;
  instanceId: bigint;
  // Chatwoot display id of the conversation the gate is running on — the WhatsApp ENTRY half of the
  // episode. Load-bearing since #222: it is what the token carries as the redirect's origin.
  conversationId: number;
  conv: {
    id: bigint;
    contactId: bigint | null;
    redirectSentAt: Date | null;
    redirectCount: number;
  };
  cfg: ChannelRedirectConfig;
  // The lead's original WhatsApp message (content of the incoming that triggered the gate), cloned into
  // the widget when cfg.cloneWaMessage is on.
  clonedMessage: string | null;
  now: Date;
  base: PrismaClient;
  // Sends a message as the persona bot (the webhook's public post). Reused so the reply is attributed
  // to the bot. Returns whether it actually left: the caller's send can decline (a conversation taken
  // over mid-flight) or fail, and the watermark below is what makes that difference permanent.
  send: (text: string) => Promise<boolean>;
}

export async function runRedirectGate(
  p: RunRedirectGateParams,
): Promise<RedirectGateOutcome> {
  const { tenantId, instanceId, cfg, base } = p;
  if (cfg.widgetInboxId === null || p.conv.contactId === null) {
    return "misconfigured";
  }
  const widgetInboxId = cfg.widgetInboxId;
  const contactId = p.conv.contactId;

  // Load the contact's Chatwoot id, tenant-scoped. The widget inbox's website_url comes back from the
  // mint call below (Chatwoot owns it), so there is nothing to provision or store on our side.
  const contact = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.contact.findUnique({
      where: { id: contactId },
      select: { chatwootContactId: true },
    }),
  );
  if (!contact?.chatwootContactId) return "misconfigured";

  // One-shot + resend cooldown: nothing to do if we already redirected and it is not time to re-send.
  if (
    !shouldSendRedirect(cfg, p.conv.redirectSentAt, p.conv.redirectCount, p.now)
  ) {
    return "silent";
  }

  // The link stays clickable for REDIRECT_LINK_TTL_SECONDS (24h) — long enough that a lead who opens the
  // WhatsApp link hours later still lands on their merged chat. Any failure falls through (serve on WhatsApp).
  const url = await resolveRedirectLink({
    tenantId,
    instanceId,
    chatwootContactId: contact.chatwootContactId,
    widgetInboxId,
    originDisplayId: p.conversationId,
    clonedMessage:
      cfg.cloneWaMessage && p.clonedMessage
        ? clipText(p.clonedMessage, MAX_CLONE_CHARS)
        : undefined,
    openWidget: cfg.openWidget,
    ttlSeconds: REDIRECT_LINK_TTL_SECONDS,
    base,
  });
  if (url === null) return "misconfigured";

  // The stamp belongs to the DELIVERY, not to the attempt. `redirectSentAt` closes the one-shot and
  // `redirectCount` spends one of `maxResends`, so stamping a link nobody received costs the lead the
  // link outright — permanently at the default maxResends of 0.
  if (!(await p.send(interpolateLink(cfg.redirectMessage, url)))) {
    logger.info(
      "channel-redirect: link withheld, watermark untouched (conv=%s)",
      String(p.conversationId),
    );
    return "withheld";
  }

  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.update({
      where: { id: p.conv.id },
      data: { redirectSentAt: p.now, redirectCount: p.conv.redirectCount + 1 },
    }),
  );
  logger.info(
    "channel-redirect: link sent (conv=%s count=%d)",
    String(p.conversationId),
    p.conv.redirectCount + 1,
  );
  return "sent";
}
