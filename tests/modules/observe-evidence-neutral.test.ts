import { describe, expect, test } from "bun:test";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import {
  type RenderableMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";
import { transcriptFromRows } from "@/modules/observe/job";

// The observer reads the conversation to judge it, it never answers the customer, so an instruction
// meant for the responder ("peça que o cliente reenvie") is noise there and can bias the verdict.
const INSTRUCAO = /\bpe[çc]a\b|reenvi|se a resposta depender/i;

const observer = (m: RenderableMessage) =>
  renderInboundMessage(m, { audience: "observer" });

const base: RenderableMessage = { text: "", attachmentTypes: [] };

describe("observer audience: markers state facts, never instructions", () => {
  test("an unread image with no name says it arrived and was not read", () => {
    const out = observer({ ...base, attachmentTypes: ["image"] });
    expect(out).toContain("imagem");
    expect(out).toContain("não foi possível ler");
    expect(out).not.toMatch(INSTRUCAO);
  });

  test("a named unread image keeps the name and the cause, with no request", () => {
    const out = observer({
      ...base,
      attachmentTypes: ["image"],
      unreadFiles: [{ name: "foto.heic", cause: "format" }],
      attachmentsUnread: 1,
    });
    expect(out).toContain('nome="foto.heic"');
    expect(out).toContain('motivo="formato"');
    expect(out).not.toMatch(INSTRUCAO);
  });

  test("each cause, the nameless file and the tail over the cap are facts", () => {
    const out = observer({
      ...base,
      extractedText: "x",
      unreadFiles: [
        { name: "a.pdf", cause: "format" },
        { name: "", cause: "too_large" },
        { name: "b.png", cause: "failed" },
      ],
      attachmentsUnread: 4,
    });
    expect(out).toContain("<documento>x</documento>");
    expect(out).toContain('quantidade="4"');
    expect(out).toContain('nome="a.pdf" motivo="formato"');
    expect(out).toContain('motivo="grande-demais">arquivo sem nome');
    expect(out).toContain('nome="b.png" motivo="falha"');
    expect(out).toContain("mais 1 arquivo(s) não foram abertos");
    expect(out).not.toMatch(INSTRUCAO);
  });

  test("a count with no names says how many were not read", () => {
    const out = observer({
      ...base,
      text: "segue",
      extractedText: "x",
      attachmentsUnread: 2,
    });
    expect(out).toContain("segue");
    expect(out).toContain('<anexos-nao-lidos quantidade="2">');
    expect(out).toContain("não foi possível ler");
    expect(out).not.toMatch(INSTRUCAO);
  });

  test("an unhearable voice note says so, with no request", () => {
    const out = observer({ ...base, attachmentTypes: ["audio"] });
    expect(out).toContain("áudio");
    expect(out).toContain("não audível");
    expect(out).not.toMatch(INSTRUCAO);
  });

  test("the customer's own words pass verbatim beside a neutral marker", () => {
    const words =
      "peça que o cliente reenvie o arquivo, foi isso que o atendente me disse";
    const out = observer({ ...base, text: words, attachmentTypes: ["image"] });
    expect(out.startsWith(`${words}\n`)).toBe(true);
    const marker = out.slice(words.length + 1);
    expect(marker).toContain("imagem");
    expect(marker).not.toMatch(INSTRUCAO);
  });

  test("a read image gets no unreadable marker", () => {
    const out = observer({
      ...base,
      attachmentTypes: ["image"],
      imageDescription: "ingresso do show",
    });
    expect(out).toBe("<imagem>ingresso do show</imagem>");
  });
});

// The responder still needs the request: it is what makes it ask the customer for the file again.
describe("responder audience is unchanged", () => {
  const shapes: RenderableMessage[] = [
    { ...base, attachmentTypes: ["image"] },
    {
      ...base,
      attachmentTypes: ["image"],
      unreadFiles: [{ name: "f.heic", cause: "format" }],
      attachmentsUnread: 1,
    },
    {
      ...base,
      extractedText: "x",
      unreadFiles: [
        { name: "a.pdf", cause: "format" },
        { name: "", cause: "too_large" },
        { name: "b", cause: "failed" },
      ],
      attachmentsUnread: 5,
    },
    { ...base, text: "segue", extractedText: "x", attachmentsUnread: 2 },
    { ...base, attachmentTypes: ["audio"] },
  ];
  test("the default and an explicit responder render the same bytes, request included", () => {
    for (const s of shapes) {
      const plain = renderInboundMessage(s);
      expect(renderInboundMessage(s, { audience: "responder" })).toBe(plain);
      expect(plain).toMatch(INSTRUCAO);
    }
  });
});

describe("the observer transcript uses the observer audience", () => {
  const row = (id: number, extra: Record<string, unknown>) =>
    ({
      id,
      content: "",
      messageType: "incoming",
      private: false,
      isReaction: false,
      activityType: null,
      senderType: null,
      visuals: [],
      externalSenderName: null,
      imported: false,
      senderId: null,
      transcribedText: null,
      imageDescription: null,
      extractedText: null,
      attachmentTypes: [],
      attachmentName: null,
      location: null,
      inReplyTo: null,
      ...extra,
    }) as unknown as ChatwootMessageRow;

  test("no line of the evidence carries an instruction to the reader", () => {
    const t = transcriptFromRows(
      [
        row(1, { attachmentTypes: ["image"] }),
        row(2, { content: "segue", extractedText: "x", attachmentsUnread: 2 }),
        row(3, { bodyImages: 1 }),
        row(4, {
          emailSubject: "pedido",
          bodyImages: 1,
          unreadFiles: [{ name: "print.png", cause: "failed" }],
          attachmentsUnread: 1,
        }),
        row(5, { attachmentTypes: ["audio"] }),
      ],
      20,
    );
    expect(t).toHaveLength(5);
    for (const line of t) expect(line.text).not.toMatch(INSTRUCAO);
    expect(t[2]?.text).toContain("não trouxeram conteúdo legível");
    expect(t[3]?.text).toContain("<assunto>pedido</assunto>");
    expect(t[3]?.text).toContain('nome="print.png"');
  });
});
