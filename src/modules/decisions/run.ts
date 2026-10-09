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
  // (the rule's args do not fit the tool's schema) or `tool_error`. `over_budget`: the agent's
  // `limits.maxToolCalls` was spent by the rules before it, as the graph caps a model's turn.
  outcome: "shadow" | "ran" | "not_granted" | "failed" | "over_budget";
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
// accounting. Shadow invokes nothing. In rule order, one action at a time, except for the actions
// `together` groups (docs/decisions.md, How the actions reach Chatwoot). The observation's fence is
// asked before every action, as the graph asks it before every hop: not every tool asks on its own
// (`private_note` does not), and the provider call leaves time to withdraw.
export async function applyDecisions(
  config: { rules: DecisionsConfig["rules"]; apply: DecisionApply },
  answers: Record<string, DecisionAnswer>,
  tools: readonly StructuredToolInterface[],
  callbacks: Callbacks,
  signal: AbortSignal,
  stillWanted: () => Promise<boolean>,
  maxCalls: number,
  together: (action: FiredAction) => string | null = () => null,
): Promise<DecisionTickReport> {
  const { fired, missed } = evaluateRules(config.rules, answers);
  // One slot per fired action, filled in whatever order the actions settle and read in rule order.
  const slots: (ActionReport | undefined)[] = fired.map(() => undefined);
  const toRun: { at: number; tool: StructuredToolInterface }[] = [];
  // Every call the tick dispatches counts, shadow's included, so shadow reports what enforce would.
  let calls = 0;
  for (const [at, f] of fired.entries()) {
    // The grant is checked first, so shadow shows the same missing grant enforce would hit.
    const tool = tools.find((t) => t.name === f.tool);
    if (!tool) {
      slots[at] = { rule: f.rule, tool: f.tool, outcome: "not_granted" };
      continue;
    }
    if (calls >= maxCalls) {
      slots[at] = { rule: f.rule, tool: f.tool, outcome: "over_budget" };
      continue;
    }
    calls += 1;
    if (config.apply === "shadow") {
      // The arguments are asked of the tool's own schema without running it, so shadow shows the
      // `invalid_arguments` enforce would hit. The watcher's writes are native tools, schema'd in zod.
      const fits =
        !isInteropZodSchema(tool.schema) ||
        (await interopSafeParseAsync(tool.schema, f.args)).success;
      slots[at] = fits
        ? { rule: f.rule, tool: f.tool, outcome: "shadow" }
        : {
            rule: f.rule,
            tool: f.tool,
            outcome: "failed",
            failure: "invalid_arguments",
          };
      continue;
    }
    toRun.push({ at, tool });
  }
  const reported = (upTo = fired.length): ActionReport[] =>
    slots.filter((a, at): a is ActionReport => a !== undefined && at < upTo);
  // A group is a RUN of consecutive actions whose tool commits calls that arrive together as one
  // write: dispatched together, each after its own fence, and awaited as one. Only neighbours are
  // grouped, so no action runs ahead of one the rules put before it.
  const keyOf = (r: { at: number }): string | null => {
    const action = fired[r.at];
    return action ? together(action) : null;
  };
  for (let i = 0; i < toRun.length; ) {
    const head = toRun[i];
    if (!head) break;
    const key = keyOf(head);
    let end = i + 1;
    while (key !== null && end < toRun.length) {
      const next = toRun[end];
      if (!next || keyOf(next) !== key) break;
      end += 1;
    }
    const group = toRun.slice(i, end);
    i = end;
    const running: Promise<void>[] = [];
    let withdrawnAt: number | null = null;
    let cancelled: { err: unknown } | null = null;
    let fenceError: { err: unknown } | null = null;
    // Every member's fence first, then the dispatch in one go: a fence is database reads, and a
    // member dispatched while the next one's fence is still being asked would have its write out
    // before the others could join it.
    const admitted: typeof group = [];
    for (const member of group) {
      try {
        signal.throwIfAborted();
        if (!(await stillWanted())) {
          withdrawnAt = member.at;
          break;
        }
        // Again after the fence: its reads take time, and a deadline that fired during them has
        // already ended the tick, so nothing may start behind it.
        signal.throwIfAborted();
      } catch (err) {
        fenceError = { err };
        break;
      }
      admitted.push(member);
    }
    // A refusal or a deadline met while asking stops the whole group, the members already admitted
    // included: none of them has started, and the answer that stopped the last one is the newest.
    if (fenceError === null && withdrawnAt === null) {
      for (const member of admitted) {
        const f = fired[member.at];
        if (!f) continue;
        running.push(
          member.tool.invoke(f.args, { callbacks, signal }).then(
            () => {
              slots[member.at] = { rule: f.rule, tool: f.tool, outcome: "ran" };
            },
            (err: unknown) => {
              // Cancellation ends the tick, it is not one tool's failure: the caller owns the deadline.
              if (signal.aborted) {
                cancelled ??= { err };
                return;
              }
              slots[member.at] = {
                rule: f.rule,
                tool: f.tool,
                outcome: "failed",
                failure:
                  err instanceof ToolInputParsingException
                    ? "invalid_arguments"
                    : "tool_error",
              };
            },
          ),
        );
      }
    }
    // What was dispatched is awaited whatever stopped the group, so nothing is left writing behind
    // the tick's own ending.
    await Promise.all(running);
    if (fenceError !== null) throw fenceError.err;
    if (cancelled !== null) throw (cancelled as { err: unknown }).err;
    if (withdrawnAt !== null) {
      return {
        fired,
        missed,
        actions: reported(head.at),
        withdrawn: true,
      };
    }
  }
  return { fired, missed, actions: reported(), withdrawn: false };
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
