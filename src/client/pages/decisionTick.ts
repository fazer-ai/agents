import type { TrailEntry } from "./conversationTimeline";

// What the conversation page draws for one decision tick of a "Questions and rules" observer
// (agents#1401): the questions with their answers and the rules with their outcomes, read off the
// tick the trail carries (modules/conversations/decision-trail.ts). Pure, so it is tested without the
// page. The tick holds what the line stored; a field this reads defensively is one an older or newer
// build may write differently.

export type DecisionTickView = NonNullable<TrailEntry["decision"]>;
type Block = NonNullable<DecisionTickView["block"]>;

const bag = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export interface ProbabilityRow {
  value: string;
  // From the agent's settings, only when the tick ran the block shown (null otherwise).
  description: string | null;
  probability: number | null;
  chosen: boolean;
}

export type QuestionView =
  | { name: string; kind: "unanswered" }
  | { name: string; kind: "refusal" }
  | {
      name: string;
      kind: "yes_no";
      probability: number;
      // The rules that read this question, with the probability each one asks for (block only).
      thresholds: { rule: number; minProbability: number }[];
    }
  | {
      name: string;
      kind: "choice";
      choice: string | null;
      confidence: number | null;
      rows: ProbabilityRow[];
      closeCall: CloseCall | null;
    }
  | {
      name: string;
      kind: "score";
      score: number;
      // The nearest level, as the rules read it (rules.ts): its index and, when known, its name.
      level: number;
      levelName: string | null;
      confidence: number | null;
      rows: ProbabilityRow[];
      closeCall: CloseCall | null;
    };

// One block per question: in the block's order when the tick ran the block shown, else in the order
// the line stored them. A question of the block the tick did not answer says so, with no numbers.
export function questionViews(tick: DecisionTickView): QuestionView[] {
  const answers = tick.answers ?? {};
  const block = tick.block;
  const names = block
    ? block.questions.map((q) => q.name)
    : Object.keys(answers);
  return names.map((name) => questionView(name, answers[name], block));
}

function questionView(
  name: string,
  raw: unknown,
  block: Block | null,
): QuestionView {
  const a = bag(raw);
  const q = block?.questions.find((x) => x.name === name) ?? null;
  if (!a) return { name, kind: "unanswered" };
  if (a.type === "refusal") return { name, kind: "refusal" };
  if (a.type === "yes_no") {
    const probability = num(a.probability);
    if (probability === null) return { name, kind: "unanswered" };
    const thresholds = (block?.rules ?? []).flatMap((r, rule) =>
      r.when.flatMap((c) =>
        c.question === name && "minProbability" in c
          ? [{ rule, minProbability: c.minProbability }]
          : [],
      ),
    );
    return { name, kind: "yes_no", probability, thresholds };
  }
  const probs = bag(a.probabilities) ?? {};
  const options =
    q && q.type === "choice"
      ? q.options
      : q && q.type === "score"
        ? q.levels
        : null;
  const rowsFor = (chosen: string | null): ProbabilityRow[] =>
    options
      ? options.map((o) => ({
          value: o.value,
          description: o.description || null,
          probability: num(probs[o.value]),
          chosen: o.value === chosen,
        }))
      : Object.entries(probs).map(([value, p]) => ({
          value,
          description: null,
          probability: num(p),
          chosen: value === chosen,
        }));
  if (a.type === "choice") {
    const choice = str(a.choice);
    const rows = rowsFor(choice);
    // A provider may answer a choice with partial probabilities, or none: the choice is still the
    // answer, shown with no number rather than dropped.
    if (choice !== null && !rows.some((r) => r.chosen)) {
      rows.push({
        value: choice,
        description: null,
        probability: null,
        chosen: true,
      });
    }
    return {
      name,
      kind: "choice",
      choice,
      confidence: num(a.confidence),
      rows,
      closeCall: closeCallOf(rows),
    };
  }
  if (a.type === "score") {
    const score = num(a.score);
    if (score === null) return { name, kind: "unanswered" };
    const level = Math.round(score);
    // A level's name comes from the block's order only: the stored probabilities keep the order the
    // provider answered in, which says nothing about which level is which index.
    const levelName = options?.[level]?.value ?? null;
    return {
      name,
      kind: "score",
      score,
      level,
      levelName,
      confidence: num(a.confidence),
      rows: rowsFor(levelName),
      closeCall: closeCallOf(rowsFor(levelName)),
    };
  }
  return { name, kind: "unanswered" };
}

// How close a call has to be to be flagged, and how near a threshold a rule has to come to be a near
// miss: about 15 points of probability or confidence (agents#1401, the operator's decision).
export const NEAR = 0.15;

export interface CloseCall {
  value: string;
  probability: number;
}

// The runner-up, when it came within NEAR of the chosen option: "negativo 55% against neutro 44%" is
// the call an operator wants to see, since a threshold or an option there decides the outcome. Needs
// the chosen option's own probability; a choice whose probability was not given is not judged.
function closeCallOf(rows: ProbabilityRow[]): CloseCall | null {
  const chosen = rows.find((r) => r.chosen);
  if (!chosen || chosen.probability === null) return null;
  let runner: CloseCall | null = null;
  for (const r of rows) {
    if (r.chosen || r.probability === null) continue;
    if (!runner || r.probability > runner.probability) {
      runner = { value: r.value, probability: r.probability };
    }
  }
  // The gap in either direction: a score's level is the rounded weighted mean, so the level shown
  // need not be the likeliest, and a runner-up far above it is not a close call.
  return runner &&
    Math.abs(chosen.probability - runner.probability) <= NEAR + 1e-9
    ? runner
    : null;
}

export type RuleView =
  | {
      rule: number;
      kind: "fired";
      tool: string;
      outcome: string;
      failure: string | null;
      fence: string | null;
      partial: boolean;
      // Set on a rule whose identical action an earlier rule ran: the outcome is that rule's.
      sameAs: number | null;
    }
  | { rule: number; kind: "held"; trigger: string | null }
  | { rule: number; kind: "not_fired"; miss: Record<string, unknown> }
  // A rule of the block the line names in none of its lists: a line written before `merged` existed
  // left out a rule that fired the same action as an earlier one, so it fired, with no outcome of its
  // own (docs/decisions.md, "What it has been doing").
  | { rule: number; kind: "unknown" };

// Every rule with its outcome, in rule order: fired (with the action and what became of it), held by
// its trigger, or not fired with the first condition that failed. With the block shown, a rule the
// line says nothing about still gets a row, so no rule of the block disappears from the screen.
export function ruleViews(tick: DecisionTickView): RuleView[] {
  const byRule = new Map<number, RuleView>();
  for (const raw of tick.actions) {
    const a = bag(raw);
    const rule = num(a?.rule);
    if (!a || rule === null) continue;
    const base = {
      kind: "fired" as const,
      tool: str(a.tool) ?? "",
      outcome: str(a.outcome) ?? "",
      failure: str(a.failure) ?? str(a.error),
      fence: str(a.fence),
      partial: a.partial === true,
    };
    byRule.set(rule, { rule, ...base, sameAs: null });
    for (const m of Array.isArray(a.merged) ? a.merged : []) {
      const merged = num(m);
      if (merged !== null && !byRule.has(merged)) {
        byRule.set(merged, { rule: merged, ...base, sameAs: rule });
      }
    }
  }
  for (const raw of tick.held) {
    const h = bag(raw);
    const rule = num(h?.rule);
    if (h && rule !== null && !byRule.has(rule)) {
      byRule.set(rule, { rule, kind: "held", trigger: str(h.trigger) });
    }
  }
  for (const raw of tick.notFired) {
    const n = bag(raw);
    const rule = num(n?.rule);
    const miss = bag(n?.miss);
    if (rule !== null && miss && !byRule.has(rule)) {
      byRule.set(rule, { rule, kind: "not_fired", miss });
    }
  }
  if (tick.block) {
    tick.block.rules.forEach((_, rule) => {
      if (!byRule.has(rule)) byRule.set(rule, { rule, kind: "unknown" });
    });
  }
  return [...byRule.values()].sort((x, y) => x.rule - y.rule);
}

// What the tick did, counted by kind of action, for the collapsed marker: only actions that ran. A
// label write is counted by what it changed when the line says (`labels`, one entry per write): one
// `set_labels` call can add several labels, or none. A line without it counts the writes.
export interface ActionSummary {
  // Null when the line does not record what its label writes changed.
  labelsAdded: number | null;
  labelsRemoved: number | null;
  labelWrites: number;
  attributes: number;
  notes: number;
  handedOff: boolean;
  tools: number;
}

export function actionSummary(tick: DecisionTickView): ActionSummary {
  const s: ActionSummary = {
    labelsAdded: null,
    labelsRemoved: null,
    labelWrites: 0,
    attributes: 0,
    notes: 0,
    handedOff: false,
    tools: 0,
  };
  for (const raw of tick.actions) {
    const a = bag(raw);
    if (a?.outcome !== "ran") continue;
    if (a.tool === "set_labels") s.labelWrites++;
    else if (a.tool === "set_custom_attribute") s.attributes++;
    else if (a.tool === "private_note") s.notes++;
    else if (a.tool === "handoff_to_human") s.handedOff = true;
    else s.tools++;
  }
  const writes = tick.labels.flatMap((raw) => {
    const w = bag(raw);
    const added = num(w?.added);
    const removed = num(w?.removed);
    return added === null || removed === null ? [] : [{ added, removed }];
  });
  if (writes.length > 0) {
    s.labelsAdded = writes.reduce((n, w) => n + w.added, 0);
    s.labelsRemoved = writes.reduce((n, w) => n + w.removed, 0);
  }
  return s;
}

// The rules in the groups the expanded tick shows: the ones that fired, the ones whose conditions
// held but their trigger held them back (they did NOT act this tick, so they never sit among the
// fired), the near misses, and the rest, folded into one line.
export interface RuleGroups {
  fired: RuleView[];
  held: RuleView[];
  near: RuleView[];
  rest: RuleView[];
}

// A rule that did not fire is a near miss when its value came within NEAR of its threshold, or a
// score landed one level outside its range: the rule an operator tunes. Everything else (another
// option chosen, a question unanswered) is a plain no.
export function isNearMiss(miss: Record<string, unknown>): boolean {
  if (miss.why === "below_threshold") {
    const got = num(miss.got);
    const threshold = num(miss.threshold);
    return got !== null && threshold !== null && threshold - got <= NEAR + 1e-9;
  }
  if (miss.why === "outside_levels") {
    const got = num(miss.got);
    const min = num(miss.minLevel);
    const max = num(miss.maxLevel);
    if (got === null || min === null || max === null) return false;
    const level = Math.round(got);
    return (level < min ? min - level : level - max) <= 1;
  }
  return false;
}

export function ruleGroups(tick: DecisionTickView): RuleGroups {
  const groups: RuleGroups = { fired: [], held: [], near: [], rest: [] };
  for (const r of ruleViews(tick)) {
    if (r.kind === "fired" || r.kind === "unknown") {
      groups.fired.push(r);
    } else if (r.kind === "held") {
      groups.held.push(r);
    } else if (r.kind === "not_fired" && isNearMiss(r.miss)) {
      groups.near.push(r);
    } else groups.rest.push(r);
  }
  return groups;
}

// What changed in the answers since the previous tick of the same agent: a choice that moved, a
// score that landed on another level, a yes/no that crossed one half. Only questions both ticks
// answered; a probability that moved without changing the answer is not a change.
export interface AnswerChange {
  question: string;
  // A yes/no's sides are "yes" and "no", for the screen to translate; the rest are option values.
  yesNo: boolean;
  from: string;
  to: string;
}

function answerWord(
  raw: unknown,
  name: string,
  block: Block | null,
): string | null {
  const a = bag(raw);
  if (!a) return null;
  if (a.type === "choice") return str(a.choice);
  if (a.type === "yes_no") {
    const p = num(a.probability);
    return p === null ? null : p >= 0.5 ? "yes" : "no";
  }
  if (a.type === "score") {
    const score = num(a.score);
    if (score === null) return null;
    const level = Math.round(score);
    const q = block?.questions.find((x) => x.name === name);
    return q?.type === "score"
      ? (q.levels[level]?.value ?? String(level))
      : String(level);
  }
  return null;
}

export function answerChanges(
  previous: DecisionTickView,
  current: DecisionTickView,
): AnswerChange[] {
  const before = previous.answers ?? {};
  const now = current.answers ?? {};
  const names = current.block
    ? current.block.questions.map((q) => q.name)
    : Object.keys(now);
  const out: AnswerChange[] = [];
  for (const name of names) {
    if (!(name in before) || !(name in now)) continue;
    // A score is a level index, and an index means a level only under the block that wrote it: two
    // ticks are compared on a score only when both ran the block shown, since an edit in between can
    // reorder the levels and turn an unchanged answer into a move.
    // A question whose type changed in between has no "before" in the same terms.
    const type = bag(now[name])?.type;
    if (bag(before[name])?.type !== type) continue;
    const isScore = type === "score";
    if (isScore && (previous.block === null || current.block === null)) {
      continue;
    }
    const from = answerWord(before[name], name, previous.block);
    const to = answerWord(now[name], name, current.block);
    if (from !== null && to !== null && from !== to) {
      out.push({
        question: name,
        yesNo: bag(now[name])?.type === "yes_no",
        from,
        to,
      });
    }
  }
  return out;
}

// For each decided tick on the trail, the decided tick of the same agent before it, if any. The trail
// comes oldest first. A tick that did not decide (skipped, failed) is neither compared nor a baseline.
export function previousDecisionTicks(
  trail: readonly TrailEntry[],
): Map<string, DecisionTickView> {
  const lastByAgent = new Map<string, DecisionTickView>();
  const out = new Map<string, DecisionTickView>();
  for (const e of trail) {
    const tick = e.decision;
    if (e.kind !== "decision" || !tick || tick.outcome !== "decided") continue;
    if (tick.answers === null) continue;
    const agent = tick.agentId ?? "";
    const prev = lastByAgent.get(agent);
    if (prev) out.set(e.id, prev);
    lastByAgent.set(agent, tick);
  }
  return out;
}

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}
