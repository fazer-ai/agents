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

// Every TOP-LEVEL balanced object in the response, in order. Nested objects are not returned (they
// belong to their parent), braces inside strings do not count, and \" does not close one.
function topLevelObjects(raw: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      out.push(raw.slice(start, i + 1));
    }
  }
  return out;
}

// The response must contain EXACTLY ONE verdict, and anything else is "we did not get an answer".
// One rule, because three rounds of review found three ways to read a non-answer as an approval, and
// they were all the same mistake: for a moderation feature, ambiguity has to fail towards "unknown",
// never towards "clean". What it settles, in order of how they were found:
//
//   * a verdict followed by prose that carries braces ("the policy {toxicity} applies") — the prose
//     is not a parseable verdict, so it drops out and the real one is still found;
//   * `{}` or `{"violated": "true"}` — parseable and unusable, so neither of them is a candidate;
//   * a self-correction (`{"violated": true}` … `Correction: {"violated": false}`) — two candidates,
//     and picking either one is a guess about which the model meant.
//
// The alternative for the last case, taking the last object, is a guess in the other direction: the
// same shape would silently approve a real violation whenever the trailing object is the stale one.
function parseVerdict(raw: string): GuardrailVerdict {
  const candidates: Record<string, unknown>[] = [];
  for (const slice of topLevelObjects(raw)) {
    try {
      const obj = JSON.parse(slice) as Record<string, unknown>;
      if (typeof obj.violated === "boolean") candidates.push(obj);
    } catch {
      // Not a verdict; prose and half-written objects are expected here.
    }
  }
  if (candidates.length === 0)
    return unanalyzed("no usable verdict in response");
  if (candidates.length > 1) {
    return unanalyzed(`${candidates.length} conflicting verdicts in response`);
  }
  const obj = candidates[0] as Record<string, unknown>;
  if (obj.violated === false) return CLEAN;
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
