import type { LabelGroup } from "./settings";

// Applying a verdict to a label set is DETERMINISTIC, and the model never touches the set itself
// (issue #477): it names a value per group, and this decides what the conversation's labels become.
// Labels outside every group are never touched — the responder's `agente-off`, the operator's own
// tags — and a value the group does not list is refused rather than written, because a label the
// team never created is a label nobody filters by.

export interface VerdictChange {
  group: string;
  from: string | null;
  to: string;
}

export interface RefusedValue {
  group: string;
  value: string;
}

export interface AppliedVerdict {
  // The label set to write, or null when the verdict changes nothing (nothing is written then).
  next: string[] | null;
  changes: VerdictChange[];
  refused: RefusedValue[];
}

export function applyVerdict(
  current: readonly string[],
  groups: readonly LabelGroup[],
  verdict: Record<string, unknown>,
): AppliedVerdict {
  const next = [...current];
  const changes: VerdictChange[] = [];
  const refused: RefusedValue[] = [];
  // WHAT AN EARLIER GROUP IN THIS VERDICT ALREADY CHOSE (issue #477 review, round 2). Two groups may
  // list the same value — nothing refuses that, and a taxonomy where `urgente` belongs to two axes
  // is a reasonable thing to configure — and an exclusive group clears every one of ITS values that
  // the set holds. Read off the already-mutated set, that clearing removed a value the group before
  // it had just put there: `A=[x,y]`, `B=[x,z]`, a verdict of `{A: x, B: z}` reported both and wrote
  // only `z`. A value this verdict chose is never one of the leftovers a later group sweeps out.
  const chosen = new Set<string>();
  for (const group of groups) {
    const raw = verdict[group.name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    if (!group.values.includes(value)) {
      refused.push({ group: group.name, value });
      continue;
    }
    if (group.exclusive) {
      const held = next.filter(
        (l) => group.values.includes(l) && !chosen.has(l),
      );
      if (held.length === 0 && next.includes(value)) {
        chosen.add(value);
        continue;
      }
      if (held.length === 1 && held[0] === value) {
        chosen.add(value);
        continue;
      }
      for (const l of held) next.splice(next.indexOf(l), 1);
      if (!next.includes(value)) next.push(value);
      chosen.add(value);
      changes.push({ group: group.name, from: held[0] ?? null, to: value });
    } else if (!next.includes(value)) {
      next.push(value);
      chosen.add(value);
      changes.push({ group: group.name, from: null, to: value });
    } else {
      chosen.add(value);
    }
  }
  return { next: changes.length > 0 ? next : null, changes, refused };
}
