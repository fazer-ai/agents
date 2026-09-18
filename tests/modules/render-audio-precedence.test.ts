import { describe, expect, test } from "bun:test";
import {
  awaitsTranscription,
  normalizeChatwootEvent,
} from "@/modules/chatwoot/normalize";
import {
  type RenderableMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";

const PLACEHOLDER =
  "<mensagem de áudio não audível; peça que o cliente reenvie por texto>";

function msg(over: Partial<RenderableMessage> = {}): RenderableMessage {
  return { text: "", attachmentTypes: ["audio"], ...over };
}

// O QUE O ÁUDIO ENGOLE, medido (issue #688). O ramo de áudio do renderizador é um `if/else if`, então
// um áudio na mensagem decide o corpo sozinho: uma extração de documento, uma descrição de imagem ou
// um pin de localização ao lado dele NÃO chegam ao texto que o agente lê.
//
// Este arquivo existe porque a #688 apostou o contrário. Uma versão do portão de posse perguntava
// "esta mensagem já tem palavras a guardar?" e contava a extração e a descrição como palavras — o
// que teria mandado para a ingestão uma mensagem cujo corpo renderizado é só o placeholder. A
// medição corrigiu a pergunta e virou este teste: o fato não tinha nenhum, e ele decide o que um
// leitor do render pode assumir.
//
// Que o áudio engula essas três é um DEFEITO do renderizador, não uma regra que se queira. Ele está
// preso aqui como está, para que mudá-lo seja uma decisão com um teste vermelho na frente, e não uma
// descoberta na próxima rodada que apostar nele.
describe("o ramo de áudio do renderizador tem precedência sobre o resto", () => {
  const engolidos: Array<[string, RenderableMessage]> = [
    [
      "a extração de um documento ao lado",
      msg({ extractedText: "boleto vencido em 10/09" }),
    ],
    [
      "a descrição de uma imagem ao lado",
      msg({ imageDescription: "print de uma tela de erro" }),
    ],
    [
      "um pin de localização ao lado",
      msg({ location: { latitude: -23.5, longitude: -46.6, title: null } }),
    ],
  ];
  for (const [nome, m] of engolidos) {
    test(`${nome} não chega ao corpo`, () => {
      const corpo = renderInboundMessage(m);
      expect(corpo).toContain(PLACEHOLDER);
      expect(corpo.replace(PLACEHOLDER, "").trim()).toBe("");
    });
  }

  // E o que SOBREVIVE ao lado do áudio, que é o outro lado do mesmo fato.
  test("o content faz as vezes da transcrição", () => {
    expect(renderInboundMessage(msg({ text: "e o meu pedido?" }))).toContain(
      "e o meu pedido?",
    );
  });

  test("o assunto do e-mail é posto por fora do corpo e sobrevive", () => {
    const corpo = renderInboundMessage(
      msg({ emailSubject: "recuperar o acesso à minha conta" }),
    );
    expect(corpo).toContain("recuperar o acesso à minha conta");
    expect(corpo).toContain(PLACEHOLDER);
  });
});

// E A PERGUNTA DO PORTÃO É PELO TIPO DO ARQUIVO (issue #688, review r9), nunca por "o STT consegue
// rodar nisto". Um anexo cujo `data_url` ou id ainda não chegou não é transcritível AGORA e mesmo
// assim alcança o grafo como placeholder — e a transcrição dele vem depois, sobre o mesmo id de
// mensagem. Perguntando pela elegibilidade do STT, essa mensagem lê como "sem áudio nenhum", o
// portão atua, a ingestão grava o id no dedup, e a transcrição é descartada como duplicata: a perda
// que esta exceção existe para fechar, entrando pela porta dela.
//
// É a mesma armadilha que `turnHadTheWords` documenta do lado dele, e já custou uma rodada de review
// lá (#576, round 9). Esta é a segunda vez.
describe("awaitsTranscription pergunta pelo TIPO do anexo", () => {
  function evento(attachment: Record<string, unknown>) {
    return normalizeChatwootEvent({
      event: "message_created",
      id: 4242,
      private: false,
      content: "",
      message_type: "incoming",
      sender: { id: 88, name: "Cliente", type: null },
      attachments: [attachment],
      conversation: {
        id: 77,
        inbox_id: 9,
        status: "pending",
        contact_inbox: { id: 7001 },
        meta: {},
        channel: "Channel::Api",
      },
    });
  }

  test("um áudio sem data_url ainda espera a transcrição", () => {
    const n = evento({ id: 1, file_type: "audio" });
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(true);
  });

  test("um áudio com data_url e sem transcrição também espera", () => {
    const n = evento({
      id: 1,
      file_type: "audio",
      data_url: "https://chat.late.example/a.ogg",
    });
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(true);
  });

  test("um áudio já transcrito não espera mais nada", () => {
    const n = evento({
      id: 1,
      file_type: "audio",
      data_url: "https://chat.late.example/a.ogg",
      transcribed_text: "queria trocar o endereço",
    });
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(false);
  });

  test("uma imagem não espera transcrição nenhuma", () => {
    const n = evento({
      id: 1,
      file_type: "image",
      data_url: "https://chat.late.example/a.png",
    });
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(false);
  });
});
