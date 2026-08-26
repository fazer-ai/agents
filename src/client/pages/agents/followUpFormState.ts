import { FOLLOW_UP_MAX_STEPS } from "@/modules/followups/settings";
import type { FollowUpState, FollowUpStepState } from "./BehaviorTab";

// The agent editor's Follow-up block, as a pair of pure functions: stored settings → form state →
// stored settings. It lives outside the page for the reason the Memory and TTS pairs do — the
// Behavior save REPLACES the whole `followUp` block with what the form holds, so a field the form
// does not carry is not merely un-editable, it is DELETED on the next save — and for one this block
// has alone: a step is a BAG of optional fields, and `followUpToStored` rebuilds each one field by
// field. A rebuild lists what to keep, so the field added next is dropped by omission, silently, on
// the first save by an operator who never opened that switch. The round-trip test over this pair
// reads the field list off `FollowUpStep` itself, so that omission fails a test instead.

export function followUpToForm(settings: unknown): FollowUpState {
  const s = (settings ?? {}) as Record<string, unknown>;
  const fu = (s.followUp ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof fu.enabled === "boolean" ? fu.enabled : false,
    steps: readSteps(fu),
    pauseWhileAppointment: fu.pauseWhileAppointment !== false,
  };
}

// Map the raw followUp bag into the editor's step list from the multi-step `steps` array. No
// back-compat: a bag without a steps array yields one default step (the old flat config is not read).
// Always returns at least one step.
function readSteps(fu: Record<string, unknown>): FollowUpStepState[] {
  const rawSteps =
    Array.isArray(fu.steps) && fu.steps.length > 0
      ? (fu.steps as Record<string, unknown>[])
      : [{}];
  return rawSteps.slice(0, FOLLOW_UP_MAX_STEPS).map((st) => ({
    delayValue: num(st.delayValue) || "30",
    delayUnit: str(st.delayUnit) || "minutes",
    instructions: str(st.instructions),
    assignLabels: stepLabels(st),
    resolve: st.resolve === true,
    ignoreAppointmentPause: st.ignoreAppointmentPause === true,
  }));
}

export function followUpToStored(form: FollowUpState): {
  enabled: boolean;
  pauseWhileAppointment: boolean;
  steps: Record<string, unknown>[];
} {
  return {
    enabled: form.enabled,
    pauseWhileAppointment: form.pauseWhileAppointment,
    steps: form.steps.map((s, i) => {
      const labels = s.assignLabels
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return {
        delayValue: Math.max(1, Number(s.delayValue) || 1),
        delayUnit: s.delayUnit,
        instructions: s.instructions.trim(),
        // NOTE: the optional actions are omitted when off, so the persisted shape stays minimal
        // and an agent saved through this form is byte-comparable with one that was never opened.
        ...(labels.length > 0 ? { assignLabels: labels } : {}),
        // NOTE: `resolve` is sent only for the LAST step (the server also enforces this).
        ...(i === form.steps.length - 1 && s.resolve ? { resolve: true } : {}),
        // NOTE: sent whatever `pauseWhileAppointment` says. The editor HIDES this switch while
        // the agent-wide pause is off, because there the opt-out decides nothing; hiding it must
        // not delete it, or turning the pause off and on again would silently clear every step's
        // exemption.
        ...(s.ignoreAppointmentPause ? { ignoreAppointmentPause: true } : {}),
      };
    }),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}

// Read the follow-up step's labels: the new `assignLabels` array, falling back to the legacy single
// `assignLabel` string so an agent saved before multi-label keeps its label in the editor.
function stepLabels(st: Record<string, unknown>): string[] {
  if (Array.isArray(st.assignLabels)) {
    return st.assignLabels.filter((l): l is string => typeof l === "string");
  }
  return typeof st.assignLabel === "string" && st.assignLabel
    ? [st.assignLabel]
    : [];
}
