// WHAT A LABEL WRITE LEAVES ON THE TRAIL, and why it is not the tool's returned sentence (issue
// #635). A watching agent's whole output is its labels, and its flow line said `acted: true` and
// nothing else: which label it applied, and which one that replaced, existed only in Chatwoot, which
// keeps no history of a label write. The `tool` line beside it carries the shape of the arguments
// (`labels: "array(1)"`) unless the agent has `observability.logToolValues` on, and that switch is
// not the answer — it logs every other tool's arguments and output too, customer data included.
//
// NAMED ONLY WHEN THE OPERATOR'S OWN VOCABULARY NAMES IT. `detail` is allowlisted ids, counts and
// enums, never text (docs/logs.md, tests/modules/flowlog-detail-pii.test.ts). A label title WAS a
// closed vocabulary while the verdict was validated against the operator's groups; it is not one
// now, because `set_labels` takes the model's array and `applyLabelIntent` only subtracts the
// guarded ones — so a title can be a string the model wrote itself, about a customer. The account's
// label list is the closed set, and anything outside it is COUNTED instead of named. With no
// vocabulary read (the fetch is best-effort), nothing is named at all.

export type LabelScope = "conversation" | "contact" | "task";

export interface LabelWrite {
  scope: LabelScope;
  // Titles from the account's label list. Never the whole write: see `unnamed`.
  added: string[];
  removed: string[];
  // How many labels the scope carries after the write, of everything this tool can see.
  after: number;
  // Added or removed titles the account's list does not have, counted rather than named.
  unnamed: number;
}

export type LabelWriteReporter = (write: LabelWrite) => void;

// A conversation carries a handful of labels; a cap is here for the row, not for the vocabulary.
// `detail` bounds each STRING and nothing bounds an array's length, so a pathological write would
// otherwise be as long as the model made it.
const MAX_NAMED = 20;

export function describeLabelWrite(
  scope: LabelScope,
  added: readonly string[],
  removed: readonly string[],
  after: readonly string[],
  vocabulary: readonly string[] | undefined,
): LabelWrite {
  const known = vocabulary === undefined ? null : new Set(vocabulary);
  const name = (titles: readonly string[]): string[] =>
    known === null
      ? []
      : titles.filter((t) => known.has(t)).slice(0, MAX_NAMED);
  const namedAdded = name(added);
  const namedRemoved = name(removed);
  return {
    scope,
    added: namedAdded,
    removed: namedRemoved,
    after: after.length,
    unnamed:
      added.length - namedAdded.length + (removed.length - namedRemoved.length),
  };
}
