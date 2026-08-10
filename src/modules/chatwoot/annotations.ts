import type { ChatwootMessageRow } from "./messages";

// In-process fallback for the eager media annotations (STT transcription, vision extraction).
// The canonical store is the Chatwoot attachment meta (updateAttachmentMeta write-back), but that
// PATCH route only exists on the fazer.ai Chatwoot fork — on upstream Chatwoot it 404s and the
// debounce flush re-fetch reads an empty meta, so the agent answered "não audível" to a voice note
// it had already transcribed (issue #49). The eager pass stashes every completed annotation here and
// the flush (and the quote page) overlays whatever the meta is missing, so the fork write-back
// becomes an ENRICHMENT (human agents see the transcription in Chatwoot), never a requirement.
// Ephemeral BY DESIGN: memory only, TTL + size bound — the anti-PII rule (never mirror message
// bodies into our DB) stays intact, and the single-replica deploy invariant (docs/deploy.md) makes
// this process's memory reach both the webhook and the flush worker.

export interface MediaAnnotation {
  transcribedText?: string;
  imageDescription?: string;
  extractedText?: string;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 2000;

const store = new Map<string, { at: number; note: MediaAnnotation }>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;

function keyOf(tenantId: bigint, instanceId: bigint, messageId: number) {
  return `${tenantId}:${instanceId}:${messageId}`;
}

// Deletes every annotation past the TTL. Called on each stash AND by the scheduled sweeper below,
// so an idle process (no further voice notes) still FORGETS old transcriptions rather than holding
// them in memory until restart — the overlay's own TTL check only hides them from readers.
export function sweepMediaAnnotations(nowMs: number = Date.now()): void {
  for (const [k, v] of store) {
    // NOTE: Inclusive boundary: the scheduled sweep wakes exactly at `at + TTL_MS`, so a strict `>`
    // would leave the entry in place and re-arm a zero-delay timer instead of reclaiming it.
    if (nowMs - v.at >= TTL_MS) store.delete(k);
  }
}

// NOTE: Second, independent bound: a burst that outruns the TTL is capped by entry count. Map
// iteration is insertion-ordered and stash() re-inserts on update, so the front is the oldest.
function enforceSizeCap(): void {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// Delay until the EARLIEST retained annotation expires (null when the store is empty). Map
// iteration is insertion-ordered and stash() re-inserts on update, so the first entry is the
// oldest. A flat TTL_MS delay would instead let an annotation stashed right after a sweep sit for
// nearly two TTLs before the next one runs.
export function nextSweepDelayMs(nowMs: number = Date.now()): number | null {
  const oldest = store.values().next().value;
  if (!oldest) return null;
  return Math.max(0, oldest.at + TTL_MS - nowMs);
}

// NOTE: One rescheduled timer, armed only while the store holds something and unref'd (same idiom
// as the alert worker) so a pending sweep never keeps the process alive at shutdown.
function scheduleSweep(nowMs: number): void {
  if (sweepTimer) return;
  const delay = nextSweepDelayMs(nowMs);
  if (delay === null) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    const now = Date.now();
    sweepMediaAnnotations(now);
    scheduleSweep(now);
  }, delay);
  sweepTimer.unref?.();
}

// Records a completed annotation for a message, merging with any field the other eager pass already
// stashed (an audio and an image can ride the same message).
export function stashMediaAnnotation(
  target: { tenantId: bigint; instanceId: bigint; messageId: number },
  note: MediaAnnotation,
  nowMs: number = Date.now(),
): void {
  const k = keyOf(target.tenantId, target.instanceId, target.messageId);
  const prev = store.get(k);
  store.delete(k);
  store.set(k, { at: nowMs, note: { ...prev?.note, ...note } });
  sweepMediaAnnotations(nowMs);
  enforceSizeCap();
  scheduleSweep(nowMs);
}

// Fills IN PLACE the annotation fields a fetched page is missing. A value already present on the
// attachment meta (the fork write-back landed) is authoritative and never overwritten.
export function overlayMediaAnnotations(
  tenantId: bigint,
  instanceId: bigint,
  rows: ChatwootMessageRow[],
  nowMs: number = Date.now(),
): void {
  for (const row of rows) {
    const hit = store.get(keyOf(tenantId, instanceId, row.id));
    if (!hit || nowMs - hit.at >= TTL_MS) continue;
    row.transcribedText ??= hit.note.transcribedText ?? null;
    row.imageDescription ??= hit.note.imageDescription ?? null;
    row.extractedText ??= hit.note.extractedText ?? null;
  }
}

// NOTE: Test isolation only — production never clears the store wholesale (the TTL sweep does).
export function clearMediaAnnotations(): void {
  store.clear();
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
}

// NOTE: How many annotations are actually RETAINED (not merely hidden from the overlay). Exposed so
// the TTL-deletion contract is assertable.
export function mediaAnnotationCount(): number {
  return store.size;
}
