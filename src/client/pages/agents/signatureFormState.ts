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
  return {
    enabled: c.enabled,
    text: c.text,
    position: c.position,
    separator: c.separator,
  };
}

export function signatureToStored(form: SignatureState): {
  enabled: boolean;
  text: string;
  position: "top" | "bottom";
  separator: "blank" | "--";
} {
  return {
    // The operator's own answer, written back as given. Writing `true` whenever there is text would
    // make the switch un-turn-off-able, which is the mutant this pair exists to kill.
    enabled: form.enabled,
    // Trimmed on the way out, the way the reader trims on the way in, so saving an untouched form
    // is a no-op instead of a diff.
    text: form.text.trim(),
    position: form.position,
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
