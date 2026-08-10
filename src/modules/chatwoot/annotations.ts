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

function keyOf(tenantId: bigint, instanceId: bigint, messageId: number) {
  return `${tenantId}:${instanceId}:${messageId}`;
}

function sweep(nowMs: number): void {
  for (const [k, v] of store) {
    if (nowMs - v.at > TTL_MS) store.delete(k);
  }
  // NOTE: Map iteration is insertion-ordered and stash() re-inserts on update, so evicting from the
  // front drops the oldest annotations when a burst outruns the TTL.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
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
  sweep(nowMs);
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
    if (!hit || nowMs - hit.at > TTL_MS) continue;
    row.transcribedText ??= hit.note.transcribedText ?? null;
    row.imageDescription ??= hit.note.imageDescription ?? null;
    row.extractedText ??= hit.note.extractedText ?? null;
  }
}

// NOTE: Test isolation only — production never clears the store wholesale (the TTL does).
export function clearMediaAnnotations(): void {
  store.clear();
}
