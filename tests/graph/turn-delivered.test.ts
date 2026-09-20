import { describe, expect, test } from "bun:test";
import {
  type HandoffTurnState,
  type TurnState,
  turnDeliveredToCustomer,
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

  test("turno sem estado nenhum: não", () => {
    expect(turnDeliveredToCustomer(undefined, undefined)).toBe(false);
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
});
