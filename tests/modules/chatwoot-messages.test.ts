import { describe, expect, test } from "bun:test";
import {
  buildQuoteResolver,
  parseChatwootMessages,
  pendingIncoming,
  toRenderable,
} from "@/modules/chatwoot/messages";
import { renderInboundMessage } from "@/modules/chatwoot/render";

describe("parseChatwootMessages", () => {
  test("parses { payload } with integer message_type, sorted by id", () => {
    const rows = parseChatwootMessages({
      payload: [
        { id: 2, content: "b", message_type: 1, private: false },
        { id: 1, content: "a", message_type: 0, private: false },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows[0]).toEqual({
      id: 1,
      content: "a",
      createdAt: null,
      emailSubject: null,
      messageType: "incoming",
      private: false,
      sendId: null,
      attachmentTypes: [],
      transcribedText: null,
      imageDescription: null,
      extractedText: null,
      attachmentName: null,
      location: null,
      inReplyTo: null,
      isReaction: false,
      activityType: null,
      senderType: null,
      externalSenderName: null,
      imported: false,
      senderId: null,
    });
    expect(rows[1]?.messageType).toBe("outgoing");
  });

  // ISSUE #749: quando a mensagem chegou. Chatwoot manda `created_at` em SEGUNDOS desde a época,
  // o que um `new Date(v)` leria como 1970 — uma idade de 56 anos onde a mensagem tem minutos.
  // A forma ISO é aceita porque outras rotas da mesma API mandam assim, e o que não dá para ler
  // vira `null`, nunca um instante inventado: a variável de idade prefere sumir a mentir.
  test("lê o instante da mensagem, em época ou ISO, e nunca inventa um", () => {
    const rows = parseChatwootMessages({
      payload: [
        { id: 1, content: "a", created_at: 1_726_000_000 },
        { id: 2, content: "b", created_at: "2026-09-17T12:00:00Z" },
        { id: 3, content: "c", created_at: "1726000000" },
        { id: 4, content: "d", created_at: "ontem" },
        { id: 5, content: "e" },
      ],
    });
    expect(rows[0]?.createdAt?.toISOString()).toBe(
      new Date(1_726_000_000_000).toISOString(),
    );
    expect(rows[1]?.createdAt?.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    // A mesma época, mandada como texto: é assim que ela chega em parte das rotas.
    expect(rows[2]?.createdAt?.getTime()).toBe(1_726_000_000_000);
    expect(rows[3]?.createdAt).toBeNull();
    expect(rows[4]?.createdAt).toBeNull();
  });

  // ISSUE #642: the one structural field an activity row has. Chatwoot sets it on the activities
  // that declare what they narrate (a status change writes `conversation_status_changed`), and never
  // on a label change, which ships as a localized sentence and nothing else.
  test("reads the activity type a row declares, and only as a string", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 1,
          content: "Conversa resolvida",
          message_type: 2,
          content_attributes: {
            activity: { type: "conversation_status_changed", status: "open" },
          },
        },
        { id: 2, content: "Fulano adicionou vip", message_type: 2 },
        {
          id: 3,
          content: "x",
          message_type: 2,
          content_attributes: { activity: { type: { not: "a string" } } },
        },
        {
          id: 4,
          content: "x",
          message_type: 2,
          content_attributes: { activity: "not a bag" },
        },
      ],
    });
    expect(rows.map((r) => r.activityType)).toEqual([
      "conversation_status_changed",
      null,
      null,
      null,
    ]);
  });

  test("accepts a bare array and tolerates the webhook string form", () => {
    const rows = parseChatwootMessages([
      { id: 5, content: "x", message_type: "incoming" },
    ]);
    expect(rows[0]?.messageType).toBe("incoming");
  });

  test("drops items without a numeric id", () => {
    const rows = parseChatwootMessages({
      payload: [
        { content: "no id" },
        { id: 3, content: "ok", message_type: 0 },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual([3]);
  });

  test("maps activity/template/unknown types to a non-incoming bucket", () => {
    const rows = parseChatwootMessages({
      payload: [
        { id: 1, content: "a", message_type: 2 },
        { id: 2, content: "b", message_type: 3 },
        { id: 3, content: "c", message_type: 99 },
      ],
    });
    expect(rows.map((r) => r.messageType)).toEqual([
      "activity",
      "template",
      "other",
    ]);
  });

  test("extracts attachment types, transcribed_text meta, and in_reply_to", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 10,
          content: "",
          message_type: 0,
          attachments: [
            {
              id: 1,
              file_type: "audio",
              meta: { transcribed_text: "oi tudo bem" },
            },
          ],
          content_attributes: { in_reply_to: 7 },
        },
      ],
    });
    expect(rows[0]?.attachmentTypes).toEqual(["audio"]);
    expect(rows[0]?.transcribedText).toBe("oi tudo bem");
    expect(rows[0]?.inReplyTo).toBe(7);
  });

  // Issue #691: `metaStringFrom` said it in its own comment — "read from the first attachment that
  // carries it" — so a message whose three attachments were all extracted surfaced one of them.
  test("every extracted attachment reaches the row, labelled by file name", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 10,
          content: "",
          message_type: 0,
          attachments: [
            {
              id: 1,
              file_type: "image",
              data_url: "https://cw.example/blobs/pedido.png?x=1",
              meta: { image_description: "Detalhe do Pedido 40000001" },
            },
            {
              id: 2,
              file_type: "image",
              data_url: "https://cw.example/blobs/comprovante.jpg",
              meta: { image_description: "Comprovante PIX de R$ 777,77" },
            },
            {
              id: 3,
              file_type: "file",
              data_url: "https://cw.example/blobs/cnh.pdf",
              meta: { extracted_text: "CNH do titular" },
            },
          ],
        },
      ],
    });
    expect(rows[0]?.imageDescription).toBe(
      "[pedido.png] Detalhe do Pedido 40000001\n\n[comprovante.jpg] Comprovante PIX de R$ 777,77",
    );
    // O documento não some porque havia imagem: são campos diferentes e os dois chegam.
    expect(rows[0]?.extractedText).toBe("CNH do titular");
  });

  // A etiqueta só existe para separar arquivos. Com um anexo ela seria ruído, e mudaria o texto de
  // toda mensagem que já funcionava.
  test("a single attachment keeps the bare text, with no label", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 11,
          content: "",
          message_type: 0,
          attachments: [
            {
              id: 1,
              file_type: "image",
              data_url: "https://cw.example/blobs/unico.png",
              meta: { image_description: "Detalhe do Pedido 40000001" },
            },
          ],
        },
      ],
    });
    expect(rows[0]?.imageDescription).toBe("Detalhe do Pedido 40000001");
  });

  // Um anexo sem url utilizável ainda precisa ser distinguível do vizinho.
  test("an attachment with no usable name falls back to its position", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 12,
          content: "",
          message_type: 0,
          attachments: [
            { id: 1, file_type: "image", meta: { image_description: "um" } },
            { id: 2, file_type: "image", meta: { image_description: "dois" } },
          ],
        },
      ],
    });
    expect(rows[0]?.imageDescription).toBe(
      "[arquivo 1] um\n\n[arquivo 2] dois",
    );
  });

  // NOTE: Issue #45 — the debounce re-fetch path must carry the pin the same way the direct path
  // does, and the maps-URL basename ("maps") must stop leaking as a fake file name.
  test("location attachment: coordinates ride the REST row into the renderable", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 11,
          content: "",
          message_type: 0,
          attachments: [
            {
              id: 2,
              file_type: "location",
              coordinates_lat: -23.5505,
              coordinates_long: -46.6333,
              fallback_title: "Padaria do Zé",
              data_url: "https://maps.google.com/maps?q=-23.5505,-46.6333",
            },
          ],
        },
      ],
    });
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    const renderable = toRenderable(row);
    expect(renderable.location).toEqual({
      latitude: -23.5505,
      longitude: -46.6333,
      title: "Padaria do Zé",
    });
    const out = renderInboundMessage(renderable);
    expect(out).toBe(
      '<localização latitude="-23.5505" longitude="-46.6333" titulo="Padaria do Zé">',
    );
  });

  // THE NAME A SEND GAVE ITSELF, read back so a delivery can be proved by identity rather than by
  // matching text (issue #499). The bag is shared with Chatwoot's own keys and with whatever an
  // operator's automation writes there, so anything that is not a string is somebody else's key
  // colliding with ours, not a name this build wrote.
  test("reads the send id, and only when it is a string", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 1,
          content: "nossa",
          message_type: 1,
          content_attributes: { fazer_ai_send_id: "abc-123" },
        },
        {
          id: 2,
          content: "de outra pessoa",
          message_type: 1,
          content_attributes: { in_reply_to: 1 },
        },
        {
          id: 3,
          content: "colisão",
          message_type: 1,
          content_attributes: { fazer_ai_send_id: 7 },
        },
        { id: 4, content: "sem bag", message_type: 1 },
      ],
    });
    expect(rows.map((r) => r.sendId)).toEqual(["abc-123", null, null, null]);
  });
});

describe("pendingIncoming", () => {
  const msgs = parseChatwootMessages({
    payload: [
      { id: 1, content: "oi", message_type: 0, private: false },
      { id: 2, content: "tudo bem?", message_type: 0, private: false },
      { id: 3, content: "(nota privada)", message_type: 0, private: true },
      { id: 4, content: "resposta", message_type: 1, private: false },
      { id: 5, content: "   ", message_type: 0, private: false },
    ],
  });

  test("watermark null → incoming, non-private, non-empty only", () => {
    expect(pendingIncoming(msgs, null).map((m) => m.id)).toEqual([1, 2]);
  });

  test("watermark excludes already-handled ids", () => {
    expect(pendingIncoming(msgs, 1).map((m) => m.id)).toEqual([2]);
    expect(pendingIncoming(msgs, 2).map((m) => m.id)).toEqual([]);
  });

  test("includes an incoming voice note (empty content, has attachment)", () => {
    const withAudio = parseChatwootMessages({
      payload: [
        {
          id: 1,
          content: "",
          message_type: 0,
          attachments: [{ id: 9, file_type: "audio" }],
        },
      ],
    });
    expect(pendingIncoming(withAudio, null).map((m) => m.id)).toEqual([1]);
  });
});

describe("buildQuoteResolver", () => {
  const msgs = parseChatwootMessages({
    payload: [
      { id: 10, content: "Qual o horário?", message_type: 0 },
      {
        id: 11,
        content: "",
        message_type: 0,
        attachments: [
          {
            id: 1,
            file_type: "audio",
            meta: { transcribed_text: "ouça isto" },
          },
        ],
      },
      { id: 12, content: "   ", message_type: 0 },
    ],
  });

  test("resolves a quoted message's text by id (content or transcription)", () => {
    const resolve = buildQuoteResolver(msgs);
    expect(resolve(10)).toBe("Qual o horário?");
    // Voice note: falls back to the written-back transcription.
    expect(resolve(11)).toBe("ouça isto");
    // Whitespace-only / unknown ids resolve to null.
    expect(resolve(12)).toBeNull();
    expect(resolve(999)).toBeNull();
  });
});
