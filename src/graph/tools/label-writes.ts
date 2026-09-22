// WHAT A LABEL WRITE LEAVES ON THE TRAIL, and why it is counts and not titles (issue #635).
//
// A watching agent's whole output is its labels, and its flow line said `acted: true` and nothing
// else: that a label moved, which one, and which one it replaced existed only in Chatwoot, which
// keeps no history of a label write. The `tool` line beside it carries the shape of the arguments
// (`labels: "array(1)"`) unless the agent has `observability.logToolValues` on, and that switch is
// not the answer — it logs every other tool's arguments and output too, customer data included.
//
// TITLES ARE NOT LOGGED, and the reason is that nothing here can tell an operator's label from one
// the model invented. `detail` is allowlisted ids, counts and enums, never text (docs/logs.md,
// tests/modules/flowlog-detail-pii.test.ts). A title WAS a closed vocabulary while the verdict was
// validated against the operator's groups; it is not one now: `set_labels` takes the titles the
// model names in `add`/`remove`, `applyLabelDelta` only refuses the guarded ones, and a title
// Chatwoot does not have is CREATED there. The account's label list therefore stops being evidence one cache refresh later — the
// invented title is in it, so a filter against that list would name, on the next tick, exactly the
// string this fence exists to keep out (review round 2).
//
// So the entry counts. `added`/`removed` are how many moved and `after` is how many the scope
// carries, which answers how often an observation replaces a classification.
//
// WITH AN OPERATOR-DECLARED LIST (`settings.setLabels.allowed`, issue #638) it also NAMES what moved,
// and only what the list holds: `addedTitles`/`removedTitles` are the moved labels that are in the
// list, and a title the operator wrote is operator configuration, not message text. A title outside
// the list is still the model's string and is never written here; under `accept` it is COUNTED
// (`outsideAllowed`). Without a list the entry is the same four counts it always was.

export type LabelScope = "conversation" | "contact" | "task";

export interface LabelWrite {
  scope: LabelScope;
  added: number;
  removed: number;
  // How many labels the scope carries after the write, of everything this tool can see.
  after: number;
  // Present only when the agent declares a list (issue #638): the moved labels that are IN it.
  addedTitles?: string[];
  removedTitles?: string[];
  // How many labels went in from outside the list under `accept`. Absent when none did.
  outsideAllowed?: number;
}

export type LabelWriteReporter = (write: LabelWrite) => void;

export function describeLabelWrite(
  scope: LabelScope,
  added: readonly string[],
  removed: readonly string[],
  after: readonly string[],
  list?: {
    allowed?: readonly string[];
    acceptedOutside?: readonly string[];
  },
): LabelWrite {
  const allowed = new Set(list?.allowed ?? []);
  const outside = list?.acceptedOutside?.length ?? 0;
  return {
    scope,
    added: added.length,
    removed: removed.length,
    after: after.length,
    ...(allowed.size > 0
      ? {
          addedTitles: added.filter((l) => allowed.has(l)),
          removedTitles: removed.filter((l) => allowed.has(l)),
        }
      : {}),
    ...(outside > 0 ? { outsideAllowed: outside } : {}),
  };
}
