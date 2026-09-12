import { readSignatureConfig } from "@/modules/signature/service";
import type { SignatureState } from "./BehaviorTab";

// The agent editor's Signature block, as a pair of pure functions: stored settings → form state →
// stored settings. Outside the page for the reason the Memory and TTS pairs are, and for one more
// that is specific to this block: since #612 the block has an `enabled` flag whose whole purpose is
// that turning the signature OFF must not lose the text. Both directions of that promise are
// decisions, not plumbing — what an old bag without the flag means, and what the save writes back —
// and a decision that lives inline in a page is a decision no test can reach.

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
    // THE RAW STORED TEXT, not the reader's copy, and this is the one place the pair must NOT
    // defer to it. `readSignatureConfig` clamps to `SIGNATURE_MAX` because that is what the
    // customer receives; an editor that clamps too shows a truncated copy of a signature stored
    // before the cap existed, and the next save of any unrelated field on the page writes that
    // copy over the original. Silent, permanent, and the same loss this feature is about.
    // The boundary already assumes the form gives back what was stored:
    // `collectOversizedTextChanges` lets an oversized value through exactly when it is UNCHANGED.
    // Found in review of #613.
    text: storedText,
    position: c.position,
    // Through the reader again, which is where the migration lives: a bag written before #616 has
    // no frequency, and what its absence means is read off the position. The form must not answer
    // that question a second time, or the screen and the customer disagree about an agent nobody
    // has opened yet.
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
// all otherwise. The guard is the point, not the seed: turning the switch off keeps what the
// operator wrote, and seeding over a kept text would hand it back with the other hand, which is the
// exact loss #612 exists to prevent, committed by the convenience meant to celebrate it.
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
