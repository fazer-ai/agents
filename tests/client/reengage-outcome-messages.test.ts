import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import type { ReengageOutcome } from "@/modules/conversations/reengage";
import {
  renderConversation,
  stubConversationApi,
} from "../utils/conversation-page";
import { createTestI18n } from "../utils/i18n";

// Todo desfecho do re-engage traz a mesma pergunta: o operador vai ler alguma coisa sobre isso, e
// nos dois idiomas? Quando ninguém lembra, a resposta cai no `else` final ("The AI produced no
// reply."), que manda o operador esperar por nada. O mapa abaixo é do TIPO dos desfechos: um
// desfecho novo não compila até alguém dizer qual frase ele mostra, e a tela é conferida clicando.

type ReengageKey = keyof typeof en.conversation.reengage;

// A frase que cada desfecho mostra. `noReply` é o lugar legítimo de "o turno rodou e não respondeu".
const FRASE: Record<ReengageOutcome, ReengageKey> = {
  posted: "posted",
  "posted-partial": "postedPartial",
  empty: "empty",
  "gate-closed": "gateClosed",
  "not-authorized": "notAuthorized",
  "over-ceiling": "overCeiling",
  busy: "busy",
  skipped: "noReply",
  "no-agent": "noReply",
  "agent-unavailable": "noReply",
  "taken-over": "noReply",
  stale: "noReply",
  "thread-busy": "noReply",
  "taken-over-unread": "noReply",
  superseded: "noReply",
  "answered-elsewhere": "noReply",
  blocked: "noReply",
};

const CATALOGOS = { en, "pt-BR": ptBR } as const;

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("todo desfecho do re-engage tem o que dizer ao operador", () => {
  for (const lng of ["en", "pt-BR"] as const) {
    const catalogo = CATALOGOS[lng].conversation.reengage;
    for (const [desfecho, chave] of Object.entries(FRASE)) {
      test(`${lng}: "${desfecho}" mostra a frase de ${chave}`, async () => {
        const stub = stubConversationApi({
          lastError: "o modelo não respondeu",
          lastErrorAt: "2026-01-01T00:00:00.000Z",
        });
        stub.reengageOutcome = desfecho;
        await renderConversation(
          stub,
          createTestI18n(lng, {
            en: { translation: en },
            "pt-BR": { translation: ptBR },
          }),
        );
        fireEvent.click(screen.getByRole("button", { name: catalogo.action }));
        await screen.findByText(catalogo[chave]);
      });
    }
  }

  test("os dois locales têm exatamente as mesmas chaves de re-engage", () => {
    expect(Object.keys(ptBR.conversation.reengage).sort()).toEqual(
      Object.keys(en.conversation.reengage).sort(),
    );
  });
});
