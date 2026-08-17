import type { GuardrailChecks } from "./settings";

// Default analysis prompts for the guardrails agent, inspired by the OpenAI moderation categories.
// One system prompt describes the ENABLED checks + policy; the model returns a strict-JSON verdict
// (parsed in ./analyze). Kept prompt-only so the checks are tunable without touching the runtime.

export interface GuardrailPromptParams {
  direction: "input" | "output";
  checks: GuardrailChecks;
  competitors: string[];
  customPolicy: string;
  // The main agent's instructions (its system prompt), for the promptAdherence (output) check.
  systemPrompt?: string;
  // The customer message this reply is answering, for the answerRelevance (output) check. Without
  // it the check has nothing to compare against, so both travel under the same condition.
  customerMessage?: string;
  // Steering for the generated replacement reply (action === "generated"); empty → generic safe reply.
  generationPrompt?: string;
}

const CHECK_DEFINITIONS: Record<keyof GuardrailChecks, string> = {
  toxicity:
    "toxicity — harassment, hate speech, insults, or abusive/threatening language.",
  unsafeContent:
    "unsafe_content — sexual content, graphic violence, instructions for illegal or dangerous acts, or self-harm.",
  competitorMentions:
    "competitor_mention — any mention, recommendation, or promotion of a competitor from the list below.",
  promptAdherence:
    "prompt_adherence — the assistant reply goes outside the scope, persona, or policy set by the agent's instructions (off-topic, contradicts those instructions, or leaks internal details).",
  answerRelevance:
    "answer_relevance — the assistant reply does not answer what the customer actually asked: it addresses a different question, or leaves the question the customer asked unanswered.",
};

// The checks that only mean something on an assistant reply, so they never enter an input prompt:
// one compares the reply against the agent's instructions, the other against the customer's message.
const OUTPUT_ONLY_CHECKS: (keyof GuardrailChecks)[] = [
  "promptAdherence",
  "answerRelevance",
];

export function buildGuardrailSystemPrompt(p: GuardrailPromptParams): string {
  const subject =
    p.direction === "input"
      ? "a message a CUSTOMER sent to a support assistant"
      : "a REPLY a support assistant is about to send to a customer";
  const active = (Object.keys(p.checks) as (keyof GuardrailChecks)[]).filter(
    (k) =>
      p.checks[k] &&
      (!OUTPUT_ONLY_CHECKS.includes(k) || p.direction === "output"),
  );
  const lines: string[] = [
    `You are a content-moderation guardrail. Analyze ${subject} and decide whether it violates any of the ENABLED policies below.`,
    "",
    "ENABLED policies:",
    ...active.map((k) => `- ${CHECK_DEFINITIONS[k]}`),
  ];
  if (p.checks.competitorMentions && p.competitors.length > 0) {
    lines.push("", `Competitors: ${p.competitors.join(", ")}.`);
  }
  if (p.direction === "output" && p.checks.promptAdherence && p.systemPrompt) {
    lines.push(
      "",
      "The agent's instructions (for prompt_adherence):",
      '"""',
      p.systemPrompt,
      '"""',
    );
  }
  // The customer message and the instruction to use it travel together: a review procedure that
  // says "compare with the customer message" while no customer message was supplied is an invitation
  // to invent one.
  if (
    p.direction === "output" &&
    p.checks.answerRelevance &&
    p.customerMessage?.trim()
  ) {
    lines.push(
      "",
      "The customer message this reply must answer:",
      '"""',
      p.customerMessage.trim(),
      '"""',
      "",
      "For answer_relevance: a reply that gives MORE than was asked, or that continues an exchange" +
        " already under way, is still an answer. Flag it only when the customer's question is left" +
        " unanswered.",
    );
  }
  if (p.customPolicy.trim()) {
    lines.push("", `Additional policy: ${p.customPolicy.trim()}`);
  }
  if (p.generationPrompt?.trim()) {
    lines.push(
      "",
      "When writing `suggestedReply`, follow this guidance:",
      p.generationPrompt.trim(),
    );
  }
  lines.push(
    "",
    "Respond with ONLY a JSON object (no markdown, no prose) of the form:",
    '{"violated": boolean, "categories": string[], "rationale": string, "suggestedReply": string | null}',
    '`categories` lists the violated policy keys (e.g. "toxicity"). `rationale` is one short sentence. ' +
      "`suggestedReply` is a safe, polite replacement message in the SAME language as the analyzed text " +
      "(what the assistant could say instead, following the guidance above when present), or null. When " +
      'nothing is violated, set "violated" to false and "categories" to [].',
  );
  return lines.join("\n");
}
