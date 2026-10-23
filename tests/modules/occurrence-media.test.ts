import { afterEach, describe, expect, test } from "bun:test";
import {
  clearMediaAnnotations,
  type MediaAnnotation,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import {
  type MediaState,
  READING_MEDIA_GRACE_MS,
  settleMedia,
} from "@/modules/occurrences/media";

// Every state a customer message's media can be in when the occurrence monitor reads it, and what
// the reading does with each: read, read with the renderer's marker, or defer to the next round.
// The reading never waits: the content is here or not, and the message's age decides.
// One table: a state nobody listed is a row missing here.

const T = 31n;
const I = 41n;
const NOW = new Date("2026-10-22T12:00:00Z");
const YOUNG = new Date(NOW.getTime() - 60_000);
const OLD = new Date(NOW.getTime() - READING_MEDIA_GRACE_MS - 60_000);
const at = (messageId: number) => ({ tenantId: T, instanceId: I, messageId });

function row(
  id: number,
  over: Partial<ChatwootMessageRow> = {},
): ChatwootMessageRow {
  return {
    id,
    content: "",
    createdAt: YOUNG,
    messageType: "incoming",
    private: false,
    sendId: null,
    emailSubject: null,
    attachmentTypes: [],
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

const file = (k: number, meta: string | null = null) => ({
  id: 90 + k,
  dataUrl: `https://cdn.example/${k}.jpg`,
  name: null,
  imageDescription: meta,
  extractedText: null,
});
const audio = { attachmentTypes: ["audio"] };
const pictures = (...meta: Array<string | null>) => ({
  attachmentTypes: meta.map(() => "image"),
  visuals: meta.map((m, k) => file(k, m)),
});

interface Case {
  name: string;
  rows: ChatwootMessageRow[];
  // What this process holds for message 1 (the arrival pass's result).
  stash?: MediaAnnotation;
  verdict: "read" | "defer";
  states: MediaState[];
  expectRow?: (rows: ChatwootMessageRow[]) => void;
}

const CASES: Case[] = [
  {
    name: "no attachments",
    rows: [row(1, { content: "meu ingresso não chegou" })],
    verdict: "read",
    states: ["none"],
  },
  {
    name: "an outgoing message with an empty attachment is not the customer's",
    rows: [row(1, { messageType: "outgoing", ...pictures(null) })],
    verdict: "read",
    states: ["none"],
  },
  {
    name: "audio transcribed on the attachment",
    rows: [row(1, { ...audio, transcribedText: "quero o reembolso" })],
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "audio transcribed and held only in memory",
    rows: [row(1, audio)],
    stash: { transcribedText: "quero o reembolso" },
    verdict: "read",
    states: ["complete"],
    expectRow: (r) => expect(r[0]?.transcribedText).toBe("quero o reembolso"),
  },
  {
    name: "audio transcribed to nothing",
    rows: [row(1, audio)],
    stash: { transcriptionEmpty: true },
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "recent audio with no words yet (still transcribing, or never will be)",
    rows: [row(1, audio)],
    verdict: "defer",
    states: ["incomplete"],
  },
  {
    name: "old audio with no words (never transcribed, or gone from memory on upstream Chatwoot)",
    rows: [row(1, { ...audio, createdAt: OLD })],
    verdict: "read",
    states: ["incomplete"],
  },
  {
    name: "recent audio with no time on the message reads as old",
    rows: [row(1, { ...audio, createdAt: null })],
    verdict: "read",
    states: ["incomplete"],
  },
  {
    name: "image described on its attachment",
    rows: [row(1, { ...pictures("um boleto"), imageDescription: "um boleto" })],
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "image described and held only in memory",
    rows: [row(1, pictures(null))],
    stash: { imageDescription: "um boleto vencido" },
    verdict: "read",
    states: ["complete"],
    expectRow: (r) => expect(r[0]?.imageDescription).toBe("um boleto vencido"),
  },
  {
    name: "recent image with no description yet",
    rows: [row(1, pictures(null))],
    verdict: "defer",
    states: ["incomplete"],
  },
  {
    name: "old image with no description (never described, or gone from memory on upstream)",
    rows: [row(1, { ...pictures(null), createdAt: OLD })],
    verdict: "read",
    states: ["incomplete"],
  },
  {
    name: "a document whose extraction failed, with the files counted as not read",
    rows: [row(1, { attachmentTypes: ["file"], visuals: [file(0)] })],
    stash: { attachmentsUnread: 1 },
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "two files, the first described on its attachment and the second not yet",
    rows: [
      row(1, {
        ...pictures("o primeiro", null),
        imageDescription: "o primeiro",
      }),
    ],
    verdict: "defer",
    states: ["incomplete"],
  },
  {
    name: "two files, both described on their attachments",
    rows: [
      row(1, {
        ...pictures("o primeiro", "o segundo"),
        imageDescription: "o primeiro",
      }),
    ],
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "an email's inline images, with no attachment type, not read yet",
    rows: [
      row(1, { content: "segue o print", visuals: [file(0)], bodyImages: 1 }),
    ],
    verdict: "defer",
    states: ["incomplete"],
  },
  {
    name: "an email's inline images already gone through",
    rows: [
      row(1, { content: "segue o print", visuals: [file(0)], bodyImages: 1 }),
    ],
    stash: { bodyRead: true },
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "audio and image on one message, the audio heard and the image not yet",
    rows: [
      row(1, {
        attachmentTypes: ["audio", "image"],
        visuals: [file(0)],
        transcribedText: "olha a foto",
      }),
    ],
    verdict: "defer",
    states: ["incomplete"],
  },
  {
    name: "audio and image on one message, both in",
    rows: [
      row(1, {
        attachmentTypes: ["audio", "image"],
        visuals: [file(0)],
      }),
    ],
    stash: { transcribedText: "olha a foto", imageDescription: "um print" },
    verdict: "read",
    states: ["complete"],
  },
  {
    name: "several messages: one complete, one old and incomplete, one recent and incomplete",
    rows: [
      row(1, { ...audio, transcribedText: "oi" }),
      row(2, { ...pictures(null), createdAt: OLD }),
      row(3, audio),
    ],
    verdict: "defer",
    states: ["complete", "incomplete", "incomplete"],
  },
  {
    name: "several messages: the incomplete ones all old",
    rows: [
      row(1, { ...audio, transcribedText: "oi" }),
      row(2, { ...pictures(null), createdAt: OLD }),
      row(3, { ...audio, createdAt: OLD }),
    ],
    verdict: "read",
    states: ["complete", "incomplete", "incomplete"],
  },
];

describe("the reading's decision on a message's media", () => {
  afterEach(() => clearMediaAnnotations());

  for (const c of CASES)
    test(c.name, () => {
      if (c.stash) stashMediaAnnotation(at(1), c.stash);
      const out = settleMedia(T, I, c.rows, NOW);
      expect(out).toEqual({ verdict: c.verdict, states: c.states });
      c.expectRow?.(c.rows);
    });

  test("the grace period is the line between deferring and reading", () => {
    const edge = (ms: number) => [
      row(1, { ...audio, createdAt: new Date(NOW.getTime() - ms) }),
    ];
    expect(
      settleMedia(T, I, edge(READING_MEDIA_GRACE_MS - 1), NOW).verdict,
    ).toBe("defer");
    expect(settleMedia(T, I, edge(READING_MEDIA_GRACE_MS), NOW).verdict).toBe(
      "read",
    );
  });
});
