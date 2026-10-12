// The `decisions` engine's half of an OBSERVE tick (observe/job.ts owns the rest: arming, fences, the
// window, the ceiling, the flow line). Two steps, kept apart so the tick can gate between them and
// log each: ask the provider, then turn the answers into tool calls by rule.

import { isDeepStrictEqual } from "node:util";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import {
  type StructuredToolInterface,
  ToolInputParsingException,
} from "@langchain/core/tools";
import { isEffectFreeTool } from "@/graph/tools/effect-free";
import {
  type CallReport,
  type FenceName,
  type FenceReport,
  withFenceReporter,
} from "@/graph/tools/fence-report";
import { AMBIGUOUS_MCP_NAME, isMcpArgumentRefusal } from "@/graph/tools/mcp";
import { sentNothing } from "@/modules/chatwoot/client";
import { prepareArgs } from "./arguments";
import {
  type DecisionQuestion,
  type DecisionsConfig,
  type DecisionTrigger,
  isNativeDecisionTool,
  ruleStateKey,
  triggerOf,
} from "./config";
import {
  DECISION_PROVIDER_REGISTRY,
  type DecisionAnswer,
  type DecisionResult,
} from "./providers";
import { type ConditionMiss, evaluateRules, type FiredAction } from "./rules";
import { argsForLog, type FillContext } from "./tool-args";

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
  // `decided`: decided and not run, only under `dryRun`. `ran`: the tool was invoked and returned.
  // `not_granted`: the agent does not have the tool (the operator grants it, as for the LLM path).
  // `failed`: the tool threw or was not called; `failure` says which way, never the tool's text:
  // `invalid_arguments`, `tool_error`, `missing_value` or `ambiguous_tool` (an MCP name two servers
  // may answer to). `over_budget`: the rules before it spent `limits.maxToolCalls`. `refused`: a
  // fence inside the tool refused the whole call (`fence` names it), so nothing was written; a call
  // refused only in part ran, with `fence` and `partial`.
  // `no_effect`: the tool could not write (the contact or card it targets is not there).
  outcome:
    | "decided"
    | "ran"
    | "not_granted"
    | "failed"
    | "over_budget"
    | "refused"
    | "no_effect";
  failure?: string;
  // A failed call that wrote something that stays (a handoff's note filed before its status change
  // threw): the rule latches as if it had run, so the next observation does not file it again.
  committed?: true;
  fence?: FenceName;
  partial?: true;
  // Later rules whose identical action this one is (rules.ts): the outcome is theirs too.
  merged?: number[];
  // A custom tool's arguments as resolved for the call, filled values as `argsForLog` gives them.
  args?: Record<string, unknown>;
  // `missing_value`: the arguments to be filled from a field the observation had no value for.
  missing?: string[];
}

// What the arguments a rule fills come from (./tool-args.ts), and whether the observe line may carry
// the filled values (`observability.logToolValues`).
export interface DecisionFill {
  context: FillContext;
  questions: readonly DecisionQuestion[];
  logValues: boolean;
}

// What the trigger state of this tick changes (decision_rule_states, by `ruleStateKey`): `latch`
// the rules that acted and must not act again while they hold (or ever, for `once`), `release` the
// `on_start` rules that did not hold, `undo` this tick's own latches written ahead for actions that
// wrote nothing or never started, `keep` every key of the block that ran, so a key no rule has any
// more (an edited or deleted rule) is dropped. `release` and the drop judge the state the tick read;
// `undo` judges only what the tick itself wrote.
export interface TriggerStateChange {
  latch: string[];
  release: string[];
  undo: string[];
  keep: string[];
}

// Kept current by `applyDecisions` as actions settle, for a caller whose call rejected (the
// deadline met a later action): what that caller releases, as in TriggerStateChange. A handler can
// still say it wrote nothing after the call was given up on, so `onChange` is called on every change.
export interface DecisionProgress {
  release?: string[];
  undo?: string[];
  onChange?: () => void;
}

// Writes, before an action is dispatched, the latches of the rules it answers for: a call the
// deadline ends while in flight may or may not have written, and a rule that might have acted is
// held rather than run twice. Throwing stops the tick before anything is dispatched; `false` says a
// newer observation owns the state now (trigger-state.ts), and the tick is withdrawn.
export type LatchAhead = (keys: string[]) => Promise<boolean>;

export interface DecisionTickReport {
  fired: FiredAction[];
  missed: { rule: number; miss: ConditionMiss }[];
  held: { rule: number; trigger: DecisionTrigger }[];
  actions: ActionReport[];
  triggerState: TriggerStateChange;
  // The observation was withdrawn before an action could run (agent off or detached, claim
  // superseded, reset, reopened): the caller ends the tick on the fence's own refusal.
  withdrawn: boolean;
}

// Runs what the rules fired through the SAME tool objects the LLM observer calls, with the tick's
// tool logger as callback, so a decision's write gets the tool's protections, flow line and label
// accounting. In rule order, one at a time, except what `together` groups (docs/decisions.md). The
// fence is asked before every action: not every tool asks on its own (`private_note` does not), and
// the provider call leaves time to withdraw. `dryRun` decides without writing (internal, for a
// caller that only shows the decisions). `latched` holds the keys of the rules that already acted in
// this conversation; a rule its trigger holds back does not act (docs/decisions.md, "When a rule acts").
export async function applyDecisions(
  config: { rules: DecisionsConfig["rules"] },
  answers: Record<string, DecisionAnswer>,
  tools: readonly StructuredToolInterface[],
  callbacks: Callbacks,
  signal: AbortSignal,
  stillWanted: () => Promise<boolean>,
  maxCalls: number,
  together: (action: FiredAction) => string | null = () => null,
  dryRun = false,
  latched: ReadonlySet<string> = new Set(),
  progress: DecisionProgress = {},
  latchAhead: LatchAhead = async () => true,
  fill: DecisionFill | null = null,
): Promise<DecisionTickReport> {
  const keys = config.rules.map(ruleStateKey);
  const triggers = config.rules.map(triggerOf);
  const { fired, missed, held } = evaluateRules(
    config.rules,
    answers,
    (rule) => triggers[rule] === "each_time" || !latched.has(keys[rule] ?? ""),
  );
  const withMerged = (r: ActionReport, f: FiredAction): ActionReport =>
    f.merged.length > 0 ? { ...r, merged: [...f.merged] } : r;
  // The arguments each fired action is called with: the fixed ones, and the filled ones resolved
  // for this observation. And how the line records them, for a custom tool.
  const callArgs = new Map<number, Record<string, unknown>>();
  const loggedArgs = new Map<number, Record<string, unknown>>();
  // One slot per fired action, filled in whatever order the actions settle and read in rule order.
  const slots: (ActionReport | undefined)[] = fired.map(() => undefined);
  // The fired actions whose tool said it wrote something that stays (a handoff's note before its
  // status change threw).
  const committed = new Set<number>();
  // The latch keys of a fired action: its rule's and its merged rules', `each_time` ones left out.
  const latchKeys = (at: number): string[] => {
    const f = fired[at];
    if (!f) return [];
    return [f.rule, ...f.merged].flatMap((rule) => {
      const key = keys[rule];
      return key && triggers[rule] !== "each_time" ? [key] : [];
    });
  };
  // Latched ahead of dispatch, by fired action (LatchAhead).
  const ahead = new Map<number, string[]>();
  // What is known to have written nothing. A call that threw may have written before it did, so it
  // counts only when it never reached its handler (`invalid_arguments`) or the client proved the
  // write never left (`quiet`).
  const leftNothing = (a: ActionReport, at: number) =>
    a.outcome === "failed"
      ? a.failure === "invalid_arguments" ||
        a.failure === "missing_value" ||
        a.failure === "ambiguous_tool" ||
        (quiet.has(at) && !committed.has(at))
      : a.outcome !== "ran";
  // Latched ahead for an action that was then not dispatched.
  const dropped = new Set<string>();
  // The latches written ahead whose action settled without writing anything, or never started:
  // released.
  const undone = (): string[] => [
    ...[...ahead].flatMap(([at, k]) => {
      const a = slots[at];
      // A call given up on at the deadline has no slot, and counts only once its tool said it wrote
      // nothing.
      const nothing = a
        ? leftNothing(a, at)
        : quiet.has(at) && !committed.has(at);
      return nothing ? k : [];
    }),
    ...dropped,
  ];
  // The fired actions whose tool said it wrote nothing (a whole refusal included).
  const quiet = new Set<number>();
  const missedReleases = (): string[] =>
    missed.flatMap(({ rule }) =>
      triggers[rule] === "on_start" && keys[rule] ? [keys[rule]] : [],
    );
  const settled = () => {
    progress.release = missedReleases();
    progress.undo = [...new Set(undone())];
    progress.onChange?.();
  };
  // Before anything is awaited: a deadline that ends the tick with nothing dispatched still owes the
  // releases of the `on_start` rules that did not hold.
  settled();
  const toRun: { at: number; tool: StructuredToolInterface }[] = [];
  // Every call the tick dispatches counts, a dry run's included, so it reports what a run would.
  let calls = 0;
  // The calls this tick makes, by fired action, for the merge below.
  const sent: { at: number; tool: string; args: Record<string, unknown> }[] =
    [];
  for (const [at, f] of fired.entries()) {
    // The grant is checked first, so a dry run shows the same missing grant a run would hit.
    const tool = tools.find((t) => t.name === f.tool);
    if (!tool) {
      slots[at] = { rule: f.rule, tool: f.tool, outcome: "not_granted" };
      continue;
    }
    // An MCP name two servers may answer to, by the order the assembly reads them in: called, it
    // may reach the other server's tool, so it is not called (ambiguousMcpNames).
    if ((tool as { [AMBIGUOUS_MCP_NAME]?: true })[AMBIGUOUS_MCP_NAME]) {
      slots[at] = {
        rule: f.rule,
        tool: f.tool,
        outcome: "failed",
        failure: "ambiguous_tool",
      };
      continue;
    }
    // THE ARGUMENTS FIRST (./arguments.ts): resolved, fitted and checked against the tool's
    // original schema before anything is charged or latched. One that does not fit is not called, so
    // it spends no call of the budget and holds no latch.
    const prepared = await prepareArgs(
      tool,
      f,
      fill
        ? { context: fill.context, answers, questions: fill.questions }
        : null,
    );
    const args = prepared.args;
    if (!isNativeDecisionTool(f.tool)) {
      loggedArgs.set(
        at,
        argsForLog(args, f.fill ?? {}, fill?.logValues ?? false),
      );
    }
    if (!prepared.ok) {
      slots[at] = {
        rule: f.rule,
        tool: f.tool,
        outcome: "failed",
        failure: prepared.failure,
        ...(prepared.missing ? { missing: prepared.missing } : {}),
      };
      continue;
    }
    // Two rules written differently can call with the same arguments (one fixed, one filled with the
    // same value): one call answers for both, as rules.ts merges identical actions as written.
    const same = sent.find(
      (x) => x.tool === f.tool && isDeepStrictEqual(x.args, args),
    );
    const into = same ? fired[same.at] : undefined;
    if (into) {
      loggedArgs.delete(at);
      into.merged.push(f.rule, ...f.merged);
      continue;
    }
    if (calls >= maxCalls) {
      slots[at] = { rule: f.rule, tool: f.tool, outcome: "over_budget" };
      continue;
    }
    callArgs.set(at, args);
    calls += 1;
    sent.push({ at, tool: f.tool, args });
    if (dryRun) {
      slots[at] = { rule: f.rule, tool: f.tool, outcome: "decided" };
      continue;
    }
    toRun.push({ at, tool });
  }
  const reported = (upTo = fired.length): ActionReport[] =>
    slots.flatMap((a, at) => {
      const f = fired[at];
      if (a === undefined || f === undefined || at >= upTo) return [];
      const logged = loggedArgs.get(at);
      return [withMerged(logged ? { ...a, args: logged } : a, f)];
    });
  // A rule latches when its action RAN (in full or in part), or failed after writing something that
  // stays: one that could not run, wrote nothing, or that a fence refused, acts again on the next
  // observation in which it holds, so a grant or a contact that arrives later is not met by a rule
  // that already counts itself done. Its latch was written ahead; this releases the ones that left
  // nothing. A dry run writes nothing.
  const triggerState = (): TriggerStateChange => {
    const latch = new Set<string>();
    if (!dryRun) {
      for (const [at, a] of slots.entries()) {
        if (a && !leftNothing(a, at))
          for (const k of latchKeys(at)) latch.add(k);
      }
    }
    return {
      latch: [...latch],
      release: missedReleases(),
      undo: [...new Set(undone())],
      keep: [...new Set(keys)],
    };
  };
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
    for (let j = end; key !== null && j < toRun.length; j++) {
      const next = toRun[j];
      if (!next) break;
      if (keyOf(next) !== key) break;
      end = j + 1;
    }
    const group = toRun.slice(i, end);
    const start = i;
    i = end;
    const running: Promise<void>[] = [];
    let withdrawnAt: number | null = null;
    let cancelled: { err: unknown } | null = null;
    let fenceError: { err: unknown } | null = null;
    // Every member's fence first, then the dispatch in one go: a fence is database reads, and a
    // member dispatched while the next one's fence is still being asked would have its write out
    // before the others could join it.
    // The group's latches go out before its fences are asked (LatchAhead), so a withdrawal that lands
    // while they are written is seen by the fence after; a write that fails stops the group like a
    // fence that could not answer.
    if (!dryRun) {
      const due = group.map((m) => [m.at, latchKeys(m.at)] as const);
      try {
        // A tick whose deadline has passed starts nothing more, its latches included.
        signal.throwIfAborted();
        const all = due.flatMap(([, k]) => k);
        if (all.length > 0 && !(await latchAhead(all))) {
          withdrawnAt = head.at;
        }
        for (const [at, k] of withdrawnAt === null ? due : []) {
          if (k.length === 0) continue;
          ahead.set(at, k);
          for (const key of k) dropped.delete(key);
        }
      } catch (err) {
        fenceError = { err };
      }
    }
    const admitted: typeof group = [];
    for (const member of fenceError === null && withdrawnAt === null
      ? group
      : []) {
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
    // Asked again now that the fences ran: they read the live settings, and a grouping those no
    // longer allow falls back to the head alone, with the rest admitted after it has written.
    if (admitted.length > 1 && keyOf(head) !== key) {
      admitted.length = 1;
      i = start + 1;
    }
    // Latched ahead and not dispatched now (stopped, or left for after the head): released, unless
    // a later run latches it again.
    const dispatching = new Set(
      fenceError === null && withdrawnAt === null
        ? admitted.map((m) => m.at)
        : [],
    );
    for (const member of group) {
      const k = ahead.get(member.at);
      if (!k || dispatching.has(member.at)) continue;
      ahead.delete(member.at);
      for (const key of k) dropped.add(key);
    }
    settled();
    // A refusal or a deadline met while asking stops the whole group, the members already admitted
    // included: none of them has started, and the answer that stopped the last one is the newest.
    if (fenceError === null && withdrawnAt === null) {
      for (const member of admitted) {
        const f = fired[member.at];
        if (!f) continue;
        const reports: CallReport[] = [];
        running.push(
          member.tool
            .invoke(
              // A custom tool is called as a tool call, so a failure it answers with (an HTTP 503,
              // a code tool's sandbox error) comes back as an error result instead of plain text
              // (failure.ts), and is read as one below.
              isNativeDecisionTool(f.tool)
                ? (callArgs.get(member.at) ?? f.args)
                : {
                    type: "tool_call" as const,
                    id: `decision-${f.rule}`,
                    name: f.tool,
                    args: callArgs.get(member.at) ?? f.args,
                  },
              // Without the tick's signal: given it, the call would reject the moment the deadline
              // passes while its handler goes on, and what the handler then did would be lost. The
              // handlers keep their own deadline (the Chatwoot client's).
              withFenceReporter({ callbacks }, (r) => {
                reports.push(r);
                if ("committed" in r) committed.add(member.at);
                // Wrote nothing: said no to, whole, by a fence, or nothing it could write.
                if ("noEffect" in r || ("fence" in r && !r.partial)) {
                  quiet.add(member.at);
                  settled();
                }
              }),
            )
            .then(
              (result: unknown) => {
                if (
                  (result as { status?: unknown } | null)?.status === "error"
                ) {
                  // Answered with a failure after it ran: it may have reached the other side,
                  // unless the tool leaves nothing behind by construction (a code tool).
                  if (isEffectFreeTool(member.tool)) {
                    quiet.add(member.at);
                  }
                  slots[member.at] = {
                    rule: f.rule,
                    tool: f.tool,
                    outcome: reports.some((r) => "noEffect" in r)
                      ? "no_effect"
                      : "failed",
                    ...(reports.some((r) => "noEffect" in r)
                      ? {}
                      : { failure: "tool_error" }),
                  };
                  settled();
                  return;
                }
                const fences = reports.filter(
                  (r): r is FenceReport => "fence" in r,
                );
                const whole = fences.find((r) => !r.partial);
                const part = fences.find((r) => r.partial);
                slots[member.at] = whole
                  ? {
                      rule: f.rule,
                      tool: f.tool,
                      outcome: "refused",
                      fence: whole.fence,
                    }
                  : // Before the partial fence: a call withdrawn after its fence was asked wrote
                    // neither the part the fence allowed nor the rest.
                    reports.some((r) => "noEffect" in r)
                    ? { rule: f.rule, tool: f.tool, outcome: "no_effect" }
                    : part
                      ? {
                          rule: f.rule,
                          tool: f.tool,
                          outcome: "ran",
                          fence: part.fence,
                          partial: true,
                        }
                      : { rule: f.rule, tool: f.tool, outcome: "ran" };
                settled();
              },
              (err: unknown) => {
                // Refused before the handler ran (its arguments), or an error the Chatwoot client says
                // sent nothing (sentNothing: a read, or a refusal before dialing). With no write
                // reported before it (`committed`), the call wrote nothing.
                if (
                  err instanceof ToolInputParsingException ||
                  sentNothing(err) ||
                  isEffectFreeTool(member.tool)
                ) {
                  quiet.add(member.at);
                }
                // Cancellation ends the tick, it is not one tool's failure: the caller owns the deadline.
                if (signal.aborted) {
                  cancelled ??= { err };
                  settled();
                  return;
                }
                // A refusal the tool already said stands, as on success: what failed after it (a
                // write shared with other calls) was not this call's.
                const whole = reports.find(
                  (r): r is FenceReport => "fence" in r && !r.partial,
                );
                if (whole) {
                  slots[member.at] = {
                    rule: f.rule,
                    tool: f.tool,
                    outcome: "refused",
                    fence: whole.fence,
                  };
                  settled();
                  return;
                }
                slots[member.at] = {
                  rule: f.rule,
                  tool: f.tool,
                  outcome: "failed",
                  failure:
                    err instanceof ToolInputParsingException ||
                    isMcpArgumentRefusal(err)
                      ? "invalid_arguments"
                      : "tool_error",
                  ...(committed.has(member.at)
                    ? { committed: true as const }
                    : {}),
                };
                settled();
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
      const actions = reported(head.at);
      return {
        fired,
        missed,
        held,
        actions,
        triggerState: triggerState(),
        withdrawn: true,
      };
    }
  }
  const actions = reported();
  return {
    fired,
    missed,
    held,
    actions,
    triggerState: triggerState(),
    withdrawn: false,
  };
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
