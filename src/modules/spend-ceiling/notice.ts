import { withKeyedQueue } from "@/lib/locks";
import {
  claimContactAuthNotice,
  releaseContactAuthNotice,
} from "@/modules/contact-auth/state";
import type { SpendCeilingConfig } from "./settings";

// WHAT A CONVERSATION IS TOLD WHEN THE MONTH'S BUDGET IS SPENT, in one place because it is told by
// two callers. The webhook gate refuses the delivery that arms a turn; the debounce flush refuses
// the turn itself, minutes later, when the tenant crossed the ceiling inside the debounce window.
// Both owe the same three things in the same order, and the second copy of a contract is the copy
// that forgets one of them (issue #146 already paid for that once, with a handoff that was written
// twice and fenced once).

// Operator-facing note for a conversation the spend ceiling silenced (pt-BR, the same register as
// the contact-auth and out-of-hours notices). The numbers are the point: an operator who reads only
// this note has to be able to tell "the month's budget ran out" from "the agent broke", and the two
// look identical from inside a Chatwoot conversation. The figure is tokens, which is what the
// ceiling is denominated in and what the console shows, so the note and the screen never disagree.
export function spendCeilingNoteText(
  verdict: { usedTokens: number; ceilingTokens: number | null },
  handedOff: boolean,
): string {
  const handoffLine = handedOff
    ? " A conversa foi aberta para atendimento humano."
    : "";
  const used = verdict.usedTokens.toLocaleString("pt-BR");
  const ceiling = (verdict.ceilingTokens ?? 0).toLocaleString("pt-BR");
  return `O agente não respondeu: o limite de tokens do mês foi atingido (${used} de ${ceiling}). O limite fica em Configurações e é reiniciado no primeiro dia do mês.${handoffLine}`;
}

export interface SpendCeilingAnnounceParams {
  tenantId: bigint;
  // The conversation ROW id, not Chatwoot's number: it is what the caller's flow lines already carry
  // and, more to the point, what makes the cooldown key the same key on both sides. A webhook that
  // just spoke and a flush that fires two seconds later are one notice about one conversation.
  conversationRowId: bigint;
  cfg: SpendCeilingConfig;
  verdict: { usedTokens: number; ceilingTokens: number | null };
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

// COPY, THEN HANDOFF, THEN NOTE, and the order is load-bearing in both directions. The copy goes
// first because the handoff is what ends the bot's attribution, and after it the ownership fence
// would rightly withhold anything the bot tried to say. The note goes last because it is the only
// one of the three that can report whether the handoff happened.
//
// The COPY AND THE NOTE sit behind a cooldown, the verdict never does: ten people writing in after
// the month is spent are each evaluated, and told once per window. The claim mechanism is
// contact-auth's, under a key of this feature's own — it is a per-conversation notice cooldown and
// nothing about it is specific to that gate.
// TWO DIFFERENT QUESTIONS, AND THEY HAVE DIFFERENT SUBJECTS.
//
// The claims inside make each of the three writes happen once per window; they say nothing about
// ORDER. Two callers running at the same moment therefore interleave: the second finds the copy's
// window held, skips straight to the handoff, and opens the conversation while the first is still
// awaiting its send — at which point the ownership fence correctly withholds a sentence nobody else
// is going to say. So the sequences have to be SERIALISED, and that is per CONVERSATION, because the
// conversation is what the ordering is about.
//
// Coalescing is the other question and its subject is the REFUSAL. Chatwoot dispatches one incoming
// message to the conversation's assigned agent bot and to the inbox's, which is two deliveries of
// one refusal: the second must inherit the first's answer rather than perform the sequence again.
// Two DIFFERENT messages are two refusals, and collapsing them here would silence the second even
// with `noticeCooldownSeconds` at 0, which is the operator saying every refusal is to be voiced.
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
