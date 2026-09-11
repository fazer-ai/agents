import { describe, expect, test } from "bun:test";

// CERCA DE FORMA, porque a de comportamento não existe.
//
// A correção da #594 é uma ORDEM, não um valor: a leitura durável primeiro e, depois dela, nada de
// `await` até `markFlushHold`. Extrair as duas metades para um predicado `async` põe um `await` no
// meio, as duas chamadas concorrentes cedem o event loop no mesmo ponto, leem "livre" as duas e
// marcam as duas. Foi exatamente o que aconteceu na rodada 4 do review desta PR.
//
// O motivo desta cerca existir é medido, não suposto. O teste de clique duplo de
// tests/modules/reengage.test.ts foi rodado pelo verificador contra o fonte QUEBRADO e passou 5 de
// 5, com a barreira nos dois únicos pontos injetáveis de fora do módulo (a leitura do Chatwoot e o
// endpoint de autorização). A razão é estrutural: a barreira sincroniza a ENTRADA, e depois da
// largada cada chamada ainda faz duas idas ao banco cuja diferença de latência re-serializa as duas
// antes do portão. Só uma costura DENTRO do módulo, depois do último `await`, faria as duas
// chegarem juntas — e uma costura assim é superfície de produção existindo só para o teste.
//
// Então o que sobra é o que esta cerca faz: afirmar a forma, no idioma que o repo já usa em
// tests/client/reengage-outcome-messages.test.ts. Ela pega a regressão que de fato aconteceu, é
// determinística, e não custa nada em produção. O que ela NÃO é: prova de que o portão exclui. Isso
// está escrito aqui para ninguém ler o verde dela como a medição que ela não fez.
//
// A cerca falha DURO quando as âncoras somem. Um padrão que para de casar e devolve verde é o modo
// de falha que já custou três falsos sobreviventes na bateria de mutação desta mesma PR.

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

    // E o único `await` permitido é o da própria leitura durável. Um predicado extraído mantém a
    // contagem em 1 e troca o nome; é essa a regressão da rodada 4.
    const unica = trecho.slice(esperas[0]?.index ?? 0);
    expect(unica.startsWith("await turnOwnsThread(")).toBe(true);
  });
});
