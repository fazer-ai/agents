import {
  type DecisionsIssue,
  decisionsIssues,
} from "@/modules/decisions/config";

// The decisions engine's block (`monitoring.decisions`, docs/decisions.md) as the agent editor edits
// it: stored block → form → stored block, the same pair of pure functions every other block of the
// Behavior tab has. The form is asked the write boundary's own schema (`decisionsIssues`), so what
// the screen calls a problem is what the server would refuse, at the same path.

export interface DecisionOptionForm {
  value: string;
  description: string;
}

export interface DecisionQuestionForm {
  // A list key for React, never written. Stable while the entry is on screen, so reordering or
  // removing a neighbour does not hand one question's inputs to another.
  key: string;
  name: string;
  type: string;
  instructions: string;
  // Both lists are held whatever the type, so flipping a question to another type and back does not
  // lose what was typed. Only the list the type reads is written.
  options: DecisionOptionForm[];
  levels: DecisionOptionForm[];
}

// Numbers travel as text: an emptied field is a state the operator passes through, not a value.
export interface DecisionConditionForm {
  question: string;
  minProbability: string;
  equals: string;
  minConfidence: string;
  minLevel: string;
  maxLevel: string;
}

export interface DecisionRuleForm {
  key: string;
  // The rule's index in the block as it was LOADED, or null for one added since. The engine's log
  // lines name a rule by its stored index, so this is what ties a rule on screen to what it has been
  // doing while the operator reorders the list.
  origin: number | null;
  when: DecisionConditionForm[];
  tool: string;
  // The tool's own input, as stored: edited key by key, so an argument this form has no field for
  // (`scope` on set_labels) survives a save.
  args: Record<string, unknown>;
}

export interface DecisionsForm {
  // "" means the stored block does not say, which the engine reads as its default. Kept apart from
  // the default so an untouched block is written back as it was.
  provider: string;
  model: string;
  credentialRef: string;
  apply: string;
  questions: DecisionQuestionForm[];
  rules: DecisionRuleForm[];
}

// How much the two free-text fields (a question's wording, a note's text) take when TYPED here. A
// bound on the form, not a clamp anywhere: neither the boundary nor the engine cuts these, so a
// longer text written through the API is shown and saved whole.
export const DECISION_TEXT_FIELD_MAX = 2000;

let fresh = 0;
// A key for an entry created on screen. Loaded entries are keyed by position instead, so the same
// stored block always produces the same form (the editor compares forms to tell dirty from clean).
export function freshDecisionKey(): string {
  fresh += 1;
  return `n${fresh}`;
}

const bag = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function optionsToForm(v: unknown): DecisionOptionForm[] {
  return list(v).map((o) => ({
    value: text(bag(o)?.value),
    description: text(bag(o)?.description),
  }));
}

export function emptyDecisionsForm(): DecisionsForm {
  return {
    provider: "",
    model: "",
    credentialRef: "",
    apply: "",
    questions: [],
    rules: [],
  };
}

// Where an agent with no block starts: OpenAI Decisions in shadow, so nothing is written before
// the operator has read what it would do.
export function startingDecisionsForm(): DecisionsForm {
  return { ...emptyDecisionsForm(), provider: "openai", apply: "shadow" };
}

export function decisionsToForm(raw: unknown): DecisionsForm | null {
  const b = bag(raw);
  if (!b) return null;
  return {
    provider: text(b.provider),
    model: text(b.model),
    credentialRef: text(b.credentialRef),
    apply: text(b.apply),
    questions: list(b.questions).map((q, i) => {
      const o = bag(q) ?? {};
      return {
        key: `q${i}`,
        name: text(o.name),
        // "" when the stored question has none: shown as a choice still to make, never as a type
        // the block does not hold.
        type: text(o.type),
        instructions: text(o.instructions),
        options: optionsToForm(o.options),
        levels: optionsToForm(o.levels),
      };
    }),
    rules: list(b.rules).map((r, i) => {
      const o = bag(r) ?? {};
      const action = bag(o.action) ?? {};
      return {
        key: `r${i}`,
        origin: i,
        when: list(o.when).map((c) => {
          const cond = bag(c) ?? {};
          return {
            question: text(cond.question),
            minProbability: text(cond.minProbability),
            equals: text(cond.equals),
            minConfidence: text(cond.minConfidence),
            minLevel: text(cond.minLevel),
            maxLevel: text(cond.maxLevel),
          };
        }),
        tool: text(action.tool),
        args: structuredClone(bag(action.args) ?? {}),
      };
    }),
  };
}

// A number as the wire wants it. Text that is not a number travels AS TYPED: the server refuses it
// naming the field, where a silent fallback would store a threshold the operator never chose.
function num(v: string): number | string | undefined {
  const t = v.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== "") out[key] = value;
}

function optionsToStored(
  options: DecisionOptionForm[],
): Record<string, unknown>[] {
  return options.map((o) => {
    const out: Record<string, unknown> = {};
    put(out, "value", o.value);
    // Written even when empty: the boundary asks for the key, and an option needs no description.
    out.description = o.description;
    return out;
  });
}

export function questionTypeOf(
  form: DecisionsForm,
  name: string,
): string | null {
  return form.questions.find((q) => q.name === name)?.type ?? null;
}

// Every text is written AS HELD, never trimmed: the engine compares a condition's `question` and
// `equals` with the question's name and the option's value literally, so tidying one side of a pair
// the stored block has spelled with a space would break a rule that works.
export function decisionsToStored(
  form: DecisionsForm,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  put(out, "provider", form.provider);
  put(out, "model", form.model);
  put(out, "credentialRef", form.credentialRef);
  out.questions = form.questions.map((q) => {
    const o: Record<string, unknown> = {};
    put(o, "name", q.name);
    put(o, "type", q.type);
    put(o, "instructions", q.instructions);
    if (q.type === "choice") o.options = optionsToStored(q.options);
    if (q.type === "score") o.levels = optionsToStored(q.levels);
    return o;
  });
  if (form.rules.length > 0) {
    out.rules = form.rules.map((r) => {
      const action: Record<string, unknown> = {};
      put(action, "tool", r.tool);
      action.args = structuredClone(r.args);
      return {
        when: r.when.map((c) => {
          const o: Record<string, unknown> = {};
          const name = c.question;
          put(o, "question", name);
          // Only what the question's type reads, so a threshold left over from another type is not
          // stored as a test the engine never applies. A condition on a question that no longer
          // exists keeps everything it holds: the server refuses it either way, and nothing is lost
          // while the operator points it somewhere else.
          const type = questionTypeOf(form, name);
          if (type === "yes_no" || type === null) {
            put(o, "minProbability", num(c.minProbability));
          }
          if (type === "choice" || type === null) put(o, "equals", c.equals);
          if (type === "score" || type === null) {
            put(o, "minLevel", num(c.minLevel));
            put(o, "maxLevel", num(c.maxLevel));
          }
          if (type !== "yes_no") put(o, "minConfidence", num(c.minConfidence));
          return o;
        }),
        action,
      };
    });
  }
  put(out, "apply", form.apply);
  return out;
}

// Whether the form still says what the stored block says. An untouched block is written back AS
// STORED rather than through the form, so a save of some other field never rewrites it.
export function decisionsUntouched(
  form: DecisionsForm | null,
  stored: Record<string, unknown> | null,
): boolean {
  const base = decisionsToForm(stored);
  if (form === null || base === null) return form === null && base === null;
  return (
    JSON.stringify(decisionsToStored(form)) ===
    JSON.stringify(decisionsToStored(base))
  );
}

// WHERE A PROBLEM IS DRAWN. The boundary reports a missing field at the object that lacks it (it
// compares by value at the issue's path, and an absent key has none), which is a card on screen and
// not an input; the form puts it on the input whose value is missing.
const CHILD_OF: Readonly<Record<string, string>> = {
  needs_min_probability: "minProbability",
  needs_equals: "equals",
  needs_level_range: "minLevel",
  choice_needs_options: "options",
  score_needs_levels: "levels",
};

export function issueFieldPath(issue: DecisionsIssue): string {
  const child =
    issue.code === "required"
      ? String(issue.params.key ?? "")
      : (CHILD_OF[issue.code] ?? "");
  return [...issue.path, ...(child ? [child] : [])].join(".");
}

export type DecisionsIssueMap = ReadonlyMap<string, DecisionsIssue>;

// The first problem at each field, by the dotted path the field is drawn at.
//
// Asked of THE BLOCK A SAVE WOULD WRITE. With `stored` given and the form untouched that is the
// stored block itself, not the form's reading of it: the form fills in what a stored block lacks
// (an option's empty description), and judging that reading would call a block the engine refuses
// sound, on a screen whose save then writes it back unchanged.
export function decisionsFormIssues(
  form: DecisionsForm,
  stored?: Record<string, unknown> | null,
): DecisionsIssueMap {
  const out = new Map<string, DecisionsIssue>();
  const block =
    stored && decisionsUntouched(form, stored)
      ? stored
      : decisionsToStored(form);
  for (const issue of decisionsIssues(block)) {
    const at = issueFieldPath(issue);
    if (!out.has(at)) out.set(at, issue);
  }
  return out;
}

export function issuesUnder(
  issues: DecisionsIssueMap,
  prefix: string,
): DecisionsIssue[] {
  const out: DecisionsIssue[] = [];
  for (const [at, issue] of issues) {
    if (at === prefix || at.startsWith(`${prefix}.`)) out.push(issue);
  }
  return out;
}

// A rule that names a question, an option or a level the questions no longer have. Said apart from
// an incomplete rule because the fix is different: nothing is missing, what it points at is gone.
const BROKEN_CODES: ReadonlySet<string> = new Set([
  "unknown_question",
  "unknown_option",
  "level_out_of_range",
]);

export function ruleIsBroken(issues: DecisionsIssueMap, rule: number): boolean {
  return issuesUnder(issues, `rules.${rule}`).some((i) =>
    BROKEN_CODES.has(i.code),
  );
}

// What an action the server accepts would still fail on at the tick (`invalid_arguments`): the
// boundary stores `args` as written and the tool's own schema refuses them when the rule fires.
// A warning and not a problem, since the save goes through either way.
export type ActionGap = "note_empty" | "attribute_key_empty" | "labels_empty";

export function actionGap(rule: DecisionRuleForm): ActionGap | null {
  const a = rule.args;
  const strings = (v: unknown) =>
    Array.isArray(v) && v.some((x) => typeof x === "string" && x.trim());
  if (rule.tool === "private_note") {
    return typeof a.content === "string" && a.content.trim()
      ? null
      : "note_empty";
  }
  if (rule.tool === "set_custom_attribute") {
    return typeof a.key === "string" && a.key.trim()
      ? null
      : "attribute_key_empty";
  }
  if (rule.tool === "set_labels") {
    return strings(a.add) || strings(a.remove) ? null : "labels_empty";
  }
  return null;
}

// WHERE a labels or attribute action writes: the conversation unless `args.scope` says otherwise
// (the tools' own default). Read and written here so the picker and the stored argument cannot
// disagree: an attribute key belongs to one scope, and offering a conversation's keys for a rule
// stored with `scope: "contact"` would save a rule that writes the wrong thing to the contact.
export function actionScope(rule: DecisionRuleForm): string {
  return typeof rule.args.scope === "string" && rule.args.scope
    ? rule.args.scope
    : "conversation";
}

export function withActionScope(
  rule: DecisionRuleForm,
  scope: string,
): DecisionRuleForm {
  const args = { ...rule.args };
  if (scope === "conversation") delete args.scope;
  else args.scope = scope;
  // The key named an attribute of the scope it was picked in.
  if (rule.tool === "set_custom_attribute" && scope !== actionScope(rule)) {
    delete args.key;
  }
  return { ...rule, args };
}

// The pieces the list editors share: every one returns a new form, so a `setState` can take them.
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const out = [...items];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it as T);
  return out;
}

export function emptyCondition(question = ""): DecisionConditionForm {
  return {
    question,
    minProbability: "",
    equals: "",
    minConfidence: "",
    minLevel: "",
    maxLevel: "",
  };
}

// A condition pointed at a question, with the operands that question's type takes and nothing left
// over from the one it pointed at before.
export function conditionFor(
  form: DecisionsForm,
  question: string,
): DecisionConditionForm {
  const q = form.questions.find((x) => x.name === question);
  const base = emptyCondition(question);
  if (!q) return base;
  if (q.type === "yes_no") return { ...base, minProbability: "0.7" };
  if (q.type === "choice") {
    return { ...base, equals: q.options[0]?.value ?? "" };
  }
  return { ...base, minLevel: "0", maxLevel: "0" };
}

// A save the server refused about a field of this block, kept with the block that was sent: the
// mark stands while the form still writes that block and expires by value the moment it does not,
// the way every other refusal mark in the editor does (docs/ui.md). The API key is not read here:
// it is one of the editor's owned credential fields and is marked by that path.
export interface DecisionsRefusalHeld {
  path: string;
  message: string;
  sent: string;
}

export function decisionsRefusalFrom(
  refusal: { message: string; field?: string } | null,
  sentBlock: unknown,
): DecisionsRefusalHeld | null {
  const m = refusal?.field?.match(
    /^(?:settings\.)?monitoring\.decisions(?:\.(.+))?$/,
  );
  if (!refusal || !m) return null;
  const path = m[1] ?? "";
  if (path === "credentialRef") return null;
  return {
    path,
    message: refusal.message,
    sent: JSON.stringify(sentBlock ?? null),
  };
}

export function decisionsRefusalStanding(
  held: DecisionsRefusalHeld | null,
  blockNow: unknown,
): { path: string; message: string } | null {
  if (!held || JSON.stringify(blockNow ?? null) !== held.sent) return null;
  return { path: held.path, message: held.message };
}
