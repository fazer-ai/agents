import { describe, expect, test } from "bun:test";
import { withoutComments } from "../utils/source-text";

// ── A REGRA DO RÓTULO SAI DA PÁGINA PARA PODER SER MEDIDA (issue #726) ──
//
// Hoje a regra é um `switch` dentro de um hook dentro de `ConversationDetailPage.tsx`, e a página só
// tem teste de fonte porque renderizá-la puxa auth, tema, toast, realtime e uma conversa viva. Uma
// regra que ninguém consegue chamar é uma regra que ninguém consegue provar, e é por isso que a
// mudança começa tirando-a de lá: o rótulo do silêncio passa a depender de um segundo argumento, e
// esse é exatamente o tipo de condição que se erra em silêncio.
//
// O módulo devolve chave + texto padrão em vez de texto traduzido, porque traduzir é do `t()` e o
// extrator de i18n lê chamadas estáticas. As duas superfícies (a trilha e o indicador ao vivo)
// passam pela mesma função, que é o que impede uma delas de ficar para trás.

const MODULO = "src/client/lib/tool-label.ts";

async function regra() {
  const mod = await import("@/client/lib/tool-label");
  return mod.toolLabel;
}

describe("a regra do rótulo de ferramenta", () => {
  test("a regra mora num módulo próprio, sem React", async () => {
    expect(await Bun.file(MODULO).exists()).toBe(true);
    const src = await Bun.file(MODULO).text();
    expect(src).not.toInclude("useTranslation");
    expect(src).not.toMatch(/from ["']react/);
  });

  // O INSTRUMENTO: a regra responde pelos nomes que ela já respondia. Se isto falhar, os vereditos
  // sobre `skip_reply` não dizem nada.
  test("o instrumento: os rótulos que já existiam continuam existindo", async () => {
    const toolLabel = await regra();
    expect(toolLabel("handoff_to_human")?.key).toBe(
      "conversation.activity.handoff",
    );
    expect(toolLabel("search_knowledge")?.key).toBe(
      "conversation.activity.search",
    );
    expect(toolLabel("uma_ferramenta_do_operador")).toBeNull();
    expect(toolLabel(null)).toBeNull();
  });

  // O ACHADO DA RODADA 1 DE REVIEW. O nome vem do operador (ferramenta HTTP, servidor MCP), e num
  // objeto literal `BY_TOOL["constructor"]` devolve o construtor herdado, que é truthy: o rótulo sai
  // como `t(undefined, undefined)`, uma string vazia, e o operador perde até o nome humanizado que a
  // ferramenta desconhecida teria. O `switch` de antes não tinha esse buraco, então ele entrou com
  // esta entrega.
  test("nome herdado do Object não vira rótulo", async () => {
    const toolLabel = await regra();
    for (const nome of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(toolLabel(nome)).toBeNull();
    }
  });

  test("silêncio de um turno que entregou tem rótulo PRÓPRIO", async () => {
    const toolLabel = await regra();
    const entregou = toolLabel("skip_reply", { delivered: true });
    const mudo = toolLabel("skip_reply", { delivered: false });
    expect(entregou?.key).not.toBe(mudo?.key);
    expect(entregou?.fallback).not.toBe(mudo?.fallback);
  });

  // O par obrigatório: o turno realmente mudo continua dizendo, com todas as letras, que o agente
  // decidiu não responder. Uma correção que neutralize os dois apaga um fato verdadeiro.
  test("silêncio de um turno mudo continua sendo a frase de hoje", async () => {
    const toolLabel = await regra();
    expect(toolLabel("skip_reply", { delivered: false })?.key).toBe(
      "conversation.activity.skip",
    );
  });

  // Ausente é "não sei", e "não sei" não pode virar "entregou": uma linha escrita antes desta entrega
  // não carrega o fato, e a tela não pode inventá-lo por omissão.
  test("sem o fato, o rótulo é o de hoje", async () => {
    const toolLabel = await regra();
    const key = "conversation.activity.skip";
    expect(toolLabel("skip_reply")?.key).toBe(key);
    expect(toolLabel("skip_reply", {})?.key).toBe(key);
    expect(toolLabel("skip_reply", { delivered: null })?.key).toBe(key);
  });

  // A cerca nasce na rota que revelou o defeito: a página não pode voltar a decidir o rótulo do
  // silêncio por conta própria, que é o `switch` sobre o nome com que esta issue começou.
  test("a página delega a regra em vez de repeti-la", async () => {
    const src = withoutComments(
      await Bun.file("src/client/pages/ConversationDetailPage.tsx").text(),
    );
    expect(src).toInclude("tool-label");
    expect(src).not.toInclude('case "skip_reply"');
  });

  // A regra pura não serve de nada se o fato não chegar nela, e este é o único lugar onde isso dá
  // para medir: renderizar a página puxa auth, tema, toast, realtime e uma conversa viva, e o
  // marcador é um componente local. Então é fonte, e é fonte nos TRÊS fios, porque cada um deles
  // sozinho deixa metade da correção de pé: a trilha lê a entrada, o balão lê o estado, e o estado
  // só tem o fato se o evento do canal for lido.
  test("os três fios do fato chegam até a regra", async () => {
    const src = withoutComments(
      await Bun.file("src/client/pages/ConversationDetailPage.tsx").text(),
    );
    expect(src).toInclude("entry.turnDelivered");
    expect(src).toInclude("activity.delivered");
    expect(src).toInclude("event.delivered");
  });
});
