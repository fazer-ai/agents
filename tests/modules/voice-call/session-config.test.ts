import { describe, expect, spyOn, test } from "bun:test";
import type { ChatwootClient, RecentMessage } from "@/modules/chatwoot/client";
import * as chatwootInstance from "@/modules/chatwoot/instance";
import {
  conversationHistory,
  voiceSessionConfig,
} from "@/modules/voice-call/service";

// The call's instructions carry the WhatsApp conversation as something the agent answers from: the
// caller is that conversation's contact, and what the contact or the team wrote there is not asked
// again. A conversation with no messages adds nothing.

const route = {
  tenantId: 1n,
  instanceId: 2n,
  inboxId: 501,
  agentId: 3n,
  agentName: "Raquel",
  systemPrompt: "Você é a Raquel.",
};
const ctx = { conversationId: 10, inboxId: 501, direction: "inbound" as const };

describe("the conversation in a call's instructions", () => {
  test("comes after the agent's own, said to be the caller's and to be answered from", () => {
    const history =
      "Contato: queria saber do pedido 4821\nAtendimento: o pedido 4821 sai amanhã";
    const { instructions } = voiceSessionConfig(route, ctx, undefined, history);
    const at = instructions.indexOf("# Conversa até agora no WhatsApp");
    const rules = instructions.indexOf("# Ligação de voz");
    const section = instructions.slice(at, rules);
    expect(instructions.startsWith("Você é a Raquel.")).toBe(true);
    // Right after the agent's own prompt, before the voice rules (see HISTORY_NOTE for the measure).
    expect(at).toBeGreaterThan(0);
    expect(rules).toBeGreaterThan(at);
    expect(section).toContain("Quem está ligando é o contato desta conversa");
    expect(section).toContain("responda com isso na hora");
    expect(section.trimEnd().endsWith(history)).toBe(true);
    // And the rule on what the agent may say counts the conversation as a source.
    expect(instructions).toContain(
      "nestas instruções, na conversa do WhatsApp abaixo ou no retorno de uma ferramenta",
    );
  });

  test("is left out when the conversation has nothing", () => {
    expect(voiceSessionConfig(route, ctx).instructions).not.toContain(
      "# Conversa até agora",
    );
  });
});

describe("the conversation a call reads", () => {
  // The page is the REST list's shape: a voice note's words sit on the attachment's `meta`.
  test("keeps what a voice note said, whoever sent it, and leaves out private notes", async () => {
    const page: RecentMessage[] = [
      { content: "Oi, é sobre o pedido 4821", message_type: 0, private: false },
      {
        content: "",
        message_type: 0,
        private: false,
        attachments: [
          { file_type: "audio", meta: { transcribed_text: "ele sai quando?" } },
        ],
      },
      {
        content: null,
        message_type: 1,
        private: false,
        attachments: [
          {
            file_type: "audio",
            meta: { transcribed_text: "sai amanhã de manhã" },
          },
        ],
      },
      { content: "nota interna", message_type: 1, private: true },
      // An audio nobody transcribed yet says nothing, and is left out.
      {
        content: "",
        message_type: 0,
        private: false,
        attachments: [{ file_type: "audio", meta: { transcribed_text: "" } }],
      },
    ];
    const client = spyOn(
      chatwootInstance,
      "loadChatwootClient",
    ).mockImplementation(
      async () =>
        ({ listRecentMessages: async () => page }) as unknown as ChatwootClient,
    );
    try {
      expect(await conversationHistory(route, 10)).toBe(
        [
          "Contato: Oi, é sobre o pedido 4821",
          "Contato: ele sai quando?",
          "Atendimento: sai amanhã de manhã",
        ].join("\n"),
      );
    } finally {
      client.mockRestore();
    }
  });
});
