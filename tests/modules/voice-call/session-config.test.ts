import { describe, expect, test } from "bun:test";
import { voiceSessionConfig } from "@/modules/voice-call/service";

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
    const section = instructions.slice(
      instructions.indexOf("# Conversa até agora no WhatsApp"),
    );
    expect(instructions.startsWith("Você é a Raquel.")).toBe(true);
    expect(section).toContain("Quem está ligando é o contato desta conversa.");
    expect(section).toContain("não peça de novo");
    expect(section.endsWith(history)).toBe(true);
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
