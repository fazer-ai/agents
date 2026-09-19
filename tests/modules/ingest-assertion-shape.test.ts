import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// ── UMA AFIRMAÇÃO SOBRE UMA MENSAGEM NÃO SE DECIDE PELO TAMANHO DA POPULAÇÃO (issue #723) ──
//
// A cerca, e não a checklist. Corrigir os sites um a um deixa a próxima adição livre para nascer na
// forma antiga, e foi assim que quarenta e cinco deles apareceram: cada um copiado do vizinho.
//
// O que a forma antiga custa, medido no holdout desta rodada:
//
// - VERMELHO MAL ATRIBUÍDO. Injetando no cliente do banco o dreno que o produto faz (some a linha
//   `INGEST_MESSAGE` mais antiga a cada leitura, nunca a recém-armada), o arquivo do seam foi de
//   38/0 para 33/5 na base, e o teste que a issue cita NÃO estava entre os cinco: caíram as irmãs. A
//   mensagem lê como defeito da feature, e quem cai nisso na CI descarta a feature antes de
//   suspeitar da suíte. Com a mesma injeção nesta árvore: 38/0.
// - VERDE QUE NÃO PROVA NADA, que é o caro. Com uma troca 1-por-1 (apaga a linha de outra mensagem,
//   planta a da mensagem sob teste, população constante), o arquivo passou 38/0 com a linha que ele
//   jura não existir dentro da tabela. Nenhuma melhora de mensagem de erro alcança isso: o veredito
//   é decidido pelo TAMANHO.
//
// A pergunta certa nomeia a linha, porque `INGEST_MESSAGE` é a única espécie cuja `dedupeKey` nomeia
// UMA mensagem (`scheduler/lanes.ts`, que é também por que a linha é apagada ao concluir). O
// construtor dela é `ingestDedupeKey`, exportado nesta rodada para os testes perguntarem em vez de
// remontarem o formato.
//
// O LEDGER ESTÁ VAZIO, e ele só encolhe. Ele nasceu com `chatwoot-observer-route.test.ts: 28`, que a
// #731 converteu; o pin literal caiu de 1 para 0 na mesma passada, que é a segunda edição, em outro
// lugar, que faz o débito ler como uma frase no diff. Um arquivo que volte a decidir pelo tamanho
// entra aqui com o número dele e sai quando for convertido — nunca o contrário.
//
// A REGEX NÃO É A FRONTEIRA DO DEFEITO, e vale dizer por escrito: ela casa a leitura crua da espécie
// seguida de `.length).toBe(`. Um `toEqual([])` sobre a mesma leitura, ou um `some()` sobre a
// população filtrada por substring do payload, decidem o mesmo fato pelo mesmo motivo errado e
// passam por aqui sem serem contados. A #731 achou quatro assim no arquivo que estava no ledger.

const TESTS_DIR = join(import.meta.dir, "..");

// `.length).toBe(` e `.toBeGreaterThan(` sobre a leitura das linhas de INGEST_MESSAGE: a forma que
// decide pelo tamanho. Ancorado no nome da espécie, não no do helper, porque o helper é local a cada
// arquivo e um arquivo novo chamaria o dele de outra coisa.
const POPULATION_SHAPE =
  /INGEST_MESSAGE"\s*\)\s*\)\s*\.length\s*\)\s*\.(?:toBe|toBeGreaterThan|toBeLessThan)\s*\(/g;

// Quantos sites da forma antiga cada arquivo ainda tem. Um arquivo que zerar sai da lista, e a
// contagem fixada abaixo cai junto — que é a segunda edição, em outro lugar, que o ledger cobra.
const POPULATION_SHAPE_WAIVED: Record<string, number> = {};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("an assertion about one message's ingestion", () => {
  test("decides by the message's own row, and the known backlog only shrinks", () => {
    const found: Record<string, number> = {};
    for (const file of walk(TESTS_DIR)) {
      const rel = file.slice(TESTS_DIR.length + 1);
      // O próprio arquivo da cerca contém a regex, e a prova vermelha da rodada fala da forma para
      // poder contrastá-la: nenhum dos dois DECIDE por população.
      if (
        rel === "modules/ingest-assertion-shape.test.ts" ||
        rel === "modules/ingest-armed-for-this-message.test.ts"
      )
        continue;
      const n = (readFileSync(file, "utf8").match(POPULATION_SHAPE) ?? [])
        .length;
      if (n > 0) found[rel] = n;
    }

    // IGUALDADE EXATA contra o ledger, nos dois sentidos. Filtrar `found` pelo ledger só cobriria um
    // deles: um arquivo que ZEROU sai de `found` e o waiver dele fica para trás, valendo como licença
    // para a forma antiga voltar àquele arquivo de graça.
    expect(
      found,
      "um site novo decide 'foi armada ingestão para esta mensagem' pelo tamanho da população de " +
        "INGEST_MESSAGE. Pergunte pela linha da mensagem — `ingestDedupeKey(graphThreadId, messageId)` " +
        "— como tests/modules/chatwoot-monitoring-seam.test.ts faz. Se um arquivo do ledger encolheu, " +
        "baixe o número dele.",
    ).toEqual(POPULATION_SHAPE_WAIVED);

    // O tamanho é LITERAL. Derivá-lo do próprio ledger (`Object.keys(...).length`) fixa o ledger em si
    // mesmo e não proíbe nada: é exatamente o append silencioso que `tests/utils/ledger.ts` descreve.
    expectWaiverLedger("POPULATION_SHAPE_WAIVED", POPULATION_SHAPE_WAIVED, 0);
  });
});
