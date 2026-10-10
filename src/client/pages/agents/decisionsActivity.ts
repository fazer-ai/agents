// What a decisions agent has been doing, read off the `observe` lines its engine already writes
// (docs/decisions.md, "The tick's outcomes"): per rule, how often it fired and what became of the
// action; per question, its latest answers. Pure, so the counting is tested without a server.

export interface DecisionLine {
  createdAt: string | Date;
  status: string;
  detail: unknown;
}

export interface RuleActivity {
  // Decisions in which every condition of the rule held.
  fired: number;
  // ...and of those: the tool ran, could not run (not granted, over the tool budget, failed), or was
  // the same call an earlier rule had already fired (`merged`: two rules firing the same tool with
  // the same arguments run it once, under the first one's index).
  ran: number;
  blocked: number;
  merged: number;
}

export type AnswerSample =
  | { type: "yes_no"; probability: number }
  | { type: "choice"; choice: string; confidence: number | null }
  | { type: "score"; score: number; confidence: number | null }
  | { type: "refusal" };

export interface DecisionsActivity {
  // How many decisions were counted. Zero is an answer: nothing was decided in the window.
  decisions: number;
  rules: ReadonlyMap<number, RuleActivity>;
  // Newest first.
  answers: ReadonlyMap<string, AnswerSample[]>;
}

const NONE: RuleActivity = {
  fired: 0,
  ran: 0,
  blocked: 0,
  merged: 0,
};

const bag = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const numberOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function sample(v: unknown): AnswerSample | null {
  const a = bag(v);
  if (!a) return null;
  if (a.type === "refusal") return { type: "refusal" };
  if (a.type === "yes_no") {
    const p = numberOrNull(a.probability);
    return p === null ? null : { type: "yes_no", probability: p };
  }
  if (a.type === "choice" && typeof a.choice === "string") {
    return {
      type: "choice",
      choice: a.choice,
      confidence: numberOrNull(a.confidence),
    };
  }
  if (a.type === "score") {
    const s = numberOrNull(a.score);
    return s === null
      ? null
      : { type: "score", score: s, confidence: numberOrNull(a.confidence) };
  }
  return null;
}

// `block` is the mark of the questions and rules being shown (`decisionsBlockFingerprint`), and
// only lines carrying it are counted: a line names a rule by its index in the block the tick ran,
// so one from another block is left out rather than read against today's order. `ruleCount` is that
// block's size: a line lists the actions it dispatched and the rules that did NOT fire, and a rule in
// neither list fired and was merged into an earlier rule's identical call, so it counts as fired.
export function summarizeDecisions(
  lines: readonly DecisionLine[],
  block: string | null,
  ruleCount: number,
  samples = 3,
): DecisionsActivity {
  const rules = new Map<number, RuleActivity>();
  const answers = new Map<string, AnswerSample[]>();
  let decisions = 0;
  const ordered = [...lines].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  for (const line of ordered) {
    const d = bag(line.detail);
    if (d?.engine !== "decisions" || line.status !== "ok") continue;
    if (!bag(d.answers) || !Array.isArray(d.actions)) continue;
    if (block === null || d.block !== block) continue;
    decisions += 1;
    for (const raw of d.actions) {
      const a = bag(raw);
      const rule = numberOrNull(a?.rule);
      if (!a || rule === null) continue;
      const cur = rules.get(rule) ?? { ...NONE };
      cur.fired += 1;
      if (a.outcome === "ran") cur.ran += 1;
      // `shadow` is an outcome only old lines carry, an action recorded and not run: it counts as
      // fired, and neither as run nor as unable to run.
      else if (a.outcome !== "shadow") cur.blocked += 1;
      rules.set(rule, cur);
    }
    const accounted = new Set<number>();
    for (const raw of [
      ...d.actions,
      ...(Array.isArray(d.notFired) ? d.notFired : []),
    ]) {
      const rule = numberOrNull(bag(raw)?.rule);
      if (rule !== null) accounted.add(rule);
    }
    for (let rule = 0; rule < ruleCount; rule++) {
      if (accounted.has(rule)) continue;
      const cur = rules.get(rule) ?? { ...NONE };
      cur.fired += 1;
      cur.merged += 1;
      rules.set(rule, cur);
    }
    for (const [name, raw] of Object.entries(bag(d.answers) ?? {})) {
      const s = sample(raw);
      if (!s) continue;
      const cur = answers.get(name) ?? [];
      if (cur.length < samples) cur.push(s);
      answers.set(name, cur);
    }
  }
  return { decisions, rules, answers };
}
