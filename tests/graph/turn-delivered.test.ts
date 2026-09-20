import { describe, expect, test } from "bun:test";
import {
  type HandoffTurnState,
  type TurnState,
  turnDeliveredToCustomer,
  turnReachedTheCustomer,
} from "@/graph/tools/native";
import { withoutComments } from "../utils/source-text";

// ── O DISCRIMINANTE DA RODADA (issue #726) ──
//
// A issue lista quatro formas e trata as quatro como o mesmo caso. Elas não são: o critério é o do
// operador, e é de superfície — ESTE TURNO botou alguma coisa na frente do cliente? A transferência
// com `customerMessage` e a imagem entregue respondem que sim; a reação e a transferência que
// declarou não ter o que dizer respondem que não, e nelas a frase de hoje é a única verdadeira que a
// tela tem.
//
// Uma correção que leia o NOME da ferramenta ("transferiu, logo respondeu") acerta o caso reportado
// e troca uma mentira por outra exatamente na transferência muda. É por isso que este arquivo existe
// separado do rótulo: o rótulo é consequência, e isto é a pergunta.

function turno(over: Partial<TurnState> = {}): TurnState {
  return {
    resolveRequested: false,
    pendingAttachments: [],
    imagesInFlight: 0,
    documentsInFlight: 0,
    attachmentsSeq: 0,
    ...over,
  };
}

function anexo(): TurnState["pendingAttachments"][number] {
  return {
    bytes: new ArrayBuffer(1),
    mime: "image/jpeg",
    fileName: "cardapio.jpg",
    order: 0,
    tool: "send_image",
    kind: "image",
  };
}

const transferiu = (
  over: Partial<HandoffTurnState> = {},
): HandoffTurnState => ({
  customerMessage: null,
  completed: false,
  ...over,
});

describe("o turno botou alguma coisa na frente do cliente?", () => {
  test("transferência com mensagem ao cliente: sim", () => {
    expect(
      turnDeliveredToCustomer(
        turno(),
        transferiu({
          customerMessage: "Já chamo uma pessoa.",
          completed: true,
        }),
      ),
    ).toBe(true);
  });

  // O discriminante: a transferência que declarou não ter o que dizer (#662). O nome da ferramenta é
  // o mesmo do caso de cima, e a resposta é a oposta.
  test("transferência que declarou silêncio: não", () => {
    expect(
      turnDeliveredToCustomer(
        turno(),
        transferiu({
          customerMessage: "",
          completed: true,
          declinedToSpeak: true,
        }),
      ),
    ).toBe(false);
  });

  // Uma transferência que morreu no meio deixa a linha composta sem ninguém para entregá-la, e o
  // turno segue com o texto do próprio modelo. Não houve entrega desta.
  test("transferência que não concluiu: não", () => {
    expect(
      turnDeliveredToCustomer(
        turno(),
        transferiu({ customerMessage: "Já chamo uma pessoa." }),
      ),
    ).toBe(false);
  });

  test("imagem na fila de entrega: sim", () => {
    expect(
      turnDeliveredToCustomer(
        turno({ pendingAttachments: [anexo()] }),
        undefined,
      ),
    ).toBe(true);
  });

  // A reserva é tomada ANTES do download, e é justamente a janela em que a fila ainda está vazia e o
  // turno já decidiu mandar. Ler só a fila responderia "nada" no meio do lote.
  test("imagem reservada mas ainda baixando: sim", () => {
    expect(
      turnDeliveredToCustomer(turno({ imagesInFlight: 1 }), undefined),
    ).toBe(true);
  });

  test("documento reservado: sim", () => {
    expect(
      turnDeliveredToCustomer(turno({ documentsInFlight: 1 }), undefined),
    ).toBe(true);
  });

  // Reagir não é escrever. O turno de fato não botou mensagem nenhuma na thread, e a issue lista
  // esta forma como afetada: este conjunto discorda, porque aqui a frase não é falsa.
  test("reação e nada mais: não", () => {
    expect(turnDeliveredToCustomer(turno(), transferiu())).toBe(false);
  });

  // O ACHADO DA RODADA 1 DE REVIEW. O silêncio declarado não é só "a linha de fechamento está
  // vazia": o runtime dropa a fila de anexos junto (`handoffDeclaredSilence`, runtime.ts), porque
  // "este caso não recebe resposta nenhuma" não pode significar "nenhum texto, mais o documento que
  // você enfileirou dois passos atrás". Então um turno que enfileirou uma imagem E declarou silêncio
  // não entrega nada, e ler só a fila responderia que entregou.
  test("silêncio declarado leva a fila junto: não", () => {
    expect(
      turnDeliveredToCustomer(
        turno({ pendingAttachments: [anexo()] }),
        transferiu({
          customerMessage: "",
          completed: true,
          declinedToSpeak: true,
        }),
      ),
    ).toBe(false);
  });

  test("silêncio declarado com reserva em voo: não", () => {
    expect(
      turnDeliveredToCustomer(
        turno({ imagesInFlight: 1 }),
        transferiu({
          customerMessage: "",
          completed: true,
          declinedToSpeak: true,
        }),
      ),
    ).toBe(false);
  });

  // O ACHADO DA RODADA 3 DE REVIEW, e a terceira porta. O aviso de ferramenta lenta (`emitAck`, em
  // prepare.ts) manda uma mensagem ao cliente DIRETO pelo cliente do Chatwoot: não conta balão, não
  // enfileira anexo, e não passava por lugar nenhum que esta pergunta lesse. Um turno que avisou
  // "só um instante" e depois chamou `skip_reply` respondia que ninguém foi atendido.
  test("aviso de ferramenta lenta já entregue: sim", () => {
    expect(
      turnDeliveredToCustomer(turno({ spokeOutsideTheReply: true }), undefined),
    ).toBe(true);
  });

  // E ele responde ANTES do silêncio declarado, porque a ordem aqui é a da irreversibilidade: o
  // silêncio declarado dropa a fila e o texto, que ainda não saíram, e não tem como des-enviar uma
  // mensagem que já está no telefone do cliente.
  test("aviso já entregue e silêncio declarado depois: sim", () => {
    expect(
      turnDeliveredToCustomer(
        turno({ spokeOutsideTheReply: true, pendingAttachments: [anexo()] }),
        transferiu({
          customerMessage: "",
          completed: true,
          declinedToSpeak: true,
        }),
      ),
    ).toBe(true);
  });

  test("turno sem estado nenhum: não", () => {
    expect(turnDeliveredToCustomer(undefined, undefined)).toBe(false);
  });
});

// O PAR DA PERGUNTA ACIMA, feito quando o turno acaba: o que de fato chegou ao cliente. São três
// fontes porque as três formas de alcançar um cliente são contadas em unidades diferentes — texto em
// balões, arquivo pelo laço de entrega, e o aviso de ferramenta lenta em nenhuma das duas, porque ele
// sai direto pelo cliente do Chatwoot.
describe("o que chegou ao cliente, quando o turno acabou", () => {
  const nada = { balloons: null, attachment: false };

  test("nenhuma das três: não", () => {
    expect(turnReachedTheCustomer(nada)).toBe(false);
    expect(
      turnReachedTheCustomer({ ...nada, spokeOutsideTheReply: false }),
    ).toBe(false);
  });

  test("balão de texto: sim", () => {
    expect(turnReachedTheCustomer({ ...nada, balloons: 1 })).toBe(true);
  });

  // Zero balões é uma entrega que ACONTECEU e não rendeu balão nenhum? Não: o contador só deixa de
  // ser nulo quando alguma coisa saiu, então zero é um caso que o runtime não produz. O que importa
  // aqui é que a pergunta seja sobre a AUSÊNCIA do contador, e não sobre ele ser positivo.
  test("o contador de balões é lido pela ausência, não pelo sinal", () => {
    expect(turnReachedTheCustomer({ ...nada, balloons: 0 })).toBe(true);
  });

  test("anexo entregue: sim", () => {
    expect(turnReachedTheCustomer({ ...nada, attachment: true })).toBe(true);
  });

  test("aviso de ferramenta lenta: sim", () => {
    expect(
      turnReachedTheCustomer({ ...nada, spokeOutsideTheReply: true }),
    ).toBe(true);
  });
});

// A CERCA NASCE NA ROTA QUE REVELOU O DEFEITO: a issue avisa, em tantas palavras, que uma correção
// que viva só na trilha deixa o balão ao vivo dizendo que o agente decidiu não responder um segundo
// depois de a linha da transferência ter saído. As duas superfícies têm que sair do MESMO leitor, e
// o jeito de isso se perder é alguém passar o leitor para um dos dois construtores.
describe("as duas superfícies saem do mesmo leitor", () => {
  test("o runtime passa o leitor para o log e para o indicador", async () => {
    const src = withoutComments(await Bun.file("src/graph/runtime.ts").text());
    const status = src.slice(src.indexOf("new AgentStatusReporter("));
    const logger = src.slice(src.indexOf("new ToolFlowLogger("));
    expect(status.slice(0, status.indexOf("})"))).toInclude("turnDelivered");
    expect(logger.slice(0, logger.indexOf("})"))).toInclude("turnDelivered");
    expect(src).toInclude("turnDeliveredToCustomer(turnState, handoffState)");
  });

  // E o fato do turno sai da MESMA função que este arquivo mede, em vez de a expressão ser repetida
  // onde nada a alcança.
  test("o fato do turno sai da função medida aqui, com as três fontes", async () => {
    const src = withoutComments(await Bun.file("src/graph/runtime.ts").text());
    const i = src.indexOf("turnDelivered: turnReachedTheCustomer({");
    expect(i).toBeGreaterThanOrEqual(0);
    // As três fontes têm que CHEGAR nela: a função responde certo sobre o que recebe, e um argumento
    // que o runtime não passa é uma entrega que ela nunca vê.
    const chamada = src.slice(i, src.indexOf("})", i));
    expect(chamada).toInclude("balloons: deliveredBalloons");
    expect(chamada).toInclude("attachment: sentAttachment");
    expect(chamada).toInclude(
      "spokeOutsideTheReply: turnState.spokeOutsideTheReply",
    );
  });
});
