import type { ContactAuthVerdict } from "./check";

// In-process coordination for the contact authorization gate. NOT a verdict cache: every incoming
// message asks the endpoint again (docs/contact-auth.md), so a revocation on the operator's side
// takes effect on the customer's next message, and an unlock (a code the customer sends) is seen
// the moment it arrives. What lives here instead:
//
//  - Single-flight: concurrent deliveries for one contact coalesce into ONE request in flight.
//    Dedupe of work in flight, not memory of a verdict; nothing outlives the promise.
//  - Notice cooldown: how recently a conversation was told about a refusal (the customer copy and
//    the operator note), so a refused burst is voiced once per window rather than once per message.
//    Memory only, by design: losing it on a restart merely repeats a notice, which is harmless,
//    unlike a verdict would be.
//
// The cooldown store is bounded twice, and the first bound is active rather than lazy: a
// rescheduled sweep wakes at the earliest lapse and deletes what has expired, so an idle process
// FORGETS old cooldowns instead of holding them until restart (same idiom as the media annotations
// store); a hard entry cap absorbs a burst that outruns every window.

const MAX_ENTRIES = 10_000;

// key -> the moment the suppression lapses (ms epoch). Ids and timestamps are ALL this module
// retains: no verdict, no reason, nothing the endpoint or the customer said.
const notices = new Map<string, number>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let sweepAt = 0;

// Scoped to the CONVERSATION (not the contact): the copy and the note land on a conversation, and a
// contact writing on two channels is two conversations, each entitled to its own notice.
//
// And scoped to the NOTICE, because the two are not interchangeable. They used to share one claim,
// so an endpoint ERROR — which writes a note and never speaks to the customer — consumed the window
// for a denial arriving right after it, and the deny copy was skipped. That copy is usually the
// unlock instructions, and the handoff that follows ends the bot's attribution, so there is no
// later message to carry it: the customer is refused and never told why or how to fix it.
export type ContactAuthNotice = "copy" | "note";

export function contactAuthNoticeKey(
  tenantId: bigint,
  agentId: bigint,
  conversationRowId: bigint,
  notice: ContactAuthNotice,
): string {
  return `${tenantId}:${agentId}:${conversationRowId}:${notice}`;
}

// Single-flight is scoped to the CONTACT: the same person writing twice concurrently is one
// question to the endpoint, whichever conversations the messages landed on.
//
// It is scoped to the REQUEST as well, and that half is not an optimization. What collapses here is
// the same delivery arriving twice (a retry, a duplicated webhook), which shares its message id.
// Two DIFFERENT askings are not the same question:
//
//   - a proactive nudge carries no message text, so an unlock endpoint answering "denied until they
//     send the code" would hand its refusal to the very message that carries the code;
//   - and the joiner is told `shared`, which is what suppresses its own deny copy, handoff and
//     note — so a nudge's refusal would silently swallow the customer's.
//
// `request` is the message id under an unlock flow (the text is part of the question), and the
// source otherwise. Same message id ⇒ same question ⇒ one call, which is the case worth collapsing.
export function contactAuthFlightKey(
  tenantId: bigint,
  agentId: bigint,
  contactDbId: bigint,
  request: string,
): string {
  return `${tenantId}:${agentId}:${contactDbId}:${request}`;
}

// A claimed window. `until` identifies THIS claim, so releasing one cannot take another's: with a
// cooldown shorter than a slow Chatwoot send, claim A can lapse and claim B replace it before A
// learns it failed, and an unconditional delete would then hand B's window away too.
// `null` = nothing was claimed and the caller should speak anyway (a non-positive cooldown: the
// operator asked to be told every time).
export interface NoticeClaim {
  key: string;
  until: number | null;
}

// Non-null = this refusal should be voiced and the cooldown window opens now. `false` = an equal
// notice went out within the window. Check and claim are one synchronous step, so two settled
// deliveries racing for the same conversation cannot both be told to speak.
export function claimContactAuthNotice(
  key: string,
  cooldownMs: number,
  nowMs: number = Date.now(),
): NoticeClaim | false {
  if (cooldownMs <= 0) return { key, until: null };
  const until = notices.get(key);
  if (until !== undefined && until > nowMs) return false;
  const mine = nowMs + cooldownMs;
  notices.delete(key);
  notices.set(key, mine);
  sweepContactAuthNotices(nowMs);
  enforceSizeCap();
  scheduleSweep(nowMs);
  return { key, until: mine };
}

// Give a claimed window back. The claim has to come BEFORE the delivery (two settled deliveries
// racing must not both be told to speak), so the failure case needs an undo: Chatwoot refusing the
// message would otherwise silence the next refusal for the whole window, and the copy it silences
// is usually the unlock instructions — which the handoff after it leaves no later message to carry.
// Only the claim that is still standing is released; a newer one belongs to somebody else.
export function releaseContactAuthNotice(claim: NoticeClaim): void {
  if (claim.until === null) return;
  if (notices.get(claim.key) === claim.until) notices.delete(claim.key);
}

// Deletes every cooldown past its lapse. Called on each claim AND by the scheduled sweeper.
export function sweepContactAuthNotices(nowMs: number = Date.now()): void {
  for (const [k, until] of notices) {
    // NOTE: Inclusive boundary: the scheduled sweep wakes exactly at `until`, so a strict `<`
    // would leave the entry in place and re-arm a zero-delay timer instead of reclaiming it.
    if (until <= nowMs) notices.delete(k);
  }
}

// NOTE: Second, independent bound: a burst that outruns every window is capped by entry count. Map
// iteration is insertion-ordered and claim() re-inserts on renewal, so the front is the oldest.
function enforceSizeCap(): void {
  while (notices.size > MAX_ENTRIES) {
    const oldest = notices.keys().next().value;
    if (oldest === undefined) break;
    notices.delete(oldest);
  }
}

// Delay until the EARLIEST retained cooldown lapses (null when none are held).
export function nextSweepDelayMs(nowMs: number = Date.now()): number | null {
  let earliest: number | null = null;
  for (const until of notices.values()) {
    if (earliest === null || until < earliest) earliest = until;
  }
  return earliest === null ? null : Math.max(0, earliest - nowMs);
}

// NOTE: One timer, armed for the earliest lapse and re-armed when a newer entry lapses sooner,
// unref'd so a pending sweep never keeps the process alive at shutdown.
function scheduleSweep(nowMs: number): void {
  const delay = nextSweepDelayMs(nowMs);
  if (delay === null) {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = undefined;
    return;
  }
  const at = nowMs + delay;
  if (sweepTimer && at >= sweepAt) return;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepAt = at;
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    const now = Date.now();
    sweepContactAuthNotices(now);
    scheduleSweep(now);
  }, delay);
  sweepTimer.unref?.();
}

// Single-flight per contact: two messages from one contact arriving together must not both ask the
// endpoint. The second caller awaits the first caller's promise and is told the verdict was SHARED,
// which the gate reads as "the leader acts, I stay silent". Same idiom as the OAuth refresh
// coalescing in modules/vault/mcp-oauth.ts.
const inFlight = new Map<string, Promise<ContactAuthVerdict>>();

export async function singleFlight(
  key: string,
  run: () => Promise<ContactAuthVerdict>,
): Promise<{ verdict: ContactAuthVerdict; shared: boolean }> {
  const existing = inFlight.get(key);
  if (existing) return { verdict: await existing, shared: true };
  const p = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return { verdict: await p, shared: false };
}

// NOTE: Test isolation only. Production never clears the state wholesale; the sweep does.
export function clearContactAuthState(): void {
  notices.clear();
  inFlight.clear();
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
}

// NOTE: How many cooldowns are actually RETAINED (not merely lapsed but unswept ones hidden from
// readers; those count until the sweep runs). Exposed so the sweep contract is assertable.
export function contactAuthNoticeCount(): number {
  return notices.size;
}

// NOTE: Test-only view of what is retained, so a test can prove this module holds ids and
// timestamps and nothing anyone said.
export function contactAuthNoticeEntries(): Array<{
  key: string;
  until: number;
}> {
  return [...notices].map(([key, until]) => ({ key, until }));
}
