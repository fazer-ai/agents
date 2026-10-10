import {
  FOLLOW_UP_DEFAULT_DELAY_VALUE,
  SNOOZED_CADENCE_LABEL_MAX,
  SNOOZED_FOLLOW_UP_MAX_LABELED_CADENCES,
} from "@/modules/agents/text-caps";
import type { FollowUpStepState } from "./BehaviorTab";
import { stepsToForm, stepsToStored } from "./followUpFormState";

// The agent editor's "Snoozed follow-up" block (settings.snoozedFollowUp, docs/snoozed-followup.md):
// stored settings -> form state -> stored settings. The Behavior save REPLACES the whole block, so the
// pair carries every field; steps go through the follow-up's own mapper (./followUpFormState).

// The reader DROPS what it cannot use (a taken label, a cadence with no step, cadences past the cap), so
// a save that wrote those would look accepted and do nothing. The form keeps them on screen and
// `snoozedFollowUpIssues` flags each one, which blocks the save.

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
        steps: stepsToForm(
          Array.isArray(cb.steps) ? cb.steps : [],
          String(FOLLOW_UP_DEFAULT_DELAY_VALUE),
        ),
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
    // A labeled cadence whose label was never picked is not written: stored blank, the reader would
    // read it as the default. Save is held while it is on screen; this covers the save made with the
    // ladder off, when the cadences (and that warning) are hidden.
    cadences: form.cadences
      .filter((c) => c.label === null || c.label.trim() !== "")
      .map((c) => ({
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
  // "tooLong": longer than the reader keeps; it would be clipped, and could collide with another.
  label: "missing" | "duplicate" | "tooLong" | null;
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
    } else if (
      c.label !== null &&
      c.label.trim().length > SNOOZED_CADENCE_LABEL_MAX
    ) {
      label = "tooLong";
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

// Whether the block may not be saved: its issues, while its fields are drawn (a monitoring agent hides
// the section and the switch hides the cadences). Asked by every path that writes the block.
export function snoozedFollowUpBlocksSave(
  form: SnoozedFollowUpState,
  mode: string,
): boolean {
  return (
    mode !== "monitoring" && form.enabled && snoozedFollowUpIssues(form).any
  );
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
