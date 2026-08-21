import { describe, expect, test } from "bun:test";
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

  test("image without a description renders the send-text marker", () => {
    expect(
      renderInboundMessage({ text: "", attachmentTypes: ["image"] }),
    ).toContain("enviou uma imagem");
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

// NOTE: Issue #45 — a WhatsApp location pin must reach the model as coordinates, not as an
// unusable "unsupported file" marker. The marker style mirrors the reaction marker (pt-BR
// pseudo-tag with attributes).
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

// Round-2 review finding (P2). The other direction (issue #187): what the memory keeps of a message a
// HUMAN AGENT sent. The wording is deliberately not shared with renderInboundMessage — every marker
// there is written from the customer's side.
describe("renderAttendantMessage", () => {
  test("plain text goes in verbatim", () => {
    expect(
      renderAttendantMessage({
        text: "  fecho por R$ 1.200  ",
        attachmentTypes: [],
      }),
    ).toBe("fecho por R$ 1.200");
  });

  // The defect: an attendant who answers with a PDF and no caption produced an empty string, and the
  // caller dropped the message — the memory then records that the team said nothing, which is the
  // same failure the whole change is about.
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

  // Nothing said and nothing attached: the caller skips it, as it does for the customer.
  test("an empty message renders nothing", () => {
    expect(renderAttendantMessage({ text: "   ", attachmentTypes: [] })).toBe(
      "",
    );
  });
});
