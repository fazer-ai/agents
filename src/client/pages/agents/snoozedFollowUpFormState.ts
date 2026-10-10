import { SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES } from "@/modules/agents/text-caps";
import type { FollowUpStepState } from "./BehaviorTab";
import { stepsToForm, stepsToStored } from "./followUpFormState";

// The agent editor's "Snoozed follow-up" block (settings.snoozedFollowUp, docs/snoozed-followup.md),
// as the pure pair the other blocks have: stored settings -> form state -> stored settings. The
// Behavior save REPLACES the whole block, so the pair carries every field; the steps go through the
// follow-up's own step mapper (./followUpFormState), since a step means the same thing in both ladders.
//
// The reader (`readSnoozedFollowUpConfig`) DROPS what it cannot use: a second cadence with a label
// already taken, a cadence with no step, labeled cadences past the cap. A save that wrote those would
// look accepted and do nothing, so the form keeps them on screen and `snoozedFollowUpIssues` flags each
// one, which blocks the save until the operator fixes it.

export interface SnoozedCadenceState {
  // null = the default cadence, for a conversation carrying none of the labels below. A labeled
  // cadence holds a string, empty while the operator has not picked one yet.
  label: string | null;
  steps: FollowUpStepState[];
}

export interface SnoozedFollowUpState {
  enabled: boolean;
  signature: boolean;
  // The default cadence first (when there is one), then the labeled ones in the stored order, which is
  // the order `pickSnoozedCadence` tries them in.
  cadences: SnoozedCadenceState[];
}

export function snoozedFollowUpToForm(settings: unknown): SnoozedFollowUpState {
  const s = (settings ?? {}) as Record<string, unknown>;
  const raw = s.snoozedFollowUp;
  const bag = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const cadences = (Array.isArray(bag.cadences) ? bag.cadences : []).map(
    (c): SnoozedCadenceState => {
      const cb = (c && typeof c === "object" ? c : {}) as Record<
        string,
        unknown
      >;
      return {
        // Read as the reader reads it: a blank label is the default.
        label:
          typeof cb.label === "string" && cb.label.trim()
            ? cb.label.trim()
            : null,
        steps: stepsToForm(Array.isArray(cb.steps) ? cb.steps : []),
      };
    },
  );
  // The default is shown first. Its position in the list never changes which cadence a conversation
  // follows (labels are tried first, in order, and the default is the fallback), so moving it is not
  // an edit; the labeled ones keep their relative order, which does decide.
  return {
    enabled: bag.enabled === true,
    signature: bag.signature === true,
    cadences: [
      ...cadences.filter((c) => c.label === null),
      ...cadences.filter((c) => c.label !== null),
    ],
  };
}

export function snoozedFollowUpToStored(form: SnoozedFollowUpState): {
  enabled: boolean;
  signature: boolean;
  cadences: { label: string | null; steps: Record<string, unknown>[] }[];
} {
  return {
    enabled: form.enabled,
    signature: form.signature,
    cadences: form.cadences.map((c) => ({
      label: c.label === null ? null : c.label.trim(),
      steps: stepsToStored(c.steps),
    })),
  };
}

// What is wrong with one cadence, in the reader's terms. Each one is a cadence the reader would drop
// or misread.
export interface SnoozedCadenceIssues {
  // "missing": a labeled cadence with no label picked would be read as a second DEFAULT.
  // "duplicate": an earlier cadence already has this label (ignoring case), or this is a second
  // default; only the first could ever be picked.
  label: "missing" | "duplicate" | null;
  // A cadence with no step reminds nobody and is dropped.
  noSteps: boolean;
}

export interface SnoozedFollowUpIssues {
  cadences: SnoozedCadenceIssues[];
  // More labeled cadences than the reader keeps.
  tooManyLabeled: boolean;
  any: boolean;
}

export function snoozedFollowUpIssues(
  form: SnoozedFollowUpState,
): SnoozedFollowUpIssues {
  const seen = new Set<string>();
  const cadences = form.cadences.map((c): SnoozedCadenceIssues => {
    let label: SnoozedCadenceIssues["label"] = null;
    if (c.label !== null && !c.label.trim()) {
      label = "missing";
    } else {
      // Same key as the reader: labels compare ignoring case, and the default has its own slot.
      const key =
        c.label === null ? "\u0000default" : c.label.trim().toLowerCase();
      if (seen.has(key)) label = "duplicate";
      seen.add(key);
    }
    return { label, noSteps: c.steps.length === 0 };
  });
  const tooManyLabeled =
    form.cadences.filter((c) => c.label !== null).length >
    SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES;
  return {
    cadences,
    tooManyLabeled,
    any: tooManyLabeled || cadences.some((c) => c.label !== null || c.noSteps),
  };
}

// A new step of this ladder. A day is the pace of a person waiting on a document or an order number;
// the follow-up's 30 minutes is the pace of a chat that just went quiet.
export function newSnoozedStep(): FollowUpStepState {
  return {
    delayValue: "24",
    delayUnit: "hours",
    instructions: "",
    assignLabels: [],
    resolve: false,
    ignoreAppointmentPause: false,
  };
}
