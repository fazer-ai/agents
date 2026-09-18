import { describe, expect, test } from "bun:test";
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
