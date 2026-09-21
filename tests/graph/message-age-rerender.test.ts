import { describe, expect, test } from "bun:test";
import { withMessageAge } from "@/graph/prepare";
import { interpolatePromptVars } from "@/graph/prompt";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { makeConfig } from "../utils/agent-config";

// ISSUE #749, a metade que NÃO passa pelo banco: a recomposição do prompt quando o instante da
// mensagem só é conhecido depois que a config já foi carregada (o flush do debounce e o religamento
// manual, que carregam a config e só então buscam a conversa no Chatwoot).
//
// O que está sob teste é a forma da recomposição, não a redação: UMA passada sobre o template do
// operador, com as seções de contexto reanexadas ao texto já pronto. É essa forma que mantém a
// garantia de que um valor vindo de DADO — um atributo do Chatwoot preenchido pelo cliente — nunca
// vira placeholder resolvido. Interpolar de novo sobre o prompt pronto passaria em qualquer teste de
// idade e abriria essa porta em silêncio.

const AGORA = new Date("2026-09-20T12:00:00-03:00");
const TRES_DIAS = new Date("2026-09-17T12:00:00-03:00");

function cfgComIdade(sections: string[] = []) {
  const template =
    "Fale com {{nome_contato}}. Idade: {{idade_ultima_mensagem}}.";
  const vars = { nome_contato: "Maria" };
  const opts = { now: AGORA, messageAt: null as Date | null };
  const base = interpolatePromptVars(template, vars, opts);
  return makeConfig({
    systemPrompt: sections.length
      ? `${base}\n\n${sections.join("\n\n")}`
      : base,
    promptTemplate: template,
    promptVars: vars,
    promptOpts: opts,
    promptSections: sections,
    auditedSections: [],
  });
}

describe("withMessageAge", () => {
  test("responde a idade sem tocar no resto do prompt", () => {
    const antes = cfgComIdade();
    expect(antes.systemPrompt).toBe("Fale com Maria. Idade: .");
    const depois = withMessageAge(antes, TRES_DIAS);
    expect(depois.systemPrompt).toBe("Fale com Maria. Idade: há 3 dias.");
    expect(depois.promptOpts.messageAt).toEqual(TRES_DIAS);
  });

  // A GARANTIA QUE A FORMA CARREGA. O bloco de atributos é anexado ao prompt JÁ PRONTO justamente
  // para que um valor guardado no Chatwoot contendo `{{nome_contato}}` continue literal (docs/chatwoot.md).
  // Uma recomposição que interpolasse o texto pronto resolveria esse valor, e o cliente que escrevesse
  // o nome de uma variável num campo do seu cadastro leria o nome de outra pessoa.
  test("o que veio de dado continua literal depois da recomposição", () => {
    const bloco =
      "<attribute_values>\n<pedido>{{nome_contato}}</pedido>\n</attribute_values>";
    const depois = withMessageAge(cfgComIdade([bloco]), TRES_DIAS);
    expect(depois.systemPrompt).toContain("<pedido>{{nome_contato}}</pedido>");
    // E a seção continua UMA: recompor não pode duplicar o que foi anexado.
    expect(depois.systemPrompt.split("<attribute_values>").length - 1).toBe(1);
    // A metade do operador respondeu, para a asserção acima não passar com nada renderizado.
    expect(depois.systemPrompt).toContain("Fale com Maria. Idade: há 3 dias.");
  });

  // Sem instante não há o que recompor, e devolver a MESMA referência é o que prova que o caminho
  // comum (a esmagadora maioria dos turnos, com prompt sem a variável) não paga nada.
  test("sem instante, devolve a config intocada", () => {
    const antes = cfgComIdade();
    expect(withMessageAge(antes, null)).toBe(antes);
    expect(withMessageAge(antes, undefined)).toBe(antes);
  });

  test("o mesmo instante duas vezes não recompõe", () => {
    const uma = withMessageAge(cfgComIdade(), TRES_DIAS);
    expect(withMessageAge(uma, new Date(TRES_DIAS.getTime()))).toBe(uma);
  });
});

// A FONTE do instante no caminho reativo: a entrega do webhook. O `created_at` do Chatwoot vem em
// SEGUNDOS desde a época, e lê-lo como milissegundos dataria toda mensagem em 1970 — uma idade de
// mais de cinquenta anos onde a mensagem tem minutos, que é pior do que não responder nada.
describe("normalizeChatwootEvent: o instante da mensagem", () => {
  const evento = (over: Record<string, unknown>) =>
    normalizeChatwootEvent({
      event: "message_created",
      id: 71,
      content: "oi",
      message_type: "incoming",
      private: false,
      inbox: { id: 7, name: "E-mail" },
      conversation: {
        id: 1200,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: null, assignee: null, sender: { id: 4 } },
      },
      ...over,
    });

  test("lê a época em segundos", () => {
    const n = evento({ created_at: 1_758_000_000 });
    expect(n?.message?.createdAt?.getTime()).toBe(1_758_000_000_000);
  });

  test("lê a forma ISO", () => {
    const n = evento({ created_at: "2026-09-17T12:00:00Z" });
    expect(n?.message?.createdAt?.toISOString()).toBe(
      "2026-09-17T12:00:00.000Z",
    );
  });

  test("o que não dá para ler fica nulo", () => {
    expect(evento({ created_at: "ontem" })?.message?.createdAt).toBeNull();
    expect(evento({})?.message?.createdAt).toBeNull();
  });
});
