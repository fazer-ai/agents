// The `decisions` engine's half of an OBSERVE tick (observe/job.ts owns the rest: arming, fences, the
// window, the ceiling, the flow line). Two steps, kept apart so the tick can gate between them and
// log each: ask the provider, then turn the answers into tool calls by rule.

import type { Callbacks } from "@langchain/core/callbacks/manager";
import {
  type StructuredToolInterface,
  ToolInputParsingException,
} from "@langchain/core/tools";
import {
  interopSafeParseAsync,
  isInteropZodSchema,
} from "@langchain/core/utils/types";
import type { DecisionApply, DecisionsConfig } from "./config";
import {
  DECISION_PROVIDER_REGISTRY,
  type DecisionAnswer,
  type DecisionResult,
} from "./providers";
import { type ConditionMiss, evaluateRules, type FiredAction } from "./rules";

export async function askProvider(
  config: DecisionsConfig,
  req: {
    input: string;
    apiKey: string;
    baseURL: string | null;
    fetchImpl?: typeof fetch;
    signal: AbortSignal;
  },
): Promise<DecisionResult> {
  return DECISION_PROVIDER_REGISTRY[config.provider].decide({
    input: req.input,
    questions: config.questions,
    model: config.model,
    apiKey: req.apiKey,
    baseURL: req.baseURL,
    fetchImpl: req.fetchImpl ?? fetch,
    signal: req.signal,
  });
}

export interface ActionReport {
  rule: number;
  tool: string;
  // `shadow`: decided and not run. `ran`: the tool was invoked and returned. `not_granted`: the agent
  // does not have the tool, so the rule cannot act (the operator grants it, as for the LLM path).
  // `failed`: the tool threw; `failure` says which way, never the tool's text: `invalid_arguments`
  // (the rule's args do not fit the tool's schema) or `tool_error`.
  outcome: "shadow" | "ran" | "not_granted" | "failed";
  failure?: string;
}

export interface DecisionTickReport {
  fired: FiredAction[];
  missed: { rule: number; miss: ConditionMiss }[];
  actions: ActionReport[];
  // The observation was withdrawn before an action could run (agent off or detached, claim
  // superseded, reset, reopened): the caller ends the tick on the fence's own refusal.
  withdrawn: boolean;
}

// Runs what the rules fired through the SAME tool objects the LLM observer calls, with the tick's
// tool logger as callback, so a decision's write gets the tool's protections, flow line and label
// accounting. Shadow invokes nothing. Sequential, in rule order, so the log's order is the real one.
//
// The observation's fence is asked before every action, as the graph asks it before every hop: not
// every tool asks on its own (`private_note` does not), and the provider call leaves time to withdraw.
export async function applyDecisions(
  config: { rules: DecisionsConfig["rules"]; apply: DecisionApply },
  answers: Record<string, DecisionAnswer>,
  tools: readonly StructuredToolInterface[],
  callbacks: Callbacks,
  signal: AbortSignal,
  stillWanted: () => Promise<boolean>,
): Promise<DecisionTickReport> {
  const { fired, missed } = evaluateRules(config.rules, answers);
  const actions: ActionReport[] = [];
  for (const f of fired) {
    // The grant is checked first, so shadow shows the same missing grant enforce would hit.
    const tool = tools.find((t) => t.name === f.tool);
    if (!tool) {
      actions.push({ rule: f.rule, tool: f.tool, outcome: "not_granted" });
      continue;
    }
    if (config.apply === "shadow") {
      // The arguments are asked of the tool's own schema without running it, so shadow shows the
      // `invalid_arguments` enforce would hit. The watcher's writes are native tools, schema'd in zod.
      const fits =
        !isInteropZodSchema(tool.schema) ||
        (await interopSafeParseAsync(tool.schema, f.args)).success;
      actions.push(
        fits
          ? { rule: f.rule, tool: f.tool, outcome: "shadow" }
          : {
              rule: f.rule,
              tool: f.tool,
              outcome: "failed",
              failure: "invalid_arguments",
            },
      );
      continue;
    }
    signal.throwIfAborted();
    if (!(await stillWanted())) {
      return { fired, missed, actions, withdrawn: true };
    }
    try {
      await tool.invoke(f.args, { callbacks, signal });
      actions.push({ rule: f.rule, tool: f.tool, outcome: "ran" });
    } catch (err) {
      // Cancellation ends the tick, it is not one tool's failure: the caller owns the deadline.
      if (signal.aborted) throw err;
      actions.push({
        rule: f.rule,
        tool: f.tool,
        outcome: "failed",
        failure:
          err instanceof ToolInputParsingException
            ? "invalid_arguments"
            : "tool_error",
      });
    }
  }
  return { fired, missed, actions, withdrawn: false };
}

// The answers as the flow line carries them: numbers and the operator's own option names, never the
// conversation (the provider sees the text, the log does not).
export function answersForLog(
  answers: Record<string, DecisionAnswer>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, a] of Object.entries(answers)) {
    out[name] =
      a.type === "yes_no"
        ? { type: a.type, probability: a.probability }
        : a.type === "refusal"
          ? { type: a.type }
          : a.type === "choice"
            ? {
                type: a.type,
                choice: a.choice,
                confidence: a.confidence,
                probabilities: a.probabilities,
              }
            : {
                type: a.type,
                score: a.score,
                confidence: a.confidence,
                probabilities: a.probabilities,
              };
  }
  return out;
}
