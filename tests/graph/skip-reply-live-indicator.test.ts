import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import { AgentStatusReporter } from "@/graph/status";

// O indicador ao vivo rotula `skip_reply` e some depois, sem trilha para o operador conferir. Um
// único leitor do turno serve as duas superfícies: a linha de log carimba o que o turno tinha
// entregue quando a chamada terminou, o evento ao vivo o que tinha entregue quando ela começou.
// Nenhuma das duas perguntas se responde pelo nome da ferramenta.

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
  // quando ninguém respondeu a pergunta. Ausente é "não sei", e "não sei" mantém o rótulo padrão.
  test("sem leitor, o evento não afirma nada sobre entrega", () => {
    expect("delivered" in iniciar("skip_reply")).toBe(false);
  });

  // Só a ferramenta do silêncio faz uma afirmação sobre o silêncio. As outras não têm rótulo que
  // dependa disso, e carregar o campo nelas seria mandar um fato que ninguém lê.
  test("nenhuma outra ferramenta carrega o campo", () => {
    expect("delivered" in iniciar("handoff_to_human", () => true)).toBe(false);
  });
});
