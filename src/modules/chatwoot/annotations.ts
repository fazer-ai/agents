import type { UnreadFile } from "@/modules/vision/unread";
import type { ChatwootMessageRow } from "./messages";

// In-process fallback for the eager media annotations (STT transcription, vision extraction). The
// canonical store is the Chatwoot attachment meta, but that PATCH route only exists on the fazer.ai
// fork; on upstream it 404s and the flush re-fetch reads an empty meta. The eager pass stashes every
// annotation here and the flush (and the quote page) overlays what the meta is missing, so the fork
// write-back is an enrichment, never a requirement. Memory only, TTL and size bound: message bodies
// never reach our DB, and the single-replica invariant (docs/deploy.md) lets this process's memory
// reach both the webhook and the flush worker.

export interface MediaAnnotation {
  transcribedText?: string;
  imageDescription?: string;
  extractedText?: string;
  // How many attachments the eager pass did NOT read (over the cap, or failed): the model's move is
  // the same for both. A count, never text: it crosses the debounce re-fetch, and the renderer
  // phrases the notice like every other marker.
  attachmentsUnread?: number;
  // The unread files the pass tried, each with its name and cause, so the renderer can say what to
  // ask for. Memory only, like everything here: the name is the customer's text.
  unreadFiles?: UnreadFile[];
  // The pass went through the email body's images too. They leave no meta anywhere, so this is the
  // only record that they were read, or were all ornaments.
  bodyRead?: boolean;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 2000;

const store = new Map<string, { at: number; note: MediaAnnotation }>();
// One vision read per file, under the same retention as the annotations: a later delivery of the
// message reuses it instead of paying the provider again.
const fileReads = new Map<string, { at: number; value: unknown }>();
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
  for (const [k, v] of fileReads) {
    if (nowMs - v.at >= TTL_MS) fileReads.delete(k);
  }
}

// Second, independent bound: a burst that outruns the TTL is capped by entry count. Map
// iteration is insertion-ordered and stash() re-inserts on update, so the front is the oldest.
function enforceSizeCap(): void {
  for (const map of [store, fileReads] as Map<string, unknown>[]) {
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

// Delay until the EARLIEST retained annotation expires (null when the store is empty). Map
// iteration is insertion-ordered and stash() re-inserts on update, so the first entry is the
// oldest. A flat TTL_MS delay would instead let an annotation stashed right after a sweep sit for
// nearly two TTLs before the next one runs.
export function nextSweepDelayMs(nowMs: number = Date.now()): number | null {
  const firsts = [store.values().next().value, fileReads.values().next().value];
  const at = Math.min(...firsts.flatMap((e) => (e ? [e.at] : [])));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at + TTL_MS - nowMs);
}

// One rescheduled timer, armed only while the store holds something and unref'd (same idiom
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

// One message's annotation, when this process still holds it. The audio reply stashes the text it
// spoke under the id Chatwoot gave the send, so a channel failure reported minutes later recovers
// the reply on an upstream Chatwoot that drops the attachment metadata.
export function mediaAnnotationFor(
  tenantId: bigint,
  instanceId: bigint,
  messageId: number,
  nowMs: number = Date.now(),
): MediaAnnotation | null {
  const hit = store.get(keyOf(tenantId, instanceId, messageId));
  if (!hit || nowMs - hit.at >= TTL_MS) return null;
  return hit.note;
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
    // NOTE: the vision fields are aggregates, so "meta wins" inverts. The write-back is per
    // attachment, so a page with one of two meta writes landed carries a partial description that
    // `??=` would keep. The stash is written once by the pass that produced all of them (idempotent
    // per message, message-keyed, 15-minute TTL), so when present it is the more complete reading of
    // the same extraction. Absent (another process, past the TTL), the meta answers.
    if (hit.note.bodyRead) row.bodyRead = true;
    row.imageDescription =
      hit.note.imageDescription ?? row.imageDescription ?? null;
    row.extractedText = hit.note.extractedText ?? row.extractedText ?? null;
    // Not `??=` on a field the fetched page never carries: the re-fetch cannot know what the eager
    // pass declined to open, so the stash is the only source and always wins here.
    if (hit.note.attachmentsUnread)
      row.attachmentsUnread = hit.note.attachmentsUnread;
    if (hit.note.unreadFiles?.length) row.unreadFiles = hit.note.unreadFiles;
  }
}

export function rememberFileRead(
  key: string,
  value: unknown,
  nowMs: number = Date.now(),
): void {
  fileReads.delete(key);
  fileReads.set(key, { at: nowMs, value });
  sweepMediaAnnotations(nowMs);
  enforceSizeCap();
  scheduleSweep(nowMs);
}

export function fileReadFor(
  key: string,
  nowMs: number = Date.now(),
): { value: unknown } | null {
  const hit = fileReads.get(key);
  if (!hit || nowMs - hit.at >= TTL_MS) return null;
  return { value: hit.value };
}

// Test isolation only — production never clears the store wholesale (the TTL sweep does).
export function clearMediaAnnotations(): void {
  store.clear();
  fileReads.clear();
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
}

// How many annotations are actually RETAINED (not merely hidden from the overlay). Exposed so
// the TTL-deletion contract is assertable.
export function mediaAnnotationCount(): number {
  return store.size + fileReads.size;
}
