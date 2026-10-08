import type { ContactAuthVerdict } from "./check";

// In-process coordination for the contact authorization gate; verdict reuse under `mode: "once"` is
// grants.ts, not here. Single-flight coalesces concurrent deliveries for one contact into ONE request
// (nothing outlives the promise). The notice cooldown voices a refused burst once per window; memory
// only, since losing it merely repeats a notice. The cooldown store is bounded by a rescheduled sweep
// that deletes expired entries (so an idle process forgets them) and by a hard entry cap.

const MAX_ENTRIES = 10_000;

// key -> the moment the suppression lapses (ms epoch). Ids and timestamps are ALL this module
// retains: no verdict, no reason, nothing the endpoint or the customer said.
const notices = new Map<string, number>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let sweepAt = 0;

// Scoped to the CONVERSATION (not the contact): the copy and the note land on a conversation, and a
// contact writing on two channels is two conversations, each entitled to its own notice.
//
// And scoped to the NOTICE: an endpoint ERROR writes only a note, and sharing one claim would let it
// consume the window for a denial right after, skipping the deny copy (usually the unlock
// instructions, which no later message carries once the handoff ends the bot's attribution).
export type ContactAuthNotice = "copy" | "note";

export function contactAuthNoticeKey(
  tenantId: bigint,
  agentId: bigint,
  conversationRowId: bigint,
  notice: ContactAuthNotice,
): string {
  return `${tenantId}:${agentId}:${conversationRowId}:${notice}`;
}

// Single-flight is scoped to the CONTACT (one person writing twice concurrently is one question) and
// to the REQUEST, which is not an optimization: a proactive nudge carries no message text, so an
// unlock endpoint's refusal to it would be handed to the message carrying the code, and the joiner is
// told `shared`, suppressing its own deny copy, handoff and note. `request` is the message id under an
// unlock flow and the source otherwise; only the same delivery arriving twice collapses.
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

// Second, independent bound: a burst that outruns every window is capped by entry count. Map
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

// One timer, armed for the earliest lapse and re-armed when a newer entry lapses sooner,
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
const inFlight = new Map<
  string,
  { p: Promise<ContactAuthVerdict>; askedAt: number }
>();

// `askedAt` is when the flight began, the same for every caller that joined it: a caller that joins
// late is answered by the question asked then, not by one asked when it arrived.
export async function singleFlight(
  key: string,
  run: () => Promise<ContactAuthVerdict>,
): Promise<{ verdict: ContactAuthVerdict; shared: boolean; askedAt: number }> {
  const existing = inFlight.get(key);
  if (existing) {
    return {
      verdict: await existing.p,
      shared: true,
      askedAt: existing.askedAt,
    };
  }
  const askedAt = Date.now();
  const p = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, { p, askedAt });
  return { verdict: await p, shared: false, askedAt };
}

// Messages whose media the gate let through, so the `message_updated` Chatwoot sends after a voice
// note does not ask again. Per message, never a verdict for the next one. Losing an entry costs one
// more ask; refusals live on the conversation instead, since forgetting one would read the file.
const MEDIA_ADMISSION_TTL_MS = 15 * 60_000;
const mediaAdmitted = new Map<string, number>();

export function mediaAdmissionKey(
  tenantId: bigint,
  instanceId: bigint,
  messageId: number,
): string {
  return `${tenantId}:${instanceId}:${messageId}`;
}

export function rememberMediaAdmission(
  key: string,
  nowMs: number = Date.now(),
): void {
  if (mediaAdmitted.size >= MAX_ENTRIES) {
    for (const [k, until] of mediaAdmitted) {
      if (until <= nowMs) mediaAdmitted.delete(k);
    }
    if (mediaAdmitted.size >= MAX_ENTRIES) {
      const first = mediaAdmitted.keys().next().value;
      if (first !== undefined) mediaAdmitted.delete(first);
    }
  }
  mediaAdmitted.set(key, nowMs + MEDIA_ADMISSION_TTL_MS);
}

export function mediaAlreadyAdmitted(
  key: string,
  nowMs: number = Date.now(),
): boolean {
  const until = mediaAdmitted.get(key);
  if (until === undefined) return false;
  if (until <= nowMs) {
    mediaAdmitted.delete(key);
    return false;
  }
  return true;
}

// Every media refusal this process gave, from before its write: a reader whose query started before
// the write committed still sees it. Keyed by conversation, holding the newest refused message id.
// Never evicted, since an entry may be the only record of its refusal; refusals are rare, so the
// map stays small.
const mediaRefusedHere = new Map<string, number>();

export function rememberMediaRefusal(key: string, messageId: number): void {
  mediaRefusedHere.set(
    key,
    Math.max(mediaRefusedHere.get(key) ?? 0, messageId),
  );
}

export function mediaRefusedHereThrough(key: string): number | null {
  return mediaRefusedHere.get(key) ?? null;
}

// Test isolation only. Production never clears the state wholesale; the sweep does.
export function clearContactAuthState(): void {
  notices.clear();
  inFlight.clear();
  mediaAdmitted.clear();
  mediaRefusedHere.clear();
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
}

// How many cooldowns are actually RETAINED (not merely lapsed but unswept ones hidden from
// readers; those count until the sweep runs). Exposed so the sweep contract is assertable.
export function contactAuthNoticeCount(): number {
  return notices.size;
}

// Test-only view of what is retained, so a test can prove this module holds ids and
// timestamps and nothing anyone said.
export function contactAuthNoticeEntries(): Array<{
  key: string;
  until: number;
}> {
  return [...notices].map(([key, until]) => ({ key, until }));
}
