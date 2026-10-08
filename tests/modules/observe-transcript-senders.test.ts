import { describe, expect, test } from "bun:test";
import { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type ChatwootMessageRow,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import { renderTranscript, transcriptFromRows } from "@/modules/observe/job";

// The observer cannot judge "a person already answered here" if the AI agent's own words read as a
// person's. Bot replies carry the bot as sender; the case opening goes out on the admin token and
// would read as a user, so the platform marks that send itself.
const MARK = "fazer_ai_platform_sent";
const OUR_BOT = 41;

const row = (
  id: number,
  messageType: "incoming" | "outgoing" | "template",
  content: string,
  extra: Partial<ChatwootMessageRow> = {},
) =>
  ({
    id,
    content,
    messageType,
    private: false,
    isReaction: false,
    activityType: null,
    senderType: null,
    senderId: null,
    visuals: [],
    externalSenderName: null,
    imported: false,
    transcribedText: null,
    imageDescription: null,
    extractedText: null,
    attachmentTypes: [],
    attachmentName: null,
    location: null,
    inReplyTo: null,
    ...extra,
  }) as unknown as ChatwootMessageRow;

const lines = (rows: ChatwootMessageRow[]) =>
  renderTranscript(
    transcriptFromRows(rows, 20, { ownBotIds: new Set([OUR_BOT]) }),
  ).split("\n");

describe("who wrote each line of the observer's transcript", () => {
  test("the AI's reply and template read apart from a person's reply", () => {
    const out = lines([
      row(1, "incoming", "quero cancelar"),
      row(2, "outgoing", "Recebemos seu pedido", {
        senderType: "agent_bot",
        senderId: OUR_BOT,
      }),
      row(3, "template", "Retomando seu atendimento", {
        senderType: "agent_bot",
        senderId: OUR_BOT,
      }),
      row(4, "outgoing", "Já cancelei pelo painel", {
        senderType: "user",
        senderId: 7,
      }),
      row(5, "incoming", "obrigado"),
    ]);
    expect(out).toEqual([
      "Cliente: quero cancelar",
      "Assistente virtual: Recebemos seu pedido",
      "Assistente virtual: Retomando seu atendimento",
      "Atendente (pessoa): Já cancelei pelo painel",
      "Cliente: obrigado",
    ]);
  });

  test("a message the platform sent on the admin token is the AI's, a hand-typed one by the same user is a person's", () => {
    const out = lines([
      row(1, "outgoing", "Recebemos sua solicitação pelo WhatsApp", {
        senderType: "user",
        senderId: 1,
        platformSent: true,
      } as Partial<ChatwootMessageRow>),
      row(2, "outgoing", "Oi, sou eu de novo", {
        senderType: "user",
        senderId: 1,
      }),
      row(3, "incoming", "ok"),
    ]);
    expect(out[0]).toBe(
      "Assistente virtual: Recebemos sua solicitação pelo WhatsApp",
    );
    expect(out[1]).toBe("Atendente (pessoa): Oi, sou eu de novo");
  });

  test("what cannot be attributed keeps the generic label", () => {
    const out = lines([
      row(1, "incoming", "preciso de ajuda"),
      row(2, "outgoing", "Chamado registrado", { imported: true }),
      row(3, "outgoing", "Avalie nosso atendimento"),
      row(4, "outgoing", "Resposta antiga", {
        imported: true,
        senderType: "user",
        senderId: 7,
      }),
      row(5, "outgoing", "Sou outro bot", {
        senderType: "agent_bot",
        senderId: 99,
      }),
    ]);
    expect(out.slice(1)).toEqual([
      "Atendente: Chamado registrado",
      "Atendente: Avalie nosso atendimento",
      "Atendente: Resposta antiga",
      "Atendente: Sou outro bot",
    ]);
  });

  test("a paired-phone reply is a person only where the provider's echo can be trusted", () => {
    const phone = [
      row(1, "outgoing", "Liguei pra você agora", {
        externalSenderName: "WhatsApp",
      }),
    ];
    const trusted = renderTranscript(
      transcriptFromRows(phone, 20, { trustPhoneEcho: true }),
    );
    expect(trusted).toBe("Atendente (pessoa): Liguei pra você agora");
    // On a provider that does not reserve echo ids, a lost send response comes back as this same
    // shape carrying the AI's own reply, so it is not called a person.
    expect(renderTranscript(transcriptFromRows(phone, 20))).toBe(
      "Atendente: Liguei pra você agora",
    );
  });

  test("without the instance's bots nothing is attributed to the AI", () => {
    const out = renderTranscript(
      transcriptFromRows(
        [
          row(1, "outgoing", "Recebemos seu pedido", {
            senderType: "agent_bot",
            senderId: OUR_BOT,
          }),
        ],
        20,
      ),
    );
    expect(out).toBe("Atendente: Recebemos seu pedido");
  });
});

describe("the platform marks what it sends on the admin token", () => {
  test("sendMessageAsAdmin carries the mark", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new ChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "admin",
        botToken: "bot",
      },
      fetchImpl,
    );
    await client.sendMessageAsAdmin(10, "oi", { private: false });
    expect(bodies[0]?.content_attributes).toEqual({ [MARK]: true });
  });

  test("the mark is read back on the row, and only as true", () => {
    const rows = parseChatwootMessages({
      payload: [
        {
          id: 1,
          content: "a",
          message_type: 1,
          content_attributes: { [MARK]: true },
          sender: { type: "user", id: 1 },
        },
        {
          id: 2,
          content: "b",
          message_type: 1,
          content_attributes: { [MARK]: "true" },
        },
        { id: 3, content: "c", message_type: 1 },
      ],
    });
    expect(
      rows.map((r) => (r as { platformSent?: boolean }).platformSent),
    ).toEqual([true, false, false]);
  });
});
