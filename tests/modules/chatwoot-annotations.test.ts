import { beforeEach, describe, expect, test } from "bun:test";
import {
  awaitOpenTranscriptions,
  clearMediaAnnotations,
  fileReadFor,
  mediaAnnotationCount,
  nextSweepDelayMs,
  openTranscription,
  overlayMediaAnnotations,
  rememberFileRead,
  stashMediaAnnotation,
  sweepMediaAnnotations,
} from "@/modules/chatwoot/annotations";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";

// The in-process media-annotation fallback: the eager STT/vision pass stashes every
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
    sendId: null,
    emailSubject: null,
    attachmentTypes: ["audio"],
    transcribedText: null,
    imageDescription: null,
    extractedText: null,
    attachmentName: null,
    inReplyTo: null,
    isReaction: false,
    activityType: null,
    senderType: null,
    visuals: [],
    externalSenderName: null,
    imported: false,
    senderId: null,
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
      // NOTE: meta already carries the transcription (the fork write-back landed): it stays
      // authoritative.
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
    // NOTE: no further stash happens: this is the idle process, where only the scheduled sweeper
    // (which calls exactly this function) can reclaim the entry.
    sweepMediaAnnotations(1_000 + 16 * 60_000);
    expect(mediaAnnotationCount()).toBe(0);
  });

  test("a file's vision read is deleted by the sweep too, and the next wake-up counts it", () => {
    rememberFileRead(
      "vision:1:2:3:4:read",
      { kind: "image", text: "foto" },
      1_000,
    );
    expect(fileReadFor("vision:1:2:3:4:read", 1_000 + 60_000)).not.toBeNull();
    expect(fileReadFor("vision:1:2:3:4:read", 1_000 + 16 * 60_000)).toBeNull();
    expect(nextSweepDelayMs(1_000 + 60_000)).toBe(14 * 60_000);
    sweepMediaAnnotations(1_000 + 60_000);
    expect(mediaAnnotationCount()).toBe(1);
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
    // This is the instant the scheduled sweep wakes at; a strict `>` would keep the entry and
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

// The transcriptions in flight, which a flush waits for before rendering a voice note as unheard.
describe("transcriptions in flight", () => {
  beforeEach(() => clearMediaAnnotations());
  const target = (messageId: number) => ({
    tenantId: T1,
    instanceId: I1,
    messageId,
  });

  test("nothing open: no wait, and the answer says so", async () => {
    const started = Date.now();
    expect(
      await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 5000 }),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("the wait ends when the transcription closes, well before the bound", async () => {
    const close = openTranscription(target(1));
    setTimeout(close, 50);
    const started = Date.now();
    expect(
      await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 5000 }),
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("one bound for the whole burst, not one per message", async () => {
    openTranscription(target(1));
    openTranscription(target(2));
    const started = Date.now();
    await awaitOpenTranscriptions(T1, I1, [1, 2], { timeoutMs: 150 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(280);
  });

  test("every message is waited for, not only the first to close", async () => {
    const one = openTranscription(target(1));
    const two = openTranscription(target(2));
    setTimeout(one, 20);
    setTimeout(two, 200);
    const started = Date.now();
    await awaitOpenTranscriptions(T1, I1, [1, 2], { timeoutMs: 5000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  test("two passes over one message keep it open until both settle, and a close counts once", async () => {
    const first = openTranscription(target(1));
    const second = openTranscription(target(1));
    first();
    first();
    expect(await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 0 })).toBe(
      true,
    );
    second();
    expect(await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 0 })).toBe(
      false,
    );
  });

  test("words stashed end the wait, with the pass still writing them back", async () => {
    openTranscription(target(1));
    setTimeout(
      () => stashMediaAnnotation(target(1), { transcribedText: "palavras" }),
      50,
    );
    const started = Date.now();
    expect(
      await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 5000 }),
    ).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("the words and then the close of one message count once, while another is still open", async () => {
    const one = openTranscription(target(1));
    openTranscription(target(2));
    setTimeout(() => {
      stashMediaAnnotation(target(1), { transcribedText: "palavras" });
      one();
    }, 20);
    const started = Date.now();
    await awaitOpenTranscriptions(T1, I1, [1, 2], { timeoutMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  test("an empty transcription stashed ends the wait too", async () => {
    openTranscription(target(1));
    setTimeout(
      () => stashMediaAnnotation(target(1), { transcriptionEmpty: true }),
      50,
    );
    const started = Date.now();
    await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a vision annotation does not end a transcription's wait", async () => {
    openTranscription(target(1));
    setTimeout(
      () => stashMediaAnnotation(target(1), { imageDescription: "foto" }),
      20,
    );
    const started = Date.now();
    await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  test("a message whose words are already stashed is not waited for", async () => {
    openTranscription(target(1));
    stashMediaAnnotation(target(1), { transcribedText: "palavras" });
    expect(
      await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 5000 }),
    ).toBe(false);
  });

  test("the job's signal ends the wait", async () => {
    openTranscription(target(1));
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    const started = Date.now();
    await awaitOpenTranscriptions(T1, I1, [1], {
      timeoutMs: 5000,
      signal: abort.signal,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("another tenant's or instance's open transcription is not this message", async () => {
    openTranscription({ tenantId: T1 + 1n, instanceId: I1, messageId: 1 });
    openTranscription({ tenantId: T1, instanceId: I1 + 1n, messageId: 1 });
    expect(await awaitOpenTranscriptions(T1, I1, [1], { timeoutMs: 0 })).toBe(
      false,
    );
  });
});
