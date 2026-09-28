import { readSignatureConfig } from "@/modules/signature/service";
import type { SignatureState } from "./BehaviorTab";

// The agent editor's Signature block, as a pair of pure functions: stored settings → form state →
// stored settings. Outside the page like the Memory and TTS pairs, and because the `enabled` flag
// must never lose the text when the signature is turned OFF: what an old bag without the flag means
// and what the save writes back are decisions a test has to reach.

// THROUGH THE RUNTIME'S OWN READER, so the screen and the customer cannot disagree about whether an
// agent is signing. `readSignatureConfig` is what `deliverText` asks at delivery time; asking it
// here too is what makes "a bag with text and no flag means ON" a single rule with one spelling,
// instead of two copies that drift the first time one of them is edited.
export function signatureToForm(settings: unknown): SignatureState {
  const c = readSignatureConfig(settings);
  const bag = (settings as { signature?: { text?: unknown } } | null)
    ?.signature;
  const storedText = typeof bag?.text === "string" ? bag.text : "";
  return {
    enabled: c.enabled,
    // NOTE: The raw stored text, not the reader's copy: `readSignatureConfig` clamps to
    // `SIGNATURE_MAX` for the customer, and an editor that clamps too would write the truncated
    // copy over an older, longer signature on any unrelated save. The boundary relies on this:
    // `collectOversizedTextChanges` lets an oversized value through only when it is UNCHANGED.
    text: storedText,
    position: c.position,
    // NOTE: Through the reader again, which is where the migration lives: a bag with no frequency
    // reads it off the position. The form must not answer that a second time, or the screen and
    // the customer disagree about an agent nobody has opened yet.
    frequency: c.frequency,
    separator: c.separator,
  };
}

export function signatureToStored(form: SignatureState): {
  enabled: boolean;
  text: string;
  position: "top" | "bottom";
  separator: "blank" | "--";
  frequency: "all" | "once";
} {
  return {
    // The operator's own answer, written back as given. Writing `true` whenever there is text would
    // make the switch un-turn-off-able, which is the mutant this pair exists to kill.
    enabled: form.enabled,
    // Trimmed on the way out, the way the reader trims on the way in, so saving an untouched form
    // is a no-op instead of a diff.
    text: form.text.trim(),
    position: form.position,
    // WRITTEN OUT, even when it equals what the position would have implied. The derivation is the
    // reader's answer to a bag that never said; once the operator has seen the control, the bag
    // says. Otherwise a later change of position would silently move a choice the operator made.
    frequency: form.frequency,
    separator: form.separator,
  };
}

// What the field starts with the first time the switch goes on over an EMPTY box, and nothing at
// all otherwise. The guard is the point: turning the switch off keeps what the operator wrote, and
// seeding over a kept text would lose it.
export const SIGNATURE_SEED = "**{{nome_agente}}**";

export function signatureOnToggle(
  form: SignatureState,
  enabled: boolean,
): SignatureState {
  return {
    ...form,
    enabled,
    text: enabled && !form.text.trim() ? SIGNATURE_SEED : form.text,
  };
}
