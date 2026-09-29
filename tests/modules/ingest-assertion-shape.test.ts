import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// ── UMA AFIRMAÇÃO SOBRE UMA MENSAGEM NÃO SE DECIDE PELO TAMANHO DA POPULAÇÃO ──
// A cerca, e não a checklist: corrigir os sites um a um deixa a próxima adição nascer copiada do
// vizinho. Por que o tamanho mente: ingest-armed-for-this-message.test.ts. A pergunta certa nomeia a
// linha, porque `INGEST_MESSAGE` é a única espécie cuja `dedupeKey` nomeia UMA mensagem
// (`scheduler/lanes.ts`), e `ingestDedupeKey` é exportado para os testes perguntarem em vez de
// remontarem o formato. O LEDGER ESTÁ VAZIO e só encolhe. A REGEX NÃO É A FRONTEIRA DO DEFEITO: ela
// casa a leitura crua seguida de `.length).toBe(`, e um `toEqual([])` ou um `some()` por substring do
// payload decidem o mesmo fato pelo mesmo motivo errado sem serem contados.

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
      // NOTE: O próprio arquivo da cerca contém a regex, e ingest-armed-for-this-message fala da forma para
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
