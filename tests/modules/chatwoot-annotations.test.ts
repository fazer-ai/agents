import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearMediaAnnotations,
  mediaAnnotationCount,
  nextSweepDelayMs,
  overlayMediaAnnotations,
  stashMediaAnnotation,
  sweepMediaAnnotations,
} from "@/modules/chatwoot/annotations";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";

// The in-process media-annotation fallback (issue #49): the eager STT/vision pass stashes every
// completed annotation here, and the flush overlays what the Chatwoot attachment meta is missing
// (upstream Chatwoot has no fork meta route, so the write-back 404s and the meta stays empty).

const T1 = 11n;
const I1 = 21n;

function row(over: Partial<ChatwootMessageRow> = {}): ChatwootMessageRow {
  return {
    id: 1,
    content: "",
    messageType: "incoming",
    private: false,
    attachmentTypes: ["audio"],
    transcribedText: null,
    imageDescription: null,
    extractedText: null,
    attachmentName: null,
    inReplyTo: null,
    isReaction: false,
    location: null,
    ...over,
  };
}

describe("media annotations (issue #49)", () => {
  beforeEach(() => {
    clearMediaAnnotations();
  });

  test("overlay fills only the fields the meta is missing", () => {
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "do cache" },
    );
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 2 },
      { transcribedText: "cache perdedor" },
    );
    const rows = [
      row({ id: 1 }),
      // NOTE: Meta already carries the transcription (fork write-back landed) — it stays authoritative.
      row({ id: 2, transcribedText: "do meta" }),
      row({ id: 3 }),
    ];
    overlayMediaAnnotations(T1, I1, rows);
    expect(rows[0]?.transcribedText).toBe("do cache");
    expect(rows[1]?.transcribedText).toBe("do meta");
    expect(rows[2]?.transcribedText).toBeNull();
  });

  test("overlay is fenced by tenant and instance", () => {
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "do cache" },
    );
    const otherTenant = [row({ id: 1 })];
    overlayMediaAnnotations(99n, I1, otherTenant);
    expect(otherTenant[0]?.transcribedText).toBeNull();
    const otherInstance = [row({ id: 1 })];
    overlayMediaAnnotations(T1, 99n, otherInstance);
    expect(otherInstance[0]?.transcribedText).toBeNull();
  });

  test("stash merges fields per message (STT + vision on the same message)", () => {
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 5 },
      { transcribedText: "áudio" },
    );
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 5 },
      { imageDescription: "uma foto" },
    );
    const rows = [row({ id: 5 })];
    overlayMediaAnnotations(T1, I1, rows);
    expect(rows[0]?.transcribedText).toBe("áudio");
    expect(rows[0]?.imageDescription).toBe("uma foto");
  });

  test("annotations expire after the TTL", () => {
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "efêmero" },
      1_000,
    );
    const fresh = [row({ id: 1 })];
    overlayMediaAnnotations(T1, I1, fresh, 1_000 + 60_000);
    expect(fresh[0]?.transcribedText).toBe("efêmero");
    const stale = [row({ id: 1 })];
    overlayMediaAnnotations(T1, I1, stale, 1_000 + 16 * 60_000);
    expect(stale[0]?.transcribedText).toBeNull();
  });

  test("the TTL sweep DELETES idle annotations, it does not merely hide them", () => {
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "conteúdo do cliente" },
      1_000,
    );
    expect(mediaAnnotationCount()).toBe(1);
    // NOTE: No further stash happens — this is the idle process, where only the scheduled sweeper
    // (which calls exactly this function) can reclaim the entry.
    sweepMediaAnnotations(1_000 + 16 * 60_000);
    expect(mediaAnnotationCount()).toBe(0);
  });

  test("the sweep keeps annotations that are still inside the TTL", () => {
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "ainda válido" },
      1_000,
    );
    sweepMediaAnnotations(1_000 + 60_000);
    expect(mediaAnnotationCount()).toBe(1);
  });

  test("the sweep is scheduled for the earliest expiry, not a flat TTL from the last stash", () => {
    const t0 = 1_000;
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "A" },
      t0,
    );
    const later = t0 + 14 * 60_000;
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 2 },
      { transcribedText: "B" },
      later,
    );
    // NOTE: A expires one minute from `later`; a flat TTL_MS delay would wait fifteen instead, so B
    // would then linger for nearly a second TTL after A's sweep.
    expect(nextSweepDelayMs(later)).toBe(60_000);
    // After A is reclaimed, the next wake-up follows B's own expiry.
    sweepMediaAnnotations(t0 + 16 * 60_000);
    expect(mediaAnnotationCount()).toBe(1);
    expect(nextSweepDelayMs(t0 + 16 * 60_000)).toBe(13 * 60_000);
  });

  test("an annotation is reclaimed exactly at the TTL boundary", () => {
    const t0 = 1_000;
    stashMediaAnnotation(
      { tenantId: T1, instanceId: I1, messageId: 1 },
      { transcribedText: "no limite" },
      t0,
    );
    // NOTE: This is the instant the scheduled sweep wakes at; a strict `>` would keep the entry and
    // re-arm a zero-delay timer forever instead of deleting it.
    const boundary = t0 + 15 * 60_000;
    const rows = [row({ id: 1 })];
    overlayMediaAnnotations(T1, I1, rows, boundary);
    expect(rows[0]?.transcribedText).toBeNull();
    sweepMediaAnnotations(boundary);
    expect(mediaAnnotationCount()).toBe(0);
  });

  test("no sweep is scheduled when nothing is retained", () => {
    expect(nextSweepDelayMs(1_000)).toBeNull();
  });

  test("the size cap evicts the oldest stashes first", () => {
    for (let i = 1; i <= 2001; i++) {
      stashMediaAnnotation(
        { tenantId: T1, instanceId: I1, messageId: i },
        { transcribedText: `t${i}` },
      );
    }
    const rows = [row({ id: 1 }), row({ id: 2001 })];
    overlayMediaAnnotations(T1, I1, rows);
    expect(rows[0]?.transcribedText).toBeNull();
    expect(rows[1]?.transcribedText).toBe("t2001");
  });
});
