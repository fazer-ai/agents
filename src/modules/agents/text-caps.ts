import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";

// Caps on the operator-authored free text stored inside `agent.settings`, and the one place that
// knows where that text lives.
//
// Each of these fields is read through a clamp (readToolInstructions, readGuardrailsConfig,
// readVisionConfig, readFollowUpConfig), which is the right thing for a bag that can hold anything:
// a malformed row must never reach the model unbounded. What the clamp cannot do is tell the person
// who wrote the text. The row keeps every character, the editor hydrates from the row, and only the
// copy handed to the model is short — so a transfer policy cut after "escalate only after two failed
// attempts," reads as a complete rule everywhere the operator can look.
//
// So the readers keep clamping (defense for what is already stored), the write boundary refuses the
// text a write INTRODUCES or CHANGES (`assertSettingsTextSizes`, so nobody loses text without being
// told, and see collectOversizedTextChanges for why it has to be only that), the importer clamps and
// warns (a bundle authored elsewhere should not be rejected whole, but the operator hears about it),
// and the editor declares the cap on the field itself.
//
// Deliberately NOT here: the list-shaped caps (guardrails competitors, follow-up labels, appointment
// reminder offsets). Those bound how MANY entries are kept, and an entry that gets dropped is visible
// as a missing row rather than as a sentence that ends early.
export const TOOL_INSTRUCTIONS_MAX = 1500;
export const CUSTOM_POLICY_MAX = 2000;
export const TEMPLATE_MESSAGE_MAX = 2000;
export const GENERATION_PROMPT_MAX = 2000;
export const EXTRACTION_PROMPT_MAX = 4000;
export const FOLLOW_UP_INSTRUCTIONS_MAX = 2000;

// Not a text cap: how many follow-up steps readFollowUpConfig keeps. It lives here because the walker
// below has to stop where the reader stops — text in a step the reader discards is text nothing reads.
export const FOLLOW_UP_MAX_STEPS = 10;

// Cut to `max` UTF-16 units without ever ending on half of an astral character. `slice` counts code
// UNITS, so a cut that lands between the two halves of an emoji leaves an unpaired high surrogate:
// Postgres refuses an unpaired surrogate escape in jsonb (the write that carried it fails outright),
// and anywhere it survives it renders as a replacement character in the middle of operator text.
// Dropping the orphan half costs one character off a value that was too long anyway.
export function clipText(value: string, max: number): string {
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface OversizedText {
  // Dotted path into the settings bag, e.g. `handoff.instructions`. It is what the operator reads in
  // the error, so it names the stored shape rather than the editor's label (which the API has no
  // business knowing).
  path: string;
  length: number;
  max: number;
}

interface CappedField {
  path: string;
  // The RAW stored string, not the trimmed one the readers measure. The editor cannot mirror a
  // trimmed rule: the browser enforces `maxLength` against the raw value, so counting the trimmed one
  // made the control refuse a character while the counter still showed room. Accepting a value whose
  // only problem is invisible whitespace is worth less than one rule the operator can see.
  value: string;
  max: number;
  replace: (next: string) => void;
}

function bagOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// Every capped text field PRESENT in this bag, in a form both callers can act on. Absent blocks,
// non-string values and malformed shapes are skipped rather than reported: the settings bag is
// free-form by design and a write must not fail over a key nothing reads.
function cappedFields(settings: unknown): CappedField[] {
  const out: CappedField[] = [];
  const root = bagOf(settings);
  if (!root) return out;
  const add = (
    owner: Record<string, unknown>,
    key: string,
    path: string,
    max: number,
  ) => {
    const v = owner[key];
    if (typeof v !== "string") return;
    out.push({
      path,
      value: v,
      max,
      replace: (next) => {
        owner[key] = next;
      },
    });
  };

  const handoff = bagOf(root.handoff);
  if (handoff) {
    add(handoff, "instructions", "handoff.instructions", TOOL_INSTRUCTIONS_MAX);
  }
  // Same shape as guardrails.templateMessage: fixed operator copy the CUSTOMER reads when a gate
  // trips, so it gets the same ceiling.
  const availability = bagOf(root.availability);
  if (availability) {
    add(
      availability,
      "awayMessage",
      "availability.awayMessage",
      TEMPLATE_MESSAGE_MAX,
    );
  }
  // The refusal copy the CUSTOMER reads when the authorization gate denies them: same nature as the
  // away message above, so it gets the same ceiling.
  const contactAuth = bagOf(root.contactAuth);
  if (contactAuth) {
    add(
      contactAuth,
      "denyMessage",
      "contactAuth.denyMessage",
      TEMPLATE_MESSAGE_MAX,
    );
  }
  const kanban = bagOf(root.kanban);
  if (kanban) {
    add(kanban, "instructions", "kanban.instructions", TOOL_INSTRUCTIONS_MAX);
  }
  const guidance = bagOf(root.toolGuidance);
  if (guidance) {
    // Only native tool names: readToolGuidance drops every other key, so an unknown one is text
    // nothing ever reads.
    for (const name of NATIVE_TOOL_NAMES) {
      add(guidance, name, `toolGuidance.${name}`, TOOL_INSTRUCTIONS_MAX);
    }
  }
  const guardrails = bagOf(root.guardrails);
  if (guardrails) {
    add(
      guardrails,
      "customPolicy",
      "guardrails.customPolicy",
      CUSTOM_POLICY_MAX,
    );
    // Per direction: the template message is what the CUSTOMER reads when a check trips, and the
    // generation prompt steers the model that rewrites the reply. Both are clamped by readDirection.
    for (const dir of ["input", "output"] as const) {
      const d = bagOf(guardrails[dir]);
      if (!d) continue;
      add(
        d,
        "templateMessage",
        `guardrails.${dir}.templateMessage`,
        TEMPLATE_MESSAGE_MAX,
      );
      // Output only, same rule as the unknown tool names above: the input direction never writes a
      // replacement (src/modules/guardrails/analyze.ts), so its guidance reaches no prompt and a cap
      // on it caps nothing. Keeping it here would refuse a write over text nothing reads, and — the
      // reason this is a bug and not a tidy-up — the console would raise a text-cap warning routed
      // to a section that no longer offers the field, so an agent carrying a legacy oversized value
      // would show a warning with a "Go to" that lands nowhere and can never be cleared.
      if (dir === "output") {
        add(
          d,
          "generationPrompt",
          `guardrails.${dir}.generationPrompt`,
          GENERATION_PROMPT_MAX,
        );
      }
    }
  }
  const vision = bagOf(root.vision);
  if (vision) {
    add(
      vision,
      "extractionPrompt",
      "vision.extractionPrompt",
      EXTRACTION_PROMPT_MAX,
    );
  }
  const followUp = bagOf(root.followUp);
  // Sliced like the reader does: it keeps FOLLOW_UP_MAX_STEPS and discards the rest before parsing,
  // so an instruction in a later step is text nothing reads.
  const steps = (Array.isArray(followUp?.steps) ? followUp.steps : []).slice(
    0,
    FOLLOW_UP_MAX_STEPS,
  );
  steps.forEach((raw, i) => {
    const step = bagOf(raw);
    if (!step) return;
    add(
      step,
      "instructions",
      `followUp.steps[${i}].instructions`,
      FOLLOW_UP_INSTRUCTIONS_MAX,
    );
  });
  return out;
}

// The oversized text this write is responsible for: what it introduces, or changes.
//
// A value already stored over the cap is NOT the write's problem, and refusing it was a dead end
// rather than a stricter rule. Every field carrying one can be unreachable in the editor: a
// native-tool note the editor has no control for at all (`private_note`, `resolve_conversation`), or
// a section whose fields only render once it is switched on (guardrails, vision, follow-up) or once
// the tool is granted. The refusal named the field correctly and the operator still had nothing to
// shorten — on every tab, on every save, permanently. The reader clamps that value on the way to the
// model, which is the only place the length ever mattered.
//
// Compared by path, so an unchanged field is unchanged no matter what else moved in the bag. The one
// place a path can shift under a value is a follow-up step list that gets reordered, and there the
// operator is by definition inside the section that renders the field.
export function collectOversizedTextChanges(
  next: unknown,
  previous: unknown,
): OversizedText[] {
  const stored = new Map(
    cappedFields(previous).map((f) => [f.path, f.value.trim()]),
  );
  const out: OversizedText[] = [];
  for (const f of cappedFields(next)) {
    if (f.value.length <= f.max) continue;
    // Compared trimmed, measured raw, and the asymmetry is the point. The cap counts what the
    // browser counts (`maxLength` is over the raw value), while "did this write touch the text" has
    // to ignore what every reader already discards: the editor trims these fields when it serializes
    // the form, so an untouched legacy value with surrounding whitespace comes back as a different
    // string and would read as an edit nobody made.
    if (stored.get(f.path) === f.value.trim()) continue;
    out.push({ path: f.path, length: f.value.length, max: f.max });
  }
  return out;
}

// Cuts each oversized field to exactly what its reader would have used, IN PLACE, and returns what it
// cut. In place because the caller owns a freshly parsed payload and the bag holds keys this module
// knows nothing about: rebuilding it from the fields listed here would drop the rest.
export function clampOversizedTextInPlace(settings: unknown): OversizedText[] {
  const out: OversizedText[] = [];
  for (const f of cappedFields(settings)) {
    if (f.value.length <= f.max) continue;
    // Trimmed first, because that is what the readers measure: a value over the cap only by the
    // whitespace in front of it loses nothing at runtime, and clipping the raw string would throw
    // away exactly as many real characters as there were spaces. Reported as clipped only when the
    // text itself is too long, so the import warning never names a field that kept every word.
    const text = f.value.trim();
    if (text.length <= f.max) {
      f.replace(text);
      continue;
    }
    out.push({ path: f.path, length: text.length, max: f.max });
    f.replace(clipText(text, f.max));
  }
  return out;
}
