import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import logger from "@/api/lib/logger";
import { runModelCall } from "@/graph/model-limit";
import {
  buildGuardrailSystemPrompt,
  type GuardrailPromptParams,
} from "./prompts";

const ANALYZE_TIMEOUT_MS = 15_000;

export interface GuardrailVerdict {
  violated: boolean;
  categories: string[];
  rationale: string;
  // A safe replacement reply the model proposed (used when the direction's action is "generated").
  suggestedReply: string | null;
  // Set when the analysis could not be performed (model error, timeout, unusable output). The
  // verdict is still non-violating — fail-open is the policy — but the caller must be able to tell
  // "screened and approved" from "never screened", which are the same value without this.
  error?: string;
}

const CLEAN: GuardrailVerdict = {
  violated: false,
  categories: [],
  rationale: "",
  suggestedReply: null,
};

function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in c
            ? String((c as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

const unanalyzed = (error: string): GuardrailVerdict => ({ ...CLEAN, error });

// Extract the first balanced JSON object from a model response (tolerates ```json fences / prose).
function parseVerdict(raw: string): GuardrailVerdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start)
    return unanalyzed("no JSON object in response");
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    if (obj.violated !== true) return CLEAN;
    const categories = Array.isArray(obj.categories)
      ? obj.categories.filter((c): c is string => typeof c === "string")
      : [];
    return {
      violated: true,
      categories,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
      suggestedReply:
        typeof obj.suggestedReply === "string" && obj.suggestedReply.trim()
          ? obj.suggestedReply.trim()
          : null,
    };
  } catch {
    return unanalyzed("unparseable verdict JSON");
  }
}

// Run the guardrails agent over `text`. Best-effort and FAIL-OPEN: any model/timeout/parse error
// returns a non-violating verdict, so a transient failure never blocks the conversation (the trip is
// logged; the operator monitors via the flowlog). Mirrors llmNormalizeForSpeech's shape.
export async function analyzeGuardrail(
  model: BaseChatModel,
  params: GuardrailPromptParams & { text: string },
): Promise<GuardrailVerdict> {
  const system = buildGuardrailSystemPrompt(params);
  try {
    const res = await runModelCall(() =>
      model.invoke([new SystemMessage(system), new HumanMessage(params.text)], {
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      }),
    );
    return parseVerdict(messageText(res.content).trim());
  } catch (err) {
    logger.warn(
      { err },
      "guardrails analysis failed (fail-open, message not blocked)",
    );
    return unanalyzed(err instanceof Error ? err.message : String(err));
  }
}
