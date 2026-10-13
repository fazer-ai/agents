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
      confidence: number | null;
      rows: ProbabilityRow[];
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
      confidence: num(a.confidence),
      rows,
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
    };
  }
  return { name, kind: "unanswered" };
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

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}
