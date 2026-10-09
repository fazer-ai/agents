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
  // ...and of those: the tool ran, was only logged (shadow), or could not run (not granted, over
  // the tool budget, failed).
  ran: number;
  shadow: number;
  blocked: number;
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

// `block` is the mark of the questions and rules being shown (`decisionsBlockFingerprint`). A line
// names a rule by its index in the block AS IT WAS when the tick ran and carries that block's mark,
// so only the lines that ran THIS block are counted: one written before the rules were reordered,
// or by a tick that was in flight across the save, is left out rather than attributed to whatever
// sits at that index today. A block that could not run has no mark and counts nothing.
export function summarizeDecisions(
  lines: readonly DecisionLine[],
  block: string | null,
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
      const cur = rules.get(rule) ?? {
        fired: 0,
        ran: 0,
        shadow: 0,
        blocked: 0,
      };
      cur.fired += 1;
      if (a.outcome === "ran") cur.ran += 1;
      else if (a.outcome === "shadow") cur.shadow += 1;
      else cur.blocked += 1;
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
