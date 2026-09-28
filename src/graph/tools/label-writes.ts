// WHAT A LABEL WRITE LEAVES ON THE TRAIL (Chatwoot keeps no history of one). Counts, not titles:
// `set_labels` takes whatever titles the model names and Chatwoot CREATES unknown ones, so nothing
// tells an operator's label from an invented one, not even the account's list (the invented title
// is in it one cache refresh later), and `detail` is ids, counts and enums only (docs/logs.md).
// `logToolValues` is not the answer: it logs every tool's customer data too. With an operator list
// (`settings.setLabels.allowed`) it also names the moved labels IN the list, which is operator
// configuration; a title outside it is only counted (`outsideAllowed`).

export type LabelScope = "conversation" | "contact" | "task";

export interface LabelWrite {
  scope: LabelScope;
  added: number;
  removed: number;
  // How many labels the scope carries after the write, of everything this tool can see.
  after: number;
  // Present only when the agent declares a list: the moved labels that are IN it.
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
