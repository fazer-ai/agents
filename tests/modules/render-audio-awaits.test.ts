import { describe, expect, test } from "bun:test";
import {
  audioAwaitsWords,
  type RenderableMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";

// O PLACEHOLDER, literal, como o renderizador o escreve. Copiado de propósito em vez de importado:
// esta cerca existe para pegar as duas metades divergindo, e uma constante compartilhada faria as
// duas mudarem juntas sem ninguém perceber.
const PLACEHOLDER =
  "<mensagem de áudio não audível; peça que o cliente reenvie por texto>";

function msg(over: Partial<RenderableMessage> = {}): RenderableMessage {
  return { text: "", attachmentTypes: ["audio"], ...over };
}

// A CERCA DA #688. `audioAwaitsWords` responde uma pergunta sobre o que o RENDERIZADOR produz — "esta
// mensagem sairia como o placeholder de áudio?" — e o portão de posse do caminho direto decide, com
// ela, se manda a mensagem para a ingestão. Se as duas divergirem, a divergência é silenciosa e cara
// nos dois sentidos: dizendo `true` sobre uma mensagem que TEM palavras, elas são descartadas e
// nada as guarda; dizendo `false` sobre um placeholder, o id entra no dedup do thread e a
// transcrição que chega depois é jogada fora como duplicata.
//
// Três rodadas de review escreveram o predicado, uma por campo que o render preserva e a pergunta
// não via. Esta cerca é o que substitui a quarta.
describe("audioAwaitsWords concorda com o que o renderizador produz", () => {
  const esperamAsPalavras: Array<[string, RenderableMessage]> = [
    ["áudio cru, sem nada mais", msg()],
    [
      "áudio com transcrição que é o rodapé do Amara",
      msg({ transcribedText: "Legendas pela comunidade Amara.org" }),
    ],
    ["áudio com anexo ilegível ao lado", msg({ attachmentsUnread: 1 })],
    // MEDIDO PELA CERCA, e é o motivo de ela existir: o ramo de áudio do render é um `if/else if`,
    // então uma extração ou uma descrição de imagem ao lado de um áudio NÃO chega ao corpo. A
    // primeira versão do predicado dizia que elas eram palavras a guardar, e teria mandado para a
    // ingestão uma mensagem cujo corpo renderizado é só o placeholder — gravando o id no dedup e
    // matando a transcrição. Que o render as descarte é um defeito DELE, de outra issue; aqui a
    // regra é concordar com o que ele produz hoje.
    [
      "áudio ao lado de um documento que a extração leu: o render descarta a extração",
      msg({ extractedText: "boleto vencido em 10/09" }),
    ],
    [
      "áudio ao lado de uma imagem descrita: o render descarta a descrição",
      msg({ imageDescription: "print de uma tela de erro" }),
    ],
    [
      "áudio ao lado de um pin de localização: o render descarta o pin",
      msg({ location: { latitude: -23.5, longitude: -46.6, title: null } }),
    ],
  ];
  for (const [nome, m] of esperamAsPalavras) {
    test(`${nome}: espera as palavras, e o corpo É o placeholder`, () => {
      expect(audioAwaitsWords(m)).toBe(true);
      expect(renderInboundMessage(m)).toContain(PLACEHOLDER);
      // E o placeholder é TUDO o que há: nenhuma palavra do cliente sobrou de fora dele.
      expect(renderInboundMessage(m).replace(PLACEHOLDER, "").trim()).toBe("");
    });
  }

  const jaTemPalavras: Array<[string, RenderableMessage]> = [
    [
      "transcrição pronta",
      msg({ transcribedText: "queria trocar o endereço" }),
    ],
    // O ramo de áudio do render usa o `content` como fallback da transcrição.
    ["o content faz as vezes da transcrição", msg({ text: "e o meu pedido?" })],
    // O assunto é posto POR FORA do corpo, e num e-mail de corpo vazio ele é a mensagem.
    [
      "e-mail com assunto e áudio anexado",
      msg({ emailSubject: "recuperar o acesso à minha conta" }),
    ],
  ];
  for (const [nome, m] of jaTemPalavras) {
    test(`${nome}: NÃO espera, e o corpo traz as palavras`, () => {
      expect(audioAwaitsWords(m)).toBe(false);
      const corpo = renderInboundMessage(m);
      expect(corpo.replace(PLACEHOLDER, "").trim()).not.toBe("");
    });
  }

  test("sem áudio nenhum a pergunta não se aplica", () => {
    expect(audioAwaitsWords(msg({ attachmentTypes: [], text: "oi" }))).toBe(
      false,
    );
    expect(
      audioAwaitsWords(msg({ attachmentTypes: ["image"], text: "" })),
    ).toBe(false);
  });
});
