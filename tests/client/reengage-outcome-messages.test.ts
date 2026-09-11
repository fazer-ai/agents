import { describe, expect, test } from "bun:test";

// CERCA, não checklist. Issue #594 acrescentou um desfecho (`busy`) e, com ele, a pergunta que vai
// se repetir a cada desfecho novo: o operador vai ler alguma coisa sobre isso, e nos dois idiomas?
//
// A resposta cai no `else` final ("The AI produced no reply.") quando ninguém lembra, e esse texto
// manda o operador esperar por nada. O defeito não aparece em nenhum teste de comportamento: a
// chamada devolve o desfecho certo e a tela mostra a frase errada.
//
// Por isso a varredura é do FONTE. Um desfecho que o módulo declara e a tela não trata reprova aqui,
// no commit que o declarou, e não meses depois num relato de operador.

const REENGAGE = "src/modules/conversations/reengage.ts";
const CONSOLE = "src/client/pages/ConversationDetailPage.tsx";
const EN = "src/client/locales/en.json";
const PT = "src/client/locales/pt-BR.json";

// Os desfechos que ESTE módulo acrescenta, que são os que a tela do re-engage tem obrigação de
// nomear. Os herdados de `RunAgentTurnOutcome` valem pelos ramos que já existem (`posted`,
// `posted-partial`) e pelo `else` final, que é o lugar legítimo de "o turno rodou e não respondeu".
function desfechosProprios(fonte: string): string[] {
  // Âncoras conferidas antes do recorte. `indexOf` devolve -1 para o que sumiu, `slice(-1, -1)`
  // devolve "" e um recorte vazio não declara desfecho nenhum: a cerca passaria justamente no
  // commit que renomeou o tipo. Padrão que para de casar tem que reprovar, não silenciar.
  const abre = fonte.indexOf("export type ReengageOutcome");
  const fecha = fonte.indexOf("export interface ReengageResult");
  if (abre < 0 || fecha <= abre) {
    throw new Error(
      `âncoras de ReengageOutcome não encontradas em ${REENGAGE} (abre=${abre}, fecha=${fecha})`,
    );
  }
  const bloco = fonte.slice(abre, fecha);
  return [...bloco.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1] as string);
}

function ramosDaTela(fonte: string): Set<string> {
  return new Set(
    [...fonte.matchAll(/data\.outcome === "([a-z-]+)"/g)].map(
      (m) => m[1] as string,
    ),
  );
}

function chaves(json: string): Set<string> {
  const d = JSON.parse(json) as {
    conversation?: { reengage?: Record<string, string> };
  };
  return new Set(Object.keys(d.conversation?.reengage ?? {}));
}

describe("todo desfecho do re-engage tem o que dizer ao operador", () => {
  test("cada desfecho próprio tem ramo na tela e chave nos dois locales", async () => {
    const proprios = desfechosProprios(await Bun.file(REENGAGE).text());
    const ramos = ramosDaTela(await Bun.file(CONSOLE).text());
    const en = chaves(await Bun.file(EN).text());
    const pt = chaves(await Bun.file(PT).text());

    // A cerca só vale se a varredura achou alguma coisa: um regex que para de casar passaria vazio.
    expect(proprios.length).toBeGreaterThanOrEqual(5);
    expect(proprios).toContain("busy");

    const semRamo = proprios.filter((o) => !ramos.has(o));
    expect(semRamo).toEqual([]);

    // A chave segue o mesmo nome em camelCase que a tela já usa: "gate-closed" -> "gateClosed".
    const camel = (o: string) =>
      o.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const semEn = proprios.filter((o) => !en.has(camel(o)));
    const semPt = proprios.filter((o) => !pt.has(camel(o)));
    expect(semEn).toEqual([]);
    expect(semPt).toEqual([]);
  });

  test("os dois locales têm exatamente as mesmas chaves de re-engage", async () => {
    const en = [...chaves(await Bun.file(EN).text())].sort();
    const pt = [...chaves(await Bun.file(PT).text())].sort();
    expect(pt).toEqual(en);
  });
});
