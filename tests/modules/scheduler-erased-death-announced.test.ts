import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { JOB_DELETE_ON_DONE } from "@/modules/scheduler/lanes";
import { codeOnly, withoutComments } from "@/tests/utils/source-text";

// Quem apaga uma morte deve o anúncio dela. `revokeJobsByKeyPrefixOn` deleta a linha `DEAD` de um
// kind `JOB_DELETE_ON_DONE` e devolve as mortes que apagou; quem chamou anuncia depois que a própria
// transação é durável, porque ela pode desfazer a exclusão e uma linha de log não se retrata
// (docs/logs.md). A cerca é sobre o PRÓXIMO chamador: uma obrigação escrita só em comentário, como a
// de `announceReaped`, é uma que o próximo chamador não lê. É uma varredura de FONTE porque o custo
// do esquecimento é o silêncio, e depois dele não há o que observar.

const OWNER = "src/modules/scheduler/service.ts";
const REVOKE = "revokeJobsByKeyPrefixOn";
const ANNOUNCE = "announceErasedDeaths";

// E a outra metade da mesma obrigação: a linha que o revoke devolve é a GENÉRICA, que
// `emitDeadLetter` reserva a kinds sem hook próprio (senão a mesma morte sairia duas vezes). O
// revoke não consegue perguntar ao registro sem ciclo de import (worker.ts já importa service.ts),
// e nenhum kind `JOB_DELETE_ON_DONE` registra hook. É um fato sobre a árvore, não uma garantia, e
// se cerca.
const REGISTRA = /registerDeadLetterHandler\(\s*"([A-Z_]+)"/g;

// Chama o revoke. O nome basta, e o import conta: um arquivo que só importa o símbolo e nunca o usa
// não tem dívida, mas também não passa por aqui sem anunciar, e o custo de um falso positivo é uma
// linha a mais num arquivo que já mexe com isso.
export function revokesJobs(source: string): boolean {
  return new RegExp(`\\b${REVOKE}\\s*\\(`).test(codeOnly(source));
}

export function announcesErasedDeaths(source: string): boolean {
  return new RegExp(`\\b${ANNOUNCE}\\s*\\(`).test(codeOnly(source));
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFilesUnder(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("quem revoga uma ingestão anuncia as mortes que apagou", () => {
  // O predicado se prova em fixture ANTES de valer sobre a árvore, nos dois sentidos: uma cerca sem
  // infrator passa sobre o conjunto vazio tão feliz quanto sobre o correto.
  test("o predicado enxerga a chamada, inclusive quebrada pelo formatador", () => {
    for (const site of [
      `await revokeJobsByKeyPrefixOn(db, "INGEST_MESSAGE", p);`,
      `const r = await revokeJobsByKeyPrefixOn(\n  db,\n  kind,\n  prefix,\n);`,
      `revokeJobsByKeyPrefixOn (db, kind, prefix)`,
    ]) {
      expect(revokesJobs(site)).toBe(true);
    }
    expect(announcesErasedDeaths(`announceErasedDeaths(deaths, base);`)).toBe(
      true,
    );
  });

  test("o predicado ignora a menção que não é chamada", () => {
    for (const innocent of [
      `// revokeJobsByKeyPrefixOn devolve as mortes que apagou`,
      `import { revokeJobsByKeyPrefixOn } from "./service";`,
      `const nome = "revokeJobsByKeyPrefixOn";`,
    ]) {
      expect(revokesJobs(innocent)).toBe(false);
    }
    expect(
      announcesErasedDeaths(`// announceErasedDeaths é chamado pelo /reset`),
    ).toBe(false);
  });

  test("nenhum kind delete-on-done registra hook de dead-letter", async () => {
    const root = join(import.meta.dir, "..", "..");
    const files = await tsFilesUnder(join(root, "src"));
    expect(files.length).toBeGreaterThan(200);
    const comHook: string[] = [];
    for (const file of files) {
      // `withoutComments` e não `codeOnly`: o segundo apaga o CONTEÚDO das strings, que aqui é
      // exatamente o que se quer ler. Comentário continua fora, que é o que importa (uma menção em
      // prosa não registra hook nenhum).
      const code = withoutComments(await Bun.file(file).text());
      for (const m of code.matchAll(REGISTRA)) {
        if (m[1]) comHook.push(m[1]);
      }
    }
    // Controle positivo da varredura: os dois hooks que existem têm que aparecer, senão a cerca
    // estaria passando sobre um conjunto vazio.
    expect(comHook.sort()).toEqual(["DEBOUNCE", "MEMORY_COMPACT"]);
    const conflito = comHook.filter(
      (k) => JOB_DELETE_ON_DONE[k as keyof typeof JOB_DELETE_ON_DONE],
    );
    expect(conflito).toEqual([]);
  });

  test("todo chamador do revoke também anuncia", async () => {
    const root = join(import.meta.dir, "..", "..");
    const files = await tsFilesUnder(join(root, "src"));
    // Controle positivo da VARREDURA, além do predicado: uma varredura no diretório errado devolve
    // conjunto vazio de infratores e passa.
    expect(files.length).toBeGreaterThan(200);
    const devedores: string[] = [];
    for (const file of files) {
      const rel = relative(root, file);
      // O dono define os dois lados; a dívida é de quem chama.
      if (rel === OWNER) continue;
      const src = await Bun.file(file).text();
      if (revokesJobs(src) && !announcesErasedDeaths(src)) devedores.push(rel);
    }
    expect(devedores.sort()).toEqual([]);
  });
});
