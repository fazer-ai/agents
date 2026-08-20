import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  listChatwootAccounts,
  parseChatwootAccounts,
  parseInboxList,
} from "@/modules/chatwoot/management";
import {
  firstAudioAttachment,
  firstLocationAttachment,
  isIncomingMessage,
  isNewIncomingMessage,
  normalizeChatwootEvent,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { verifyChatwootSignature } from "@/modules/chatwoot/signing";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import {
  hasPendingInboundMediaUpdate,
  runEagerMedia,
} from "@/modules/chatwoot/webhook";

const sign = (secret: string, ts: number, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

describe("verifyChatwootSignature", () => {
  const secret = "bot-webhook-secret";
  const body = '{"event":"message_created"}';
  const now = 1_700_000_000;

  test("accepts a valid signature within the window", () => {
    expect(
      verifyChatwootSignature({
        secret,
        rawBody: body,
        signatureHeader: sign(secret, now, body),
        timestampHeader: String(now),
        nowSeconds: now + 10,
      }),
    ).toBe(true);
  });

  test("rejects tampered body, wrong secret and missing headers", () => {
    const sig = sign(secret, now, body);
    expect(
      verifyChatwootSignature({
        secret,
        rawBody: `${body} `,
        signatureHeader: sig,
        timestampHeader: String(now),
        nowSeconds: now,
      }),
    ).toBe(false);
    expect(
      verifyChatwootSignature({
        secret: "wrong",
        rawBody: body,
        signatureHeader: sig,
        timestampHeader: String(now),
        nowSeconds: now,
      }),
    ).toBe(false);
    expect(
      verifyChatwootSignature({
        secret,
        rawBody: body,
        signatureHeader: null,
        timestampHeader: String(now),
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  test("rejects a stale timestamp (replay guard)", () => {
    expect(
      verifyChatwootSignature({
        secret,
        rawBody: body,
        signatureHeader: sign(secret, now, body),
        timestampHeader: String(now),
        nowSeconds: now + 10_000,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });
});

describe("normalizeChatwootEvent", () => {
  test("conversation_* event: fields at top level", () => {
    const e = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 42,
      inbox_id: 7,
      status: "pending",
      // The fork embeds the full ContactInbox association (push_data → contact_inbox).
      contact_inbox: { id: 7700, source_id: "5511999990000", inbox_id: 7 },
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
      changed_attributes: [{ status: ["open", "pending"] }],
    });
    expect(e).toMatchObject({
      event: "conversation_updated",
      conversationId: 42,
      contactInboxId: 7700,
      inboxId: 7,
      status: "pending",
      assigneeType: "AgentBot",
      assigneeId: 9,
    });
    expect(e?.changedAttributes).toBeDefined();
  });

  test("message_created: conversation nested, message at top", () => {
    const e = normalizeChatwootEvent({
      event: "message_created",
      id: 1001,
      content: "hello",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 42,
        inbox_id: 7,
        status: "pending",
        contact_inbox: { id: 7701, source_id: "5511999990000" },
        meta: { assignee_type: null, assignee: null },
      },
    });
    expect(e?.conversationId).toBe(42);
    expect(e?.contactInboxId).toBe(7701);
    // No message sender object on this fixture → message.sender is null.
    expect(e?.message?.sender ?? null).toBeNull();
    expect(e?.status).toBe("pending");
    expect(e?.assigneeType).toBeNull();
    expect(e).not.toBeNull();
    expect(e?.message).toMatchObject({
      id: 1001,
      content: "hello",
      messageType: "incoming",
      private: false,
    });
    expect(e && isIncomingMessage(e)).toBe(true);
  });

  test("contact_inbox: flat scalar fallback + absent → null", () => {
    // Tolerate a flat contact_inbox_id scalar (defensive — the object form is what the fork sends).
    const flat = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 42,
      inbox_id: 7,
      status: "pending",
      contact_inbox_id: 7702,
      meta: { assignee_type: null, assignee: null },
    });
    expect(flat?.contactInboxId).toBe(7702);
    // Absent entirely → null (the per-conversation thread fallback kicks in downstream).
    const absent = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 42,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: null, assignee: null },
    });
    expect(absent?.contactInboxId).toBeNull();
  });

  test("message_created: parses the message sender (author) for ingestion role assignment", () => {
    const human = normalizeChatwootEvent({
      event: "message_created",
      id: 1002,
      content: "Posso ajudar?",
      message_type: "outgoing",
      private: false,
      sender: { id: 33, name: "João", type: "user" },
      conversation: { id: 42, inbox_id: 7, status: "open" },
    });
    expect(human?.message?.sender).toEqual({
      type: "user",
      id: 33,
      name: "João",
    });
  });

  test("returns null for a non-object or eventless payload", () => {
    expect(normalizeChatwootEvent(null)).toBeNull();
    expect(normalizeChatwootEvent({ foo: 1 })).toBeNull();
  });

  // NOTE: Issue #45 — the fork ships coordinates_lat/coordinates_long/fallback_title on location
  // attachments (Attachment#location_metadata); the mapper used to drop all three.
  test("location attachment: coordinates + fallback title survive normalization", () => {
    const e = normalizeChatwootEvent({
      event: "message_created",
      id: 1002,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 31,
          file_type: "location",
          coordinates_lat: -23.5505,
          coordinates_long: -46.6333,
          fallback_title: "Padaria do Zé, Rua X, 123",
          data_url: "https://maps.google.com/maps?q=-23.5505,-46.6333",
        },
      ],
      conversation: { id: 42, inbox_id: 7, status: "pending" },
    });
    expect(e?.message?.attachments?.[0]).toMatchObject({
      fileType: "location",
      latitude: -23.5505,
      longitude: -46.6333,
      fallbackTitle: "Padaria do Zé, Rua X, 123",
    });
  });
});

describe("firstLocationAttachment (issue #45)", () => {
  const loc = (over: Record<string, unknown> = {}) => ({
    id: 1,
    fileType: "location",
    dataUrl: null,
    latitude: null as number | null,
    longitude: null as number | null,
    fallbackTitle: null as string | null,
    ...over,
  });

  test("the null island (0,0) without a title is unusable — column defaults, not a real pin", () => {
    expect(
      firstLocationAttachment([loc({ latitude: 0, longitude: 0 })]),
    ).toBeNull();
  });

  test("(0, non-zero) is a real coordinate", () => {
    expect(
      firstLocationAttachment([loc({ latitude: 0, longitude: 9.4 })]),
    ).toEqual({ latitude: 0, longitude: 9.4, title: null });
  });

  test("an empty-string title normalizes to null; coordinates stay usable", () => {
    expect(
      firstLocationAttachment([
        loc({ latitude: -23.5, longitude: -46.6, fallbackTitle: "  " }),
      ]),
    ).toEqual({ latitude: -23.5, longitude: -46.6, title: null });
  });

  test("a title-only pin is usable; non-location attachments are skipped", () => {
    expect(
      firstLocationAttachment([
        loc({ fileType: "image" }),
        loc({ fallbackTitle: "Praça da Sé" }),
      ]),
    ).toEqual({ latitude: null, longitude: null, title: "Praça da Sé" });
  });

  test("no attachments → null", () => {
    expect(firstLocationAttachment(undefined)).toBeNull();
    expect(firstLocationAttachment([])).toBeNull();
  });

  test("boundary coordinates are accepted; out-of-range values are dropped", () => {
    expect(
      firstLocationAttachment([loc({ latitude: 90, longitude: 180 })]),
    ).toEqual({ latitude: 90, longitude: 180, title: null });
    expect(
      firstLocationAttachment([loc({ latitude: -90, longitude: -180 })]),
    ).toEqual({ latitude: -90, longitude: -180, title: null });
    // Provider garbage: no coordinate survives, the title (when present) still does.
    expect(
      firstLocationAttachment([loc({ latitude: 91, longitude: 10 })]),
    ).toBeNull();
    expect(
      firstLocationAttachment([loc({ latitude: 10, longitude: 181 })]),
    ).toBeNull();
    expect(
      firstLocationAttachment([
        loc({ latitude: -91, longitude: 10, fallbackTitle: "Praça da Sé" }),
      ]),
    ).toEqual({ latitude: null, longitude: null, title: "Praça da Sé" });
  });
});

describe("runEagerMedia (eager STT/vision idempotency contract)", () => {
  // The reuse / skip / no-op paths never fetch STT/vision config, so `base` is never touched — pass a
  // throwing stub so any accidental DB access fails the test loudly.
  const base = {} as unknown as PrismaClient;
  const ev = (
    message: NormalizedChatwootEvent["message"],
  ): NormalizedChatwootEvent => ({
    event: "message_created",
    conversationId: 900,
    contactInboxId: 7700,
    inboxId: 7,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    message,
  });

  test("reuses a transcription already on the attachment (no config fetch / no network)", async () => {
    const n = ev({
      id: 1,
      content: "",
      messageType: "incoming",
      private: false,
      attachments: [
        {
          id: 5,
          fileType: "audio",
          dataUrl: "https://x/a.ogg",
          transcribedText: "olá mundo",
        },
      ],
    });
    await runEagerMedia(3n, 5n, n, base);
    expect(n.message?.transcribedText).toBe("olá mundo");
  });

  test("skips when a transcription is already stashed on the event (before-gate + answer-path double-call safety)", async () => {
    const n = ev({
      id: 1,
      content: "",
      messageType: "incoming",
      private: false,
      transcribedText: "já feito",
      attachments: [{ id: 5, fileType: "audio", dataUrl: "https://x/a.ogg" }],
    });
    // A second pass must NOT re-transcribe: the field is set, so it never reaches resolveSttConfig.
    await runEagerMedia(3n, 5n, n, base);
    expect(n.message?.transcribedText).toBe("já feito");
  });

  test("no-op for a text-only message (no attachments)", async () => {
    const n = ev({
      id: 1,
      content: "oi",
      messageType: "incoming",
      private: false,
    });
    await runEagerMedia(3n, 5n, n, base);
    expect(n.message?.transcribedText).toBeUndefined();
    expect(n.message?.imageDescription).toBeUndefined();
  });
});

describe("isNewIncomingMessage (voice-note infinite-loop guard)", () => {
  const incoming = (event: string) =>
    normalizeChatwootEvent({
      event,
      id: 1001,
      content: "",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 42,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      },
    });

  test("true only for a freshly created incoming message", () => {
    const created = incoming("message_created");
    expect(created && isNewIncomingMessage(created)).toBe(true);
  });

  test("false for message_updated (our own STT write-back, re-dispatched by the fork)", () => {
    const updated = incoming("message_updated");
    // It IS still an incoming message...
    expect(updated && isIncomingMessage(updated)).toBe(true);
    // ...but NOT a new one, so it must never re-trigger STT/debounce/turn (else the loop).
    expect(updated && isNewIncomingMessage(updated)).toBe(false);
  });

  test("false for an outgoing message and for conversation events", () => {
    const outgoing = normalizeChatwootEvent({
      event: "message_created",
      id: 2,
      message_type: "outgoing",
      private: false,
      conversation: { id: 42, inbox_id: 7, status: "pending", meta: {} },
    });
    expect(outgoing && isNewIncomingMessage(outgoing)).toBe(false);
    const conv = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 42,
      inbox_id: 7,
      status: "pending",
      meta: {},
    });
    expect(conv && isNewIncomingMessage(conv)).toBe(false);
  });
});

describe("hasPendingInboundMediaUpdate", () => {
  const updatedAudio = (transcribedText?: string) =>
    normalizeChatwootEvent({
      event: "message_updated",
      id: 1001,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 77,
          file_type: "audio",
          data_url: "https://chat.example.com/a.ogg",
          ...(transcribedText === undefined
            ? {}
            : { transcribed_text: transcribedText }),
        },
      ],
      conversation: {
        id: 42,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      },
    });

  test("accepts an incoming update when the attachment first appears without transcription", () => {
    const event = updatedAudio();
    expect(event && hasPendingInboundMediaUpdate(event)).toBe(true);
  });

  test("rejects the write-back update after transcription and never treats it as a new turn", () => {
    const event = updatedAudio("áudio já transcrito");
    expect(event && hasPendingInboundMediaUpdate(event)).toBe(false);
    expect(event && isNewIncomingMessage(event)).toBe(false);
  });

  test("rejects outgoing and message_created events", () => {
    const outgoing = updatedAudio();
    if (outgoing?.message) outgoing.message.messageType = "outgoing";
    expect(outgoing && hasPendingInboundMediaUpdate(outgoing)).toBe(false);

    const created = updatedAudio();
    if (created) created.event = "message_created";
    expect(created && hasPendingInboundMediaUpdate(created)).toBe(false);
  });

  test("rejects a visual attachment update (audio-only guard)", () => {
    // The fork's webhook payload never serializes image_description/extracted_text (only audio
    // carries transcribed_text), so an image update is indistinguishable from our own vision
    // write-back re-dispatch (AttachmentsController#update -> send_update_event). Accepting it
    // would re-run vision on every write-back: a paid call per cycle, forever.
    const event = normalizeChatwootEvent({
      event: "message_updated",
      id: 1002,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 88,
          file_type: "image",
          data_url: "https://chat.example.com/img.jpg",
        },
      ],
      conversation: {
        id: 42,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      },
    });
    expect(event && hasPendingInboundMediaUpdate(event)).toBe(false);
  });
});

describe("audio attachment normalization (STT idempotency seam)", () => {
  const withAudio = (transcribed: string | undefined) =>
    normalizeChatwootEvent({
      event: "message_created",
      id: 9,
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 77,
          file_type: "audio",
          data_url: "https://chat.example.com/a.ogg",
          ...(transcribed === undefined
            ? {}
            : { transcribed_text: transcribed }),
        },
      ],
      conversation: { id: 42, inbox_id: 7, status: "pending", meta: {} },
    });

  test("reads transcribed_text from the payload; empty string normalizes to null", () => {
    expect(
      withAudio("")?.message?.attachments?.[0]?.transcribedText,
    ).toBeNull();
    expect(
      withAudio(undefined)?.message?.attachments?.[0]?.transcribedText,
    ).toBeNull();
    expect(withAudio("olá")?.message?.attachments?.[0]?.transcribedText).toBe(
      "olá",
    );
  });

  test("firstAudioAttachment surfaces the existing transcription (drives eager-STT skip)", () => {
    const done = withAudio("transcrição prévia");
    expect(done && firstAudioAttachment(done)).toMatchObject({
      id: 77,
      dataUrl: "https://chat.example.com/a.ogg",
      transcribedText: "transcrição prévia",
    });
    const fresh = withAudio("");
    expect(fresh && firstAudioAttachment(fresh)?.transcribedText).toBeNull();
  });
});

describe("shouldBotHandle (attribution = source of truth)", () => {
  test("bot handles pending + no human assignee", () => {
    expect(shouldBotHandle({ assigneeType: null, status: "pending" })).toBe(
      true,
    );
    expect(
      shouldBotHandle({ assigneeType: "AgentBot", status: "pending" }),
    ).toBe(true);
  });
  test("bot stays silent when a human is assigned or status is not pending", () => {
    expect(shouldBotHandle({ assigneeType: "User", status: "pending" })).toBe(
      false,
    );
    expect(shouldBotHandle({ assigneeType: null, status: "open" })).toBe(false);
    expect(shouldBotHandle({ assigneeType: null, status: "resolved" })).toBe(
      false,
    );
  });
});

describe("parseInboxList", () => {
  test("parses the live chatwoot-pro shape ({ payload: [...] })", () => {
    // Field names confirmed live against the chatwoot-pro fork.
    const raw = {
      payload: [
        // Official WhatsApp carries a `provider` (drives the 24h service-window gate).
        {
          id: 1,
          name: "WhatsApp Vendas",
          channel_type: "Channel::Whatsapp",
          provider: "whatsapp_cloud",
        },
        // baileys is a Channel::Whatsapp too, but an unofficial provider (no window).
        {
          id: 2,
          name: "WhatsApp Bridge",
          channel_type: "Channel::Whatsapp",
          provider: "baileys",
        },
        { id: 3, name: "Site", channel_type: "Channel::WebWidget" },
      ],
    };
    expect(parseInboxList(raw)).toEqual([
      {
        chatwootInboxId: 1,
        name: "WhatsApp Vendas",
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
      {
        chatwootInboxId: 2,
        name: "WhatsApp Bridge",
        channelType: "Channel::Whatsapp",
        provider: "baileys",
      },
      {
        chatwootInboxId: 3,
        name: "Site",
        channelType: "Channel::WebWidget",
        provider: null,
      },
    ]);
  });

  test("tolerates a bare array, string ids, and missing fields; skips id-less entries", () => {
    const raw = [
      { id: "7", name: "Stringy" },
      { name: "no id" },
      { id: 9 },
      "garbage",
    ];
    expect(parseInboxList(raw)).toEqual([
      {
        chatwootInboxId: 7,
        name: "Stringy",
        channelType: null,
        provider: null,
      },
      {
        chatwootInboxId: 9,
        name: "Inbox 9",
        channelType: null,
        provider: null,
      },
    ]);
  });

  test("returns [] for non-list payloads", () => {
    expect(parseInboxList(null)).toEqual([]);
    expect(parseInboxList({})).toEqual([]);
    expect(parseInboxList({ payload: "nope" })).toEqual([]);
  });
});

describe("parseChatwootAccounts", () => {
  test("parses the profile shape ({ accounts: [...] })", () => {
    const raw = {
      id: 5,
      name: "Op",
      accounts: [
        { id: 1, name: "Acme", role: "administrator" },
        { id: 2, name: "Beta", role: "agent" },
      ],
    };
    expect(parseChatwootAccounts(raw)).toEqual([
      { id: 1, name: "Acme", role: "administrator" },
      { id: 2, name: "Beta", role: "agent" },
    ]);
  });

  test("tolerates a bare array, string ids, and missing fields; skips id-less entries", () => {
    const raw = [{ id: "7", name: "Stringy" }, { name: "no id" }, { id: 9 }];
    expect(parseChatwootAccounts(raw)).toEqual([
      { id: 7, name: "Stringy", role: null },
      { id: 9, name: "Account 9", role: null },
    ]);
  });

  test("returns [] when the token reaches no account", () => {
    expect(parseChatwootAccounts({ accounts: [] })).toEqual([]);
    expect(parseChatwootAccounts(null)).toEqual([]);
    expect(parseChatwootAccounts({ accounts: "nope" })).toEqual([]);
  });
});

describe("listChatwootAccounts", () => {
  test("shapes the injected profile into account summaries", async () => {
    const accounts = await listChatwootAccounts(
      { baseUrl: "https://chat.example.com", token: "tok" },
      {
        fetchProfile: async () => ({
          accounts: [{ id: 3, name: "Tenant", role: "administrator" }],
        }),
      },
    );
    expect(accounts).toEqual([
      { id: 3, name: "Tenant", role: "administrator" },
    ]);
  });

  test("maps a fetch failure to a clean 502 (no token leak)", async () => {
    const token = "super-secret-token";
    let thrown: unknown;
    try {
      await listChatwootAccounts(
        { baseUrl: "https://chat.example.com", token },
        {
          fetchProfile: async () => {
            throw new Error(`401 with ${token}`);
          },
        },
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { statusCode?: number }).statusCode).toBe(502);
    expect((thrown as Error).message).not.toContain(token);
  });

  test("rejects a non-URL baseUrl before any network call", async () => {
    let called = false;
    await expect(
      listChatwootAccounts(
        { baseUrl: "not-a-url", token: "tok" },
        {
          fetchProfile: async () => {
            called = true;
            return { accounts: [] };
          },
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
