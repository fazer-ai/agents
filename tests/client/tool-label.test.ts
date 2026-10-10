import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import {
  renderConversation,
  stubConversationApi,
} from "../utils/conversation-page";
import {
  installFakeWebSocket,
  openSocket,
  restoreWebSocket,
} from "../utils/fake-websocket";

const realFetch = globalThis.fetch;

// ── A REGRA DO RÓTULO MORA NUM MÓDULO PRÓPRIO, PARA PODER SER CHAMADA ──
//
// Renderizar `ConversationDetailPage.tsx` puxa auth, tema, toast, realtime e uma conversa viva, e o
// rótulo do silêncio depende de um segundo argumento (se o turno entregou algo), o tipo de condição
// que se erra em silêncio. Por isso a regra é pura e testada aqui.
//
// O módulo devolve chave + texto padrão em vez de texto traduzido, porque traduzir é do `t()` e o
// extrator de i18n lê chamadas estáticas. A trilha e o indicador ao vivo passam pela mesma função.

async function regra() {
  const mod = await import("@/client/lib/tool-label");
  return mod.toolLabel;
}

describe("a regra do rótulo de ferramenta", () => {
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

  // NOTE: o nome vem do operador (ferramenta HTTP, servidor MCP), e num objeto literal
  // `BY_TOOL["constructor"]` devolve o construtor herdado, que é truthy: o rótulo sairia vazio e o
  // operador perderia até o nome humanizado da ferramenta desconhecida.
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

  // NOTE: ausente é "não sei", e "não sei" não pode virar "entregou": uma linha escrita antes de o
  // fato ser gravado não o carrega, e a tela não pode inventá-lo por omissão.
  test("sem o fato, o rótulo é o de hoje", async () => {
    const toolLabel = await regra();
    const key = "conversation.activity.skip";
    expect(toolLabel("skip_reply")?.key).toBe(key);
    expect(toolLabel("skip_reply", {})?.key).toBe(key);
    expect(toolLabel("skip_reply", { delivered: null })?.key).toBe(key);
  });
});

// A página, renderizada: a regra só serve se o fato do turno chegar nela pelos TRÊS fios, porque
// cada um sozinho deixa metade da correção de pé: a trilha lê a entrada, o balão lê o estado, e o
// estado só tem o fato se o evento do canal for lido.
describe("a página rotula pela regra", () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
    restoreWebSocket();
    // NOTE: the signed-in tenant is remembered in storage, and a later file's page would open a real
    // socket for it.
    sessionStorage.clear();
    localStorage.clear();
  });

  const ENTREGOU = "Nothing further to add";
  const MUDO = "Decided not to respond";
  const silencio = (id: string, turnDelivered: boolean | null) => ({
    id,
    kind: "tool",
    originRecorded: null,
    messageId: null,
    integrationName: null,
    name: "skip_reply",
    status: "success",
    durationMs: 3,
    step: null,
    args: null,
    output: null,
    errorMessage: null,
    turnDelivered,
    at: `2026-10-10T12:00:0${id}.000Z`,
  });

  // NOTE: a página não pode voltar a decidir o rótulo do silêncio por conta própria, com um `switch`
  // sobre o nome da ferramenta.
  test("a página delega a regra em vez de repeti-la", async () => {
    await renderConversation(
      stubConversationApi({ trail: [silencio("1", true)] }),
    );
    await screen.findByText(ENTREGOU);
    expect(screen.queryAllByText(MUDO).length).toBe(0);
  });

  test("os três fios do fato chegam até a regra", async () => {
    installFakeWebSocket();
    // A trilha: um turno que entregou e um que não, cada um com o seu rótulo.
    await renderConversation(
      stubConversationApi(
        { trail: [silencio("1", true), silencio("2", false)] },
        "TENANT_ADMIN",
        "t1",
      ),
    );
    await screen.findByText(ENTREGOU);
    expect(screen.queryAllByText(MUDO).length).toBe(1);
    // O evento do canal: o turno em curso, que já entregou, decide ficar quieto.
    const socket = await waitFor(openSocket);
    act(() => {
      socket.deliver({
        type: "agent-activity",
        at: Date.now(),
        tenantId: "t1",
        conversationId: "77",
        phase: "step",
        stage: "tool",
        tool: "skip_reply",
        delivered: true,
      });
    });
    await waitFor(() => expect(screen.queryAllByText(ENTREGOU).length).toBe(2));
    expect(screen.queryAllByText(MUDO).length).toBe(1);
  });
});
