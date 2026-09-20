import { describe, expect, test } from "bun:test";
import { withoutComments } from "../utils/source-text";

// ── UM CAMPO NOVO NO EVENTO PRECISA CHEGAR NA PONTA, E O TYPESCRIPT NÃO COBRA ISSO ──
//
// `useTenantEvents` remonta cada evento campo a campo antes de entregá-lo ao consumidor. Todo campo
// OPCIONAL que alguém acrescente ao evento do servidor e esqueça nessa remontagem some em silêncio:
// o tipo do cliente declara o campo, a página o lê, o compilador aprova, e o valor nunca sai do
// hook. Não é hipótese — foi exatamente o que aconteceu com `delivered` na issue #726, e o sintoma
// foi o indicador ao vivo dizendo "Decidiu não responder" um segundo depois de a mensagem já estar
// na thread, que é a superfície onde o operador não tem como conferir depois.
//
// A cerca nasce na rota que revelou o defeito, e a rota é a remontagem. Fonte porque é uma pergunta
// sobre transporte, não sobre comportamento: renderizar o hook exige WebSocket, auth e um tenant, e
// mesmo assim só provaria o campo que o teste lembrasse de mandar. Isto cobre o PRÓXIMO campo.

const HOOK = "src/client/hooks/useTenantEvents.ts";
const SERVICE = "src/api/features/realtime/realtime.service.ts";

// O corpo de `interface <nome> { … }`, achando o fecho pelo balanceamento das chaves.
function corpoDaInterface(src: string, nome: string): string {
  const i = src.indexOf(`interface ${nome} {`);
  expect(i).toBeGreaterThanOrEqual(0);
  const abre = src.indexOf("{", i);
  let nivel = 0;
  for (let j = abre; j < src.length; j++) {
    if (src[j] === "{") nivel++;
    else if (src[j] === "}" && --nivel === 0) return src.slice(abre + 1, j);
  }
  throw new Error(`interface ${nome} não fecha`);
}

// Os nomes das propriedades de topo, com `?` e tipo descartados. Fatiado por separador de topo e
// não por linha: `onAgentConfig?.({ agentId: …, updatedAt: … })` cabe numa linha só, e um leitor por
// linha enxergaria a primeira propriedade e declararia as outras ausentes.
function campos(corpo: string): string[] {
  const fora: string[] = [];
  let nivel = 0;
  let atual = "";
  const fecha = () => {
    const m = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(atual);
    if (m?.[1]) fora.push(m[1]);
    atual = "";
  };
  for (const ch of corpo) {
    if (ch === "{" || ch === "[" || ch === "(") nivel++;
    else if (ch === "}" || ch === "]" || ch === ")") nivel--;
    if (nivel === 0 && (ch === ";" || ch === ",")) fecha();
    else atual += ch;
  }
  fecha();
  return fora.sort();
}

// As chaves que a remontagem escreve em `on<Nome>?.({ … })`.
function remontados(src: string, handler: string): string[] {
  const i = src.indexOf(`${handler}?.({`);
  expect(i).toBeGreaterThanOrEqual(0);
  const abre = src.indexOf("{", i);
  let nivel = 0;
  for (let j = abre; j < src.length; j++) {
    if (src[j] === "{") nivel++;
    else if (src[j] === "}" && --nivel === 0) {
      return campos(src.slice(abre + 1, j));
    }
  }
  throw new Error(`${handler} não fecha`);
}

// Os quatro eventos que o hook remonta, e o handler de cada um.
const EVENTOS = [
  ["ConversationRealtimeEvent", "onConversation"],
  ["AgentActivityRealtimeEvent", "onAgentActivity"],
  ["KnowledgeDocumentRealtimeEvent", "onKnowledgeDocument"],
  ["AgentConfigRealtimeEvent", "onAgentConfig"],
] as const;

// O par servidor/cliente, e os três campos do envelope que o hook descarta de propósito.
const PARES = [
  ["ConversationEvent", "ConversationRealtimeEvent"],
  ["AgentActivityEvent", "AgentActivityRealtimeEvent"],
  ["KnowledgeDocumentEvent", "KnowledgeDocumentRealtimeEvent"],
  ["AgentConfigEvent", "AgentConfigRealtimeEvent"],
] as const;
const ENVELOPE = ["type", "at", "tenantId"];

// E a MESMA carga é declarada uma terceira vez, no membro da união que tipa o que chega do socket.
// Este hop o compilador cobre, porque a remontagem lê `msg.<campo>` — mas só cobre o campo que
// alguém tentou ler, então o alinhamento dos três continua sendo uma afirmação, não um teorema.
const DISCRIMINANTES = [
  ["conversation", "ConversationEvent"],
  ["agent-activity", "AgentActivityEvent"],
  ["knowledge-document", "KnowledgeDocumentEvent"],
  ["agent-config", "AgentConfigEvent"],
] as const;

// O membro da união `TenantRealtimeEvent` cujo `type` é o discriminante dado.
function membroDaUniao(src: string, discriminante: string): string {
  const marca = `type: "${discriminante}";`;
  const i = src.indexOf(marca);
  expect(i).toBeGreaterThanOrEqual(0);
  const abre = src.lastIndexOf("{", i);
  let nivel = 0;
  for (let j = abre; j < src.length; j++) {
    if (src[j] === "{") nivel++;
    else if (src[j] === "}" && --nivel === 0) return src.slice(abre + 1, j);
  }
  throw new Error(`membro ${discriminante} não fecha`);
}

describe("o evento do canal chega inteiro na ponta", () => {
  // O CONTROLE POSITIVO, antes dos vereditos: duas listas vazias são iguais, então um leitor que não
  // encontrasse campo nenhum passaria em tudo abaixo sem ler uma linha do que promete guardar.
  test("o leitor encontra os campos que estão lá", async () => {
    const hook = withoutComments(await Bun.file(HOOK).text());
    expect(
      campos(corpoDaInterface(hook, "AgentActivityRealtimeEvent")),
    ).toEqual([
      "balloons",
      "conversationId",
      "delivered",
      "phase",
      "runAt",
      "stage",
      "tool",
    ]);
    expect(remontados(hook, "onAgentConfig")).toEqual(["agentId", "updatedAt"]);
    expect(campos(membroDaUniao(hook, "agent-activity"))).toContain(
      "delivered",
    );
  });

  test("a remontagem do hook escreve todo campo que o tipo do cliente declara", async () => {
    const src = withoutComments(await Bun.file(HOOK).text());
    for (const [nome, handler] of EVENTOS) {
      expect({
        [nome]: remontados(src, handler),
      }).toEqual({ [nome]: campos(corpoDaInterface(src, nome)) });
    }
  });

  // A terceira declaração da mesma carga: o que chega do socket. Um campo que falte aqui não é lido
  // pela remontagem nem que ela o escreva.
  test("o tipo do que chega do socket declara os mesmos campos", async () => {
    const hook = withoutComments(await Bun.file(HOOK).text());
    const service = withoutComments(await Bun.file(SERVICE).text());
    for (const [discriminante, servidor] of DISCRIMINANTES) {
      expect({
        [discriminante]: campos(membroDaUniao(hook, discriminante)),
      }).toEqual({
        [discriminante]: campos(corpoDaInterface(service, servidor)),
      });
    }
  });

  // O outro lado da mesma perda: um campo que o servidor passa a mandar e o tipo do cliente não
  // declara nunca chega a ter uma remontagem para esquecer.
  test("o tipo do cliente declara todo campo que o servidor manda", async () => {
    const hook = withoutComments(await Bun.file(HOOK).text());
    const service = withoutComments(await Bun.file(SERVICE).text());
    for (const [servidor, cliente] of PARES) {
      const daqui = campos(corpoDaInterface(service, servidor)).filter(
        (c) => !ENVELOPE.includes(c),
      );
      expect({ [servidor]: daqui }).toEqual({
        [servidor]: campos(corpoDaInterface(hook, cliente)),
      });
    }
  });
});
