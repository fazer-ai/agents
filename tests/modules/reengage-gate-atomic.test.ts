import { describe, expect, test } from "bun:test";

// Cerca de FORMA, porque a de comportamento não existe. O portão do re-engage é uma ORDEM: a
// leitura durável primeiro e, depois dela, nada de `await` até `markFlushHold`; um `await` no meio
// deixa duas chamadas concorrentes lerem "livre" e marcarem as duas. Um teste de corrida não pega
// isso: a barreira só sincroniza a ENTRADA, as idas ao banco re-serializam as chamadas antes do
// portão, e só uma costura de produção dentro do módulo resolveria. O verde desta cerca NÃO prova
// que o portão exclui. Ela falha DURO quando as âncoras somem, porque um padrão que para de casar e
// devolve verde é um falso sobrevivente.

const ARQUIVO = "src/modules/conversations/reengage.ts";
const ABRE = "const donoDuravel =";
const FECHA = "markFlushHold(graphThreadId);";

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("o portão do re-engage é um bloco síncrono", () => {
  test("entre a leitura durável e a marca não existe outro await", async () => {
    const fonte = await Bun.file(ARQUIVO).text();

    // As âncoras primeiro, e cada uma exatamente uma vez: sem isso o recorte abaixo pode ficar
    // vazio, e um recorte vazio passa em toda asserção que vem depois.
    expect(fonte.split(ABRE).length - 1).toBe(1);
    expect(fonte.split(FECHA).length - 1).toBe(1);

    const inicio = fonte.indexOf(ABRE);
    const fim = fonte.indexOf(FECHA) + FECHA.length;
    expect(fim).toBeGreaterThan(inicio);

    const trecho = semComentarios(fonte.slice(inicio, fim));

    // A checagem local mora DENTRO do recorte, isto é, depois da leitura durável e antes da marca.
    // Se ela subir para antes do `await`, o recorte deixa de descrever o que ele afirma proteger.
    expect(trecho).toContain("isTurnInFlight(graphThreadId)");
    expect(trecho).toContain("isFlushHeld(graphThreadId)");

    const esperas = [...trecho.matchAll(/\bawait\b/g)];
    expect(esperas).toHaveLength(1);

    // E o único `await` permitido é o da própria leitura durável: um predicado `async`
    // extraído mantém a contagem em 1 e só troca o nome.
    const unica = trecho.slice(esperas[0]?.index ?? 0);
    expect(unica.startsWith("await turnOwnsThread(")).toBe(true);
  });
});
