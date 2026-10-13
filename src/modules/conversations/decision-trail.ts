import {
  type DecisionOption,
  type DecisionsConfig,
  decisionsFingerprint,
  readDecisionsConfig,
  triggerOf,
} from "@/modules/decisions/config";
import { readMonitoringConfig } from "@/modules/observe/settings";

// A decision tick of a "Questions and rules" observer, as the conversation page draws it (agents#1401).
// Read off the `observe` line the engine already writes (observe/job.ts, docs/decisions.md): every
// answer with its probabilities, and what became of each rule. The line holds option names and numbers
// only, never the conversation's text, so it is shown whatever `observability.logToolValues` says.

// What the line stored, passed through as stored: the screen reads the same fields the line has, and a
// field this build does not know is not dropped on the way.
export interface DecisionTick {
  // `decided`: the classifier answered and the rules ran. `failed`: the tick did not finish, or could
  // not start for a reason only the operator can fix (a warn or error line). `skipped`: the tick had
  // nothing to do (no customer message yet, a reopened conversation), which nobody needs to fix.
  outcome: "decided" | "failed" | "skipped";
  // The observer that ran the tick, so the screen compares a tick with the previous one of the
  // same agent (two observers can watch one inbox).
  agentId: string | null;
  provider: string | null;
  model: string | null;
  // The model the provider says answered (TypeSafe resolves `jev-latest` to a version).
  modelVersion: string | null;
  reason: string | null;
  messagesRead: number | null;
  // Why a tick was skipped or failed, as the line names it: `skipped` (decisions_config_invalid, ...),
  // `failed` (decision_call, decision_actions, ...), the provider `failure` and the config `problem`.
  skipped: string | null;
  failed: string | null;
  failure: string | null;
  problem: string | null;
  // Keyed by question name; absent on a tick that never asked.
  answers: Record<string, unknown> | null;
  actions: unknown[];
  notFired: unknown[];
  held: unknown[];
  // What the tick's label writes changed, per write (graph/tools/label-writes.ts): counts, and the
  // titles only when the agent declares a list. Empty on a tick that wrote no label, and on a line
  // written before the field existed.
  labels: unknown[];
  // The questions and rules of the block the line ran, from the agent's current settings, ONLY when
  // the line's `block` mark is the current block's: an edited block would pair an old answer with a
  // new option's text, or a rule index with another rule. Null otherwise, and the screen then shows
  // what the line stored and nothing else.
  block: DecisionTickBlock | null;
}

// What the screen needs of a question: its name, type and the options or levels with their
// descriptions. Never its `instructions`, the classifier prompt the administrator wrote: reading a
// conversation does not need the agent's configuration, which only an admin may read.
export type DecisionTickQuestion =
  | { name: string; type: "yes_no" }
  | { name: string; type: "choice"; options: DecisionOption[] }
  | { name: string; type: "score"; levels: DecisionOption[] };

export interface DecisionTickBlock {
  questions: DecisionTickQuestion[];
  rules: {
    when: DecisionsConfig["rules"][number]["when"];
    tool: string;
    trigger: ReturnType<typeof triggerOf>;
  }[];
}

const bag = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// The current block of each agent, with its mark, so a line is matched against it once per agent.
export interface CurrentBlock {
  mark: string;
  block: DecisionTickBlock;
}

export function currentBlockOf(settings: unknown): CurrentBlock | null {
  const mon = readMonitoringConfig(settings);
  const read = readDecisionsConfig({ decisions: mon.decisions });
  if (!read.ok) return null;
  return {
    mark: decisionsFingerprint(read.config),
    block: {
      questions: read.config.questions.map(
        (q): DecisionTickQuestion =>
          q.type === "choice"
            ? { name: q.name, type: q.type, options: q.options }
            : q.type === "score"
              ? { name: q.name, type: q.type, levels: q.levels }
              : { name: q.name, type: q.type },
      ),
      rules: read.config.rules.map((r) => ({
        when: r.when,
        tool: r.action.tool,
        trigger: triggerOf(r),
      })),
    },
  };
}

// What the marker reads of an action: which rule, which tool and what became of it. `args` and
// `missing` only under the agent's `observability.logToolValues`, the switch that already decides
// whether the trail's tool markers carry values: a rule's fixed arguments are the administrator's
// payload, written on the line whatever the switch says, and reading a conversation does not open
// the agent's configuration.
const ACTION_FIELDS = [
  "rule",
  "tool",
  "outcome",
  "failure",
  "error",
  "fence",
  "partial",
  "committed",
  "merged",
] as const;

function actionOutcome(raw: unknown, logValues: boolean): unknown {
  const a = bag(raw);
  if (!a) return raw;
  if (logValues) return a;
  const out: Record<string, unknown> = {};
  for (const k of ACTION_FIELDS) if (k in a) out[k] = a[k];
  return out;
}

// Null when the line is not a decisions tick this screen can draw: another engine's line, or one whose
// answers are not an object (a line this build did not write).
export function decisionTickOf(
  line: {
    agentId: bigint | null;
    status: string | null;
    level: string;
    provider: string | null;
    model: string | null;
    detail: unknown;
  },
  current: CurrentBlock | null,
  // The agent's `observability.logToolValues`, read now: off (the default) keeps the actions'
  // arguments off the screen.
  logValues = false,
): DecisionTick | null {
  const d = bag(line.detail);
  if (d?.engine !== "decisions") return null;
  const answers = d.answers === undefined ? null : bag(d.answers);
  if (d.answers !== undefined && answers === null) return null;
  const outcome: DecisionTick["outcome"] =
    line.status === "ok"
      ? "decided"
      : line.status === "skipped" && line.level === "info"
        ? "skipped"
        : "failed";
  const mark = str(d.block);
  return {
    outcome,
    agentId: line.agentId === null ? null : String(line.agentId),
    provider: line.provider,
    model: line.model,
    modelVersion: str(d.modelVersion),
    reason: str(d.reason),
    messagesRead: num(d.messagesRead),
    skipped: str(d.skipped),
    failed: str(d.failed),
    failure: str(d.failure),
    problem: str(d.problem),
    answers,
    actions: list(d.actions).map((a) => actionOutcome(a, logValues)),
    notFired: list(d.notFired),
    held: list(d.held),
    labels: list(d.labels),
    block:
      current !== null && mark !== null && mark === current.mark
        ? current.block
        : null,
  };
}
