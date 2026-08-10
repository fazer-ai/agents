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
  // The customer message the output reply is answering. Without it, prompt adherence can check
  // persona and policy but cannot reliably detect an irrelevant or incomplete answer.
  customerMessage?: string;
  // Steering for the generated replacement reply (action === "generated"); empty â†’ generic safe reply.
  generationPrompt?: string;
}

const CHECK_DEFINITIONS: Record<keyof GuardrailChecks, string> = {
  toxicity:
    "toxicity â€” harassment, hate speech, insults, or abusive/threatening language.",
  unsafeContent:
    "unsafe_content â€” sexual content, graphic violence, instructions for illegal or dangerous acts, or self-harm.",
  competitorMentions:
    "competitor_mention â€” any mention, recommendation, or promotion of a competitor from the list below.",
  promptAdherence:
    "prompt_adherence â€” the assistant reply goes outside the scope, persona, or policy set by the agent's instructions (off-topic, contradicts those instructions, or leaks internal details).",
};

export function buildGuardrailSystemPrompt(p: GuardrailPromptParams): string {
  const subject =
    p.direction === "input"
      ? "a message a CUSTOMER sent to a support assistant"
      : "a REPLY a support assistant is about to send to a customer";
  // promptAdherence only applies to the output direction.
  const active = (Object.keys(p.checks) as (keyof GuardrailChecks)[]).filter(
    (k) => p.checks[k] && (k !== "promptAdherence" || p.direction === "output"),
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
  if (
    p.direction === "output" &&
    p.checks.promptAdherence &&
    p.customerMessage?.trim()
  ) {
    lines.push(
      "",
      "The customer message this reply must answer:",
      '"""',
      p.customerMessage.trim(),
      '"""',
    );
  }
  if (p.direction === "output" && p.checks.promptAdherence) {
    lines.push(
      "",
      "Prompt-adherence review procedure:",
      "- Compare the reply with both the customer message and the agent's instructions.",
      "- Treat explicit MUST, ALWAYS, NEVER, REQUIRED, EXACTLY, and equivalent instructions in any language as testable requirements, not suggestions.",
      "- Mark prompt_adherence violated when the reply omits a required element, includes forbidden wording or action, answers a different question, or claims support that the supplied context does not establish.",
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

