import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanTranscription,
  renderAttendantMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";

describe("cleanTranscription", () => {
  test("drops Whisper's Amara.org silence hallucination", () => {
    expect(cleanTranscription("Legendas pela comunidade Amara.org")).toBe("");
    expect(cleanTranscription("  olá tudo bem  ")).toBe("olá tudo bem");
  });
});

describe("renderInboundMessage", () => {
  test("plain text passes through", () => {
    expect(
      renderInboundMessage({ text: "quero agendar", attachmentTypes: [] }),
    ).toBe("quero agendar");
  });

  test("audio renders the transcription wrapped in a modality marker", () => {
    expect(
      renderInboundMessage({
        text: "",
        transcribedText: "quero remarcar minha consulta",
        attachmentTypes: ["audio"],
      }),
    ).toBe(
      "<mensagem-de-audio>quero remarcar minha consulta</mensagem-de-audio>",
    );
  });

  test("audio without a transcription renders the inaudible marker", () => {
    const out = renderInboundMessage({
      text: "",
      transcribedText: "",
      attachmentTypes: ["audio"],
    });
    expect(out).toContain("não audível");
  });

  // NOTE: o marcador não escolhe o canal de volta. O modelo o lê como parte da mensagem, então o
  // que ele pedir é o que o cliente recebe, e uma instrução dentro do conteúdo vence o prompt: numa
  // caixa de e-mail, pedir "texto ou áudio" oferece um canal que não existe.
  test("the unread-image marker does not offer a channel that may not exist", () => {
    const out = renderInboundMessage({ text: "", attachmentTypes: ["image"] });
    expect(out).not.toContain("áudio");
    // NOTE: continua dizendo que veio uma imagem e que ela não pôde ser lida: um marcador mudo faria
    // o modelo responder como se a mensagem não tivesse anexo.
    expect(out).toContain("imagem");
    expect(out.toLowerCase()).toContain("não foi possível ler");
  });

  // NOTE: `unwrapFileMarker` (src/modules/playground/sessions.ts) reconhece este marcador por
  // `startsWith` para remontar o anexo na tela; reescrever a frase quebraria aquele lado em silêncio.
  // A asserção lê o prefixo do fonte de lá, porque a função não é exportada e uma cópia do literal
  // aqui só provaria que o render concorda consigo mesmo.
  test("the marker keeps the prefix the playground matches on", () => {
    const sessions = readFileSync(
      join(import.meta.dir, "../../src/modules/playground/sessions.ts"),
      "utf8",
    );
    const prefixos = [
      ...sessions.matchAll(/raw\.startsWith\("(<usuário [^"]+)"\)/g),
    ].map((m) => m[1] as string);
    // NOTE: se o outro lado deixar de casar por prefixo, a cerca falha alto em vez de passar com
    // uma lista vazia.
    expect(prefixos.length).toBeGreaterThanOrEqual(2);
    for (const tipo of ["image", "file"] as const) {
      const out = renderInboundMessage({ text: "", attachmentTypes: [tipo] });
      expect(prefixos.some((pref) => out.startsWith(pref))).toBe(true);
    }
  });

  test("an extracted image renders the description in an <imagem> marker", () => {
    expect(
      renderInboundMessage({
        text: "",
        imageDescription: "uma nota fiscal no valor de R$ 120",
        attachmentTypes: ["image"],
      }),
    ).toBe("<imagem>uma nota fiscal no valor de R$ 120</imagem>");
  });

  // NOTE: cada anexo tem seu bloco; se um excluísse o outro, o documento sumiria até para o modelo.
  test("a message carrying both an image and a document renders both", () => {
    const out = renderInboundMessage({
      text: "",
      imageDescription: "print do pedido 40000001",
      extractedText: "CNH do titular",
      attachmentTypes: ["image", "file"],
    });
    expect(out).toContain("<imagem>print do pedido 40000001</imagem>");
    expect(out).toContain("<documento>CNH do titular</documento>");
  });

  // NOTE: o texto do cliente aparece uma vez, não uma por bloco.
  test("the customer's own words are not repeated once per block", () => {
    const out = renderInboundMessage({
      text: "segue em anexo",
      imageDescription: "print",
      extractedText: "pdf",
      attachmentTypes: ["image", "file"],
    });
    expect(out.split("segue em anexo").length - 1).toBe(1);
  });

  test("an extracted document renders the content in a <documento> marker", () => {
    expect(
      renderInboundMessage({
        text: "",
        extractedText: "Contrato de prestação de serviços…",
        attachmentTypes: ["file"],
      }),
    ).toBe("<documento>Contrato de prestação de serviços…</documento>");
  });

  test("an unsupported file renders a could-not-extract marker with name + type", () => {
    expect(
      renderInboundMessage({
        text: "",
        attachmentTypes: ["file"],
        attachmentName: "planilha.xlsx",
      }),
    ).toBe(
      "<usuário enviou um arquivo do tipo 'file' chamado 'planilha.xlsx'; não foi possível extrair o conteúdo>",
    );
  });

  test("empty with no attachments renders nothing (skip)", () => {
    expect(renderInboundMessage({ text: "   ", attachmentTypes: [] })).toBe("");
  });

  test("a quoted message is prefixed when resolvable", () => {
    const out = renderInboundMessage(
      { text: "sim, pode ser", attachmentTypes: [], inReplyTo: 42 },
      { resolveQuoted: (id) => (id === 42 ? "Podemos marcar quinta?" : null) },
    );
    expect(out).toBe(
      '<em resposta a: "Podemos marcar quinta?">\nsim, pode ser',
    );
  });

  test("an unresolvable quote is silently ignored", () => {
    const out = renderInboundMessage(
      { text: "ok", attachmentTypes: [], inReplyTo: 99 },
      { resolveQuoted: () => null },
    );
    expect(out).toBe("ok");
  });

  test("a reaction renders as a context marker with the reacted-to snippet", () => {
    const out = renderInboundMessage(
      { text: "❤️", attachmentTypes: [], isReaction: true, inReplyTo: 7 },
      { resolveQuoted: (id) => (id === 7 ? "Segue o orçamento" : null) },
    );
    expect(out).toBe('<reação do cliente emoji="❤️" para: "Segue o orçamento">');
  });

  test("a reaction with no resolvable target still renders the emoji marker", () => {
    const out = renderInboundMessage({
      text: "👍",
      attachmentTypes: [],
      isReaction: true,
    });
    expect(out).toBe('<reação do cliente emoji="👍">');
  });
});

// A WhatsApp location pin reaches the model as coordinates, not as an unusable "unsupported file"
// marker. The marker style mirrors the reaction marker (pt-BR pseudo-tag with attributes).
describe("location markers (issue #45)", () => {
  test("coordinates + title render as a <localização> marker", () => {
    const out = renderInboundMessage({
      text: "",
      attachmentTypes: ["location"],
      location: {
        latitude: -23.5505,
        longitude: -46.6333,
        title: "Padaria do Zé, Rua X, 123",
      },
    });
    expect(out).toBe(
      '<localização latitude="-23.5505" longitude="-46.6333" titulo="Padaria do Zé, Rua X, 123">',
    );
  });

  test("coordinates without a title omit the titulo attribute", () => {
    const out = renderInboundMessage({
      text: "",
      attachmentTypes: ["location"],
      location: { latitude: 48.7484, longitude: 30.2216, title: null },
    });
    expect(out).toBe('<localização latitude="48.7484" longitude="30.2216">');
  });

  test("a title-only pin (provider sent no coordinates) still renders", () => {
    const out = renderInboundMessage({
      text: "",
      attachmentTypes: ["location"],
      location: { latitude: null, longitude: null, title: "Praça da Sé" },
    });
    expect(out).toBe('<localização titulo="Praça da Sé">');
  });

  test("text alongside the pin keeps the text and appends the marker", () => {
    const out = renderInboundMessage({
      text: "estou aqui",
      attachmentTypes: ["location"],
      location: { latitude: -1.5, longitude: -48.2, title: null },
    });
    expect(out).toBe(
      'estou aqui\n<localização latitude="-1.5" longitude="-48.2">',
    );
  });

  test("double quotes in the title become single quotes (the attribute stays intact)", () => {
    const out = renderInboundMessage({
      text: "",
      attachmentTypes: ["location"],
      location: {
        latitude: -23.5,
        longitude: -46.6,
        title: 'Bar do "Zé"',
      },
    });
    expect(out).toBe(
      '<localização latitude="-23.5" longitude="-46.6" titulo="Bar do \'Zé\'">',
    );
  });

  test("a location without usable content falls back to the generic file marker", () => {
    const out = renderInboundMessage({
      text: "",
      attachmentTypes: ["location"],
      location: null,
    });
    expect(out).toContain("arquivo do tipo 'location'");
  });
});

// The other direction: what the memory keeps of a message a human agent sent. The wording is not
// shared with renderInboundMessage, whose markers are all written from the customer's side.
describe("renderAttendantMessage", () => {
  test("plain text goes in verbatim", () => {
    expect(
      renderAttendantMessage({
        text: "  fecho por R$ 1.200  ",
        attachmentTypes: [],
      }),
    ).toBe("fecho por R$ 1.200");
  });

  // NOTE: an empty string here makes the caller drop the message, and the memory would record that
  // the team said nothing.
  test("an attachment with no caption is still a message", () => {
    expect(
      renderAttendantMessage({ text: "", attachmentTypes: ["file"] }),
    ).toBe("<atendente enviou um arquivo do tipo 'file'>");
  });

  test("a caption keeps the fact that a file went with it", () => {
    expect(
      renderAttendantMessage({
        text: "segue o orçamento",
        attachmentTypes: ["file"],
      }),
    ).toBe("segue o orçamento\n<atendente enviou um arquivo do tipo 'file'>");
  });

  // NOTE: an outgoing voice note carries an empty `content` (the WhatsApp connector refuses a
  // caption on audio), so without the transcription the marker would be the whole record and the
  // observer tick, which renders outgoing messages through here, would read it as unanswered.
  test("an audio reply speaks its words, and still names the attachment", () => {
    expect(
      renderAttendantMessage({
        text: "",
        attachmentTypes: ["audio"],
        transcribedText: "Confirmei sua consulta para quinta às 14h.",
      }),
    ).toBe(
      "Confirmei sua consulta para quinta às 14h.\n<atendente enviou um arquivo do tipo 'audio'>",
    );
  });

  // NOTE: the transcription is a fallback for an empty content, never a replacement for what was
  // written.
  test("a typed caption wins over a transcription", () => {
    expect(
      renderAttendantMessage({
        text: "segue o áudio",
        attachmentTypes: ["audio"],
        transcribedText: "Confirmei sua consulta.",
      }),
    ).toBe("segue o áudio\n<atendente enviou um arquivo do tipo 'audio'>");
  });

  // NOTE: the customer side's Whisper cleanup applies here too, or the agent reads "Amara.org" as
  // its own reply.
  test("a hallucinated transcription is dropped, leaving the marker alone", () => {
    expect(
      renderAttendantMessage({
        text: "",
        attachmentTypes: ["audio"],
        transcribedText: "Subtitles by the Amara.org community",
      }),
    ).toBe("<atendente enviou um arquivo do tipo 'audio'>");
  });

  // NOTE: a transcription on a non-audio attachment is not a caption: it belongs to the voice note.
  test("a transcription on a file attachment is ignored", () => {
    expect(
      renderAttendantMessage({
        text: "",
        attachmentTypes: ["file"],
        transcribedText: "não é legenda",
      }),
    ).toBe("<atendente enviou um arquivo do tipo 'file'>");
  });

  // NOTE: nothing said and nothing attached: the caller skips it, as it does for the customer.
  test("an empty message renders nothing", () => {
    expect(renderAttendantMessage({ text: "   ", attachmentTypes: [] })).toBe(
      "",
    );
  });
});
