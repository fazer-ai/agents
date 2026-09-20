import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import { AgentStatusReporter } from "@/graph/status";

// ── O INDICADOR AO VIVO NÃO TEM TRILHA PARA CONSULTAR (issue #726) ──
//
// O balão transitório mostra a ferramenta que está rodando agora, e ele também rotula `skip_reply`
// pelo nome. É a superfície pior das duas: o operador está olhando para ela exatamente quando uma
// transferência acabou de cair na fila dele, e não tem como conferir depois, porque ela some.
//
// O mesmo fato do turno serve as duas superfícies, e é por isso que ele é UM leitor e não dois
// mecanismos: a linha de log carimba o que o turno tinha entregue quando a chamada terminou, e o
// evento ao vivo carrega o que o turno tinha entregue quando ela começou. As duas perguntas são a
// mesma, feitas em instantes diferentes, e nenhuma das duas é respondível pelo nome da ferramenta.

const TOOL = {} as Serialized;

function newRecorder() {
  const calls: { topic: string; data: string }[] = [];
  const fn = mock((topic: string, data: string) => {
    calls.push({ topic, data });
  });
  return { fn, calls };
}

describe("o indicador ao vivo e o turno que falou", () => {
  let recorder: ReturnType<typeof newRecorder>;

  beforeEach(() => {
    recorder = newRecorder();
    setPublisher(recorder.fn);
  });

  afterEach(() => {
    setPublisher(() => undefined);
  });

  function eventos() {
    return recorder.calls.map((c) => JSON.parse(c.data));
  }

  function iniciar(tool: string, turnDelivered?: () => boolean) {
    const r = new AgentStatusReporter({
      tenantId: 1n,
      conversationDbId: 9n,
      ...(turnDelivered ? { turnDelivered } : {}),
    });
    r.handleToolStart(
      TOOL,
      "input",
      "run-1",
      undefined,
      undefined,
      undefined,
      tool,
    );
    return eventos()[0];
  }

  // O INSTRUMENTO: o evento de passo continua saindo, com o nome da ferramenta.
  test("o instrumento: o passo de ferramenta continua carregando o nome", () => {
    expect(iniciar("skip_reply")).toMatchObject({
      phase: "step",
      stage: "tool",
      tool: "skip_reply",
    });
  });

  test("turno que já entregou: o evento diz que entregou", () => {
    expect(iniciar("skip_reply", () => true).delivered).toBe(true);
  });

  test("turno mudo: o evento diz que não entregou", () => {
    expect(iniciar("skip_reply", () => false).delivered).toBe(false);
  });

  // O evento é lido por um cliente que não sabe nada do turno, então o campo tem que estar ausente
  // quando ninguém respondeu a pergunta. Ausente é "não sei", e "não sei" mantém o rótulo de hoje.
  test("sem leitor, o evento não afirma nada sobre entrega", () => {
    expect("delivered" in iniciar("skip_reply")).toBe(false);
  });

  // Só a ferramenta do silêncio faz uma afirmação sobre o silêncio. As outras não têm rótulo que
  // dependa disso, e carregar o campo nelas seria mandar um fato que ninguém lê.
  test("nenhuma outra ferramenta carrega o campo", () => {
    expect("delivered" in iniciar("handoff_to_human", () => true)).toBe(false);
  });
});
