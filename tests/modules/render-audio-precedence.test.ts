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

// O áudio não decide o corpo sozinho. A transcrição (ou o aviso de áudio inaudível) vem primeiro, e
// ao lado dela cada bloco que a visão produziu e o pin de localização, como numa mensagem sem áudio:
// o cliente que manda "olha o print" junto com o print precisa que o agente veja o print.
describe("o áudio leva ao lado o que a visão leu", () => {
  const AUDIO =
    "<mensagem-de-audio>o ingresso não chegou, olha o print</mensagem-de-audio>";
  const comTranscricao = (over: Partial<RenderableMessage>) =>
    msg({ transcribedText: "o ingresso não chegou, olha o print", ...over });

  test("a descrição de uma imagem ao lado chega ao corpo", () => {
    expect(
      renderInboundMessage(
        comTranscricao({
          attachmentTypes: ["audio", "image"],
          imageDescription: "print de um e-mail de compra sem o ingresso",
        }),
      ),
    ).toBe(
      `${AUDIO}\n<imagem>print de um e-mail de compra sem o ingresso</imagem>`,
    );
  });

  test("a extração de um documento ao lado chega ao corpo", () => {
    expect(
      renderInboundMessage(
        comTranscricao({
          attachmentTypes: ["audio", "file"],
          extractedText: "boleto vencido em 10/09",
        }),
      ),
    ).toBe(`${AUDIO}\n<documento>boleto vencido em 10/09</documento>`);
  });

  test("um pin de localização ao lado chega ao corpo", () => {
    expect(
      renderInboundMessage(
        comTranscricao({
          location: { latitude: -23.5, longitude: -46.6, title: null },
        }),
      ),
    ).toBe(`${AUDIO}\n<localização latitude="-23.5" longitude="-46.6">`);
  });

  test("um áudio inaudível não esconde a imagem que veio com ele", () => {
    const corpo = renderInboundMessage(
      msg({
        attachmentTypes: ["audio", "image"],
        imageDescription: "print de uma tela de erro",
      }),
    );
    expect(corpo).toBe(
      `${PLACEHOLDER}\n<imagem>print de uma tela de erro</imagem>`,
    );
  });

  test("só o áudio continua só o áudio", () => {
    expect(renderInboundMessage(comTranscricao({}))).toBe(AUDIO);
  });

  test("o content faz as vezes da transcrição e não se repete ao lado da imagem", () => {
    const corpo = renderInboundMessage(
      msg({
        text: "e o meu pedido?",
        attachmentTypes: ["audio", "image"],
        imageDescription: "foto da caixa",
      }),
    );
    expect(corpo).toBe(
      "<mensagem-de-audio>e o meu pedido?</mensagem-de-audio>\n<imagem>foto da caixa</imagem>",
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

// E a pergunta do portão é pelo TIPO do arquivo, nunca por "o STT consegue rodar nisto". Um anexo
// cujo `data_url` ou id ainda não chegou não é transcritível AGORA e mesmo assim alcança o grafo
// como placeholder, e a transcrição dele vem depois, sobre o mesmo id de mensagem. Perguntando pela
// elegibilidade do STT, a mensagem lê como "sem áudio", o portão atua, a ingestão grava o id no
// dedup e a transcrição é descartada como duplicata. É a mesma armadilha que `turnHadTheWords`
// documenta do lado dele.
describe("awaitsTranscription pergunta pelo TIPO do anexo", () => {
  function evento(attachment: Record<string, unknown>) {
    return eventos(attachment);
  }
  function eventos(...attachments: Record<string, unknown>[]) {
    return normalizeChatwootEvent({
      event: "message_created",
      id: 4242,
      private: false,
      content: "",
      message_type: "incoming",
      sender: { id: 88, name: "Cliente", type: null },
      attachments,
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

  test("uma imagem não espera transcrição nenhuma", () => {
    const n = evento({
      id: 1,
      file_type: "image",
      data_url: "https://chat.late.example/a.png",
    });
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(false);
  });

  // NOTE: com dois áudios, quem responde é o primeiro. `firstAudioAttachment` e
  // `runEagerMedia` selecionam esse mesmo, então é a transcrição DELE que ainda vem; uma transcrição
  // pendurada em outro anexo não diz nada sobre ela. Lido como "algum está transcrito", o portão
  // atuaria sobre a mensagem cuja transcrição está a caminho, que é exatamente a perda que esta
  // exceção existe para fechar.
  test("com dois áudios, o primeiro sem transcrição é quem decide", () => {
    const n = eventos(
      {
        id: 1,
        file_type: "audio",
        data_url: "https://chat.late.example/a.ogg",
      },
      {
        id: 2,
        file_type: "audio",
        data_url: "https://chat.late.example/b.ogg",
        transcribed_text: "esse aqui já voltou",
      },
    );
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(true);
  });

  // ...e o outro lado da mesma regra: transcrito o primeiro, não há o que esperar, mesmo com um
  // segundo áudio ainda cru. O eager pass cobre um áudio por mensagem, e é o primeiro.
  test("com dois áudios, o primeiro já transcrito encerra a espera", () => {
    const n = eventos(
      {
        id: 1,
        file_type: "audio",
        data_url: "https://chat.late.example/a.ogg",
        transcribed_text: "queria trocar o endereço",
      },
      {
        id: 2,
        file_type: "audio",
        data_url: "https://chat.late.example/b.ogg",
      },
    );
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(false);
  });

  // E "o primeiro" é o primeiro ÁUDIO, não o primeiro anexo: uma imagem na frente não pode empurrar
  // a resposta para "ainda vem transcrição" numa mensagem cujo áudio já voltou.
  test("uma imagem antes do áudio não entra na conta", () => {
    const n = eventos(
      {
        id: 1,
        file_type: "image",
        data_url: "https://chat.late.example/a.png",
      },
      {
        id: 2,
        file_type: "audio",
        data_url: "https://chat.late.example/b.ogg",
        transcribed_text: "queria trocar o endereço",
      },
    );
    if (!n) throw new Error("payload did not normalize");
    expect(awaitsTranscription(n)).toBe(false);
  });
});
