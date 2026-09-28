import { withKeyedQueue } from "@/lib/locks";
import {
  claimContactAuthNotice,
  releaseContactAuthNotice,
} from "@/modules/contact-auth/state";
import type { SpendCeilingConfig } from "./settings";

// WHAT A CONVERSATION IS TOLD WHEN THE MONTH'S BUDGET IS SPENT, in one place because two callers
// tell it: the webhook gate refuses the delivery that arms a turn, and the debounce flush refuses the
// turn itself when the tenant crossed the ceiling inside the debounce window. Both owe the same
// three things in the same order.

// Operator-facing note for a conversation the spend ceiling silenced (pt-BR, the same register as
// the contact-auth and out-of-hours notices). The numbers are the point: an operator who reads only
// this note has to be able to tell "the month's budget ran out" from "the agent broke", and the two
// look identical from inside a Chatwoot conversation. The figure is dollars, which is what the
// ceiling is denominated in and what the console shows, so the note and the screen never disagree.
export function spendCeilingNoteText(
  verdict: { usedUsd: number; ceilingUsd: number | null },
  handedOff: boolean,
): string {
  const handoffLine = handedOff
    ? " A conversa foi aberta para atendimento humano."
    : "";
  const usd = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
  });
  const used = usd.format(verdict.usedUsd);
  const ceiling = usd.format(verdict.ceilingUsd ?? 0);
  return `O agente não respondeu: o limite de gasto do mês foi atingido (${used} de ${ceiling}). O limite fica em Configurações e é reiniciado no primeiro dia do mês.${handoffLine}`;
}

export interface SpendCeilingAnnounceParams {
  tenantId: bigint;
  // The conversation ROW id, not Chatwoot's number: it is what the caller's flow lines already carry
  // and, more to the point, what makes the cooldown key the same key on both sides. A webhook that
  // just spoke and a flush that fires two seconds later are one notice about one conversation.
  conversationRowId: bigint;
  cfg: SpendCeilingConfig;
  verdict: { usedUsd: number; ceilingUsd: number | null };
  // WHICH REFUSAL this is, so two deliveries of one message coalesce and two messages do not. The
  // Chatwoot message id where there is one; the burst's last id for a debounce flush, which is the
  // same thing one level up (the burst is what was refused, and its last id names it).
  occasion: string;
  // The caller's own fenced primitives. Each returns whether the thing actually landed, because the
  // cooldown window is given back when it did not: kept, a send the customer never received would
  // silence the next refusal for the whole window.
  postPublicMessage: (text: string) => Promise<boolean>;
  postPrivateNote: (text: string) => Promise<boolean>;
  handoff: () => Promise<boolean>;
}

// COPY, THEN HANDOFF, THEN NOTE: the copy first because after the handoff the ownership fence would
// withhold it; the note last because only it can report whether the handoff happened. Copy and note
// sit behind a per-conversation cooldown, the verdict never does. The claims do not order the
// writes, so concurrent sequences are SERIALISED per conversation, and two deliveries of the SAME
// message (Chatwoot sends one per bot) coalesce into one refusal. See docs/spend-ceiling.md.
const inFlight = new Map<string, Promise<{ handedOff: boolean }>>();

export async function announceSpendCeilingOnConversation(
  params: SpendCeilingAnnounceParams,
): Promise<{ handedOff: boolean }> {
  const flightKey = `spend_ceiling:${params.tenantId}:${params.conversationRowId}:${params.occasion}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing;
  const flight = withKeyedQueue(
    `spend_ceiling:${params.tenantId}:${params.conversationRowId}`,
    () => runSpendCeilingAnnouncement(params),
  ).finally(() => {
    inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, flight);
  return flight;
}

// NOTE: Test isolation only, like contact-auth's own state reset. Production never clears this: a
// flight removes itself when it settles.
export function clearSpendCeilingFlights(): void {
  inFlight.clear();
}

async function runSpendCeilingAnnouncement(
  params: SpendCeilingAnnounceParams,
): Promise<{ handedOff: boolean }> {
  const { tenantId, conversationRowId, cfg, verdict } = params;
  const cooldownMs = cfg.noticeCooldownSeconds * 1000;
  const claim = (notice: "copy" | "note") =>
    claimContactAuthNotice(
      `spend_ceiling:${tenantId}:${conversationRowId}:${notice}`,
      cooldownMs,
    );

  const copy = cfg.overCeilingMessage;
  const copyClaim = copy ? claim("copy") : false;
  if (copy && copyClaim) {
    // The window is claimed before the send, so two deliveries racing cannot both speak.
    if (!(await params.postPublicMessage(copy))) {
      releaseContactAuthNotice(copyClaim);
    }
  }

  let handedOff = false;
  if (cfg.handoffEnabled) {
    // Outside the cooldown deliberately: the open is what ends the bot's attribution, and a first
    // attempt that failed has to be retried on the next message, notice or no notice.
    handedOff = await params.handoff();
  }

  const noteClaim = claim("note");
  if (noteClaim) {
    if (
      !(await params.postPrivateNote(spendCeilingNoteText(verdict, handedOff)))
    ) {
      releaseContactAuthNotice(noteClaim);
    }
  }
  return { handedOff };
}
