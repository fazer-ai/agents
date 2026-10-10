import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";

// WHERE THE AGENT EDITOR DRAWS A VALUE THE SERVER CAN NAME, as one map. A config-health warning
// wants a "Go to" for a value over its cap, and a refusal wants somewhere to put the sentence; one
// map answers both, because two lists drift and then say "no field in the console" about a control
// two clicks away. The credential half is not restated: `SETTINGS_CREDENTIAL_PATHS` already carries
// the editor location beside each path, and a copy here would drift from it.

// The native-tool notes the console draws no control for. `toolGuidance` takes one for all thirteen
// tools in NATIVE_TOOL_NAMES and the editor renders three, so this set is closed and derivable,
// which is what makes it safe to TELL the operator a value can only be changed through the API.
// Absence from the target map proves nothing about the console, so that claim is never read off it.
export const UNDRAWN_TOOL_NOTES: readonly string[] = NATIVE_TOOL_NAMES.filter(
  (n) =>
    !["set_custom_attribute", "set_labels", "update_kanban_task"].includes(n),
).map((n) => `toolGuidance.${n}`);

// Whether the console really has no control for a value the server named, said only where it can be
// proved rather than inferred from this map having no entry.
export function hasNoConsoleControl(field: string): boolean {
  return UNDRAWN_TOOL_NOTES.includes(field.replace(/^settings\./, ""));
}

export type EditorTab =
  | "general"
  | "decisions"
  | "behavior"
  | "guardrails"
  | "channelRedirect"
  | "tools"
  | "knowledge";

export interface EditorTarget {
  tab: EditorTab;
  // The DOM anchor of the section to scroll to (matches the section's `id`). Absent for a value the
  // tab draws outside any section — the agent's name and prompt sit at the top of General.
  sectionId?: string;
}

// TWO SPELLINGS reach this map, because the two producers root their path differently:
//   `SettingsTextTooLongError`      -> `guardrails.customPolicy`        (root = the settings bag)
//   `assertCredentialRefsResolve`   -> `settings.tts.credentialRef`     (root = the agent row)
// Both are the server's own name for the same wire field, and normalising them is a contract change
// that reaches REST and MCP, so this map accepts both: a reader trusting one spelling loses half.
const SETTINGS_PREFIX = "settings.";

// Matched by pattern, because three of these families are open-ended: a guardrails direction holds
// two capped fields, and a follow-up step is one of ten. A path with no entry has no control in the
// editor at all — `toolGuidance` accepts a note for all thirteen native tools and the console draws
// three — and those must keep answering "there is nowhere to send you" rather than offering a jump
// to a section that will not scroll.
const TEXT_TARGETS: ReadonlyArray<{ match: RegExp } & EditorTarget> = [
  { match: /^handoff\.instructions$/, tab: "tools", sectionId: "tools-native" },
  { match: /^kanban\.instructions$/, tab: "tools", sectionId: "tools-native" },
  {
    match:
      /^toolGuidance\.(set_custom_attribute|set_labels|update_kanban_task)$/,
    tab: "tools",
    sectionId: "tools-native",
  },
  {
    match: /^availability\.awayMessage$/,
    tab: "behavior",
    sectionId: "availability",
  },
  {
    match: /^contactAuth\.denyMessage$/,
    tab: "behavior",
    sectionId: "contactAuth",
  },
  {
    match: /^guardrails\.customPolicy$/,
    tab: "guardrails",
    sectionId: "gr-policy",
  },
  { match: /^guardrails\.input\./, tab: "guardrails", sectionId: "gr-input" },
  { match: /^guardrails\.output\./, tab: "guardrails", sectionId: "gr-output" },
  { match: /^vision\.extractionPrompt$/, tab: "behavior", sectionId: "vision" },
  {
    match: /^tts\.(spokenNoticeText|textChoiceNote)$/,
    tab: "behavior",
    sectionId: "tts",
  },
  { match: /^followUp\.steps\[/, tab: "behavior", sectionId: "proactive" },
  // Not text caps: the other refusals an agent write names by a settings path, here so a refusal
  // about one can take the operator to it. Without an entry the banner would say "no control in the
  // console" about a picker that is on screen.
  {
    match: /^modelFallback\.model$/,
    tab: "behavior",
    sectionId: "modelFallback",
  },
  {
    match: /^observability\.fullDetailUntil$/,
    tab: "behavior",
    sectionId: "observability",
  },
  // The decision setup of a monitoring agent: the engine choice and the Classifier on General, the
  // questions, rules and rehearsal-or-live on their own tab. The block is a list, marked field by
  // field from the path itself (DecisionsFields), so it is targeted here and not owned.
  {
    match: /^monitoring\.engine$/,
    tab: "general",
    sectionId: "general-engine",
  },
  {
    match: /^monitoring\.decisions\.(provider|model|credentialRef)$/,
    tab: "general",
    sectionId: "general-classifier",
  },
  {
    match: /^monitoring\.decisions(\.|$)/,
    tab: "decisions",
    sectionId: "decisions-questions",
  },
  // TARGETED AND NOT OWNED, all three of them, which is a distinction this map makes on purpose.
  // Owning a name means marking a control with the server's sentence, and that needs one box holding
  // one value: the tool preconditions are edited as a list rather than a control per tool, the
  // fallback model comes out of a picker whose value the wire does not carry verbatim, and the
  // observability window is a datetime. Targeting is the weaker and honest claim -- here is where
  // that value is edited -- and it is all the banner needs to offer a way there.
  {
    match: /^toolPreconditions\./,
    tab: "tools",
    sectionId: "tools-preconditions",
  },
];

// The values the editor draws a control for OUTSIDE any bag: the two on the General tab plus the
// model's key, which is a column of its own and so has neither producer's prefix.
const COLUMN_TARGETS: Readonly<Record<string, EditorTarget>> = {
  name: { tab: "general" },
  systemPrompt: { tab: "general" },
  "modelConfig.credentialRef": { tab: "general", sectionId: "general-model" },
};

const CREDENTIAL_TARGETS: Readonly<Record<string, EditorTarget>> =
  Object.fromEntries(
    SETTINGS_CREDENTIAL_PATHS.map((p) => [
      `${SETTINGS_PREFIX}${p.path.join(".")}`,
      { tab: p.tab, sectionId: p.sectionId },
    ]),
  );

// Where the editor draws the value the server named, or null when it draws no control for it.
//
// `guardrailsEnabled` is not a refinement, it is the difference between a jump that works and one
// that silently does nothing: `GuardrailsTab` renders `gr-input`, `gr-output` and `gr-policy` only
// while guardrails are ON, so with them off the anchor is not in the DOM and the one-shot lookup
// that scrolls finds nothing. `gr-model` is the section that is always mounted, and it holds the
// switch that brings the rest back.
export function editorTargetFor(
  field: string,
  opts: { guardrailsEnabled?: boolean } = {},
): EditorTarget | null {
  const column = COLUMN_TARGETS[field] ?? CREDENTIAL_TARGETS[field];
  const target =
    column ??
    (() => {
      // The credential producer prefixes; the text producer does not. Try the bag-rooted spelling
      // both as sent and with the prefix taken off, so a path arriving either way lands here.
      const bagPath = field.startsWith(SETTINGS_PREFIX)
        ? field.slice(SETTINGS_PREFIX.length)
        : field;
      const hit = TEXT_TARGETS.find((t) => t.match.test(bagPath));
      return hit ? { tab: hit.tab, sectionId: hit.sectionId } : null;
    })();
  if (!target) return null;
  if (target.tab === "guardrails" && !opts.guardrailsEnabled) {
    return { tab: "guardrails", sectionId: "gr-model" };
  }
  return target;
}

// WHICH SWITCH HAS TO BE ON for a control to be in the DOM, asked per control rather than per tab.
// A refusal can only arrive for a control that is drawn, but the operator can then turn its switch
// off (Vision, with its credential refusal standing), leaving the mark on an undrawn control with no
// banner because the tab is still open: silence, the one outcome barred here. The answer is a name
// the caller reads off its own state.
export interface EditorControlsShown {
  // Any of the editor's tabs, not only the five that write an agent: the page also draws Channels,
  // Knowledge, Playground and Experiments, and each of those answers with an empty list.
  tab: string;
  awayEnabled: boolean;
  sttEnabled: boolean;
  // TTS has no boolean: any mode other than "never" means audio replies are on.
  ttsOn: boolean;
  ttsNormalize: boolean;
  // Each of the two TTS texts (the spoken notice, the text choice) sits behind audio being on AND its
  // own switch, which is one name here because a field can only need one.
  ttsSpokenNoticeShown: boolean;
  ttsTextChoiceShown: boolean;
  visionEnabled: boolean;
  // The gate's two groups of controls are drawn under different conditions: the deny copy only on an
  // agent that answers, the endpoint's credential wherever the endpoint switch is on, watcher included.
  contactAuthEnabled: boolean;
  contactAuthEndpointShown: boolean;
  memoryCompactionEnabled: boolean;
  // The fallback's credential picker appears once a provider is chosen, not behind a switch.
  modelFallbackChosen: boolean;
  // The decisions engine's fields, its API key among them, are drawn for a monitoring agent whose
  // engine is `decisions`.
  decisionsEngineShown: boolean;
  guardrailsEnabled: boolean;
  followUpEnabled: boolean;
  // How many follow-up steps the Proactive section is showing. The note of a step that does not
  // exist is a name nothing can render, so the list stops where the editor's does.
  followUpSteps: number;
}

type SwitchName = Exclude<keyof EditorControlsShown, "tab" | "followUpSteps">;

// The switch each credential picker sits behind, by the path the server refuses it under. Keyed by
// path and looked up rather than listed alongside, so a credential added to
// `SETTINGS_CREDENTIAL_PATHS` is OWNED by construction and the server cannot refuse a field the
// editor neither marks nor announces. A path with no entry here is treated as NOT drawn, which costs
// a banner beside a visible control at worst; the reverse default costs silence.
const CREDENTIAL_SWITCH: Readonly<Record<string, SwitchName>> = {
  "stt.credentialRef": "sttEnabled",
  "tts.credentialRef": "ttsOn",
  "tts.normalizeCredentialRef": "ttsNormalize",
  "vision.credentialRef": "visionEnabled",
  "contactAuth.credentialRef": "contactAuthEndpointShown",
  "memory.compaction.credentialRef": "memoryCompactionEnabled",
  "modelFallback.credentialRef": "modelFallbackChosen",
  "monitoring.decisions.credentialRef": "decisionsEngineShown",
  "guardrails.credentialRef": "guardrailsEnabled",
};

interface OwnedField {
  field: string;
  tab: EditorTab;
  // Absent means the control is drawn whenever its tab is open.
  needs?: SwitchName;
}

const OWNED_FIELDS: readonly OwnedField[] = [
  { field: "name", tab: "general" },
  { field: "systemPrompt", tab: "general" },
  { field: "modelConfig.credentialRef", tab: "general" },
  ...SETTINGS_CREDENTIAL_PATHS.map((p) => {
    const joined = p.path.join(".");
    const needs = CREDENTIAL_SWITCH[joined];
    return {
      field: `${SETTINGS_PREFIX}${joined}`,
      tab: p.tab as EditorTab,
      ...(needs ? { needs } : {}),
    };
  }),
  { field: "availability.awayMessage", tab: "behavior", needs: "awayEnabled" },
  {
    field: "contactAuth.denyMessage",
    tab: "behavior",
    needs: "contactAuthEnabled",
  },
  {
    field: "vision.extractionPrompt",
    tab: "behavior",
    needs: "visionEnabled",
  },
  {
    field: "tts.spokenNoticeText",
    tab: "behavior",
    needs: "ttsSpokenNoticeShown",
  },
  {
    field: "tts.textChoiceNote",
    tab: "behavior",
    needs: "ttsTextChoiceShown",
  },
  {
    field: "guardrails.customPolicy",
    tab: "guardrails",
    needs: "guardrailsEnabled",
  },
  {
    field: "guardrails.input.templateMessage",
    tab: "guardrails",
    needs: "guardrailsEnabled",
  },
  {
    field: "guardrails.output.templateMessage",
    tab: "guardrails",
    needs: "guardrailsEnabled",
  },
  {
    field: "guardrails.input.handoffMessage",
    tab: "guardrails",
    needs: "guardrailsEnabled",
  },
  {
    field: "guardrails.output.handoffMessage",
    tab: "guardrails",
    needs: "guardrailsEnabled",
  },
  {
    field: "guardrails.output.generationPrompt",
    tab: "guardrails",
    needs: "guardrailsEnabled",
  },
  // The native-tool notes carry no switch of their own: the row is drawn from the catalog, and a note
  // for a tool nobody granted holds the stored text either way.
  { field: "handoff.instructions", tab: "tools" },
  { field: "kanban.instructions", tab: "tools" },
  { field: "toolGuidance.set_custom_attribute", tab: "tools" },
  { field: "toolGuidance.set_labels", tab: "tools" },
  { field: "toolGuidance.update_kanban_task", tab: "tools" },
];

// One follow-up step's note, by the name the server spells it with. Brackets and not dots, because
// that is what `collectOversizedTextChanges` reports and the wire carries it verbatim -- the numeric
// segment rule in placeRefusal reads `steps.0`, which this is not.
export function followUpStepField(index: number): string {
  return `followUp.steps[${index}].instructions`;
}

// What the editor is DRAWING right now, and everything it can mark.
//
// `drawn` is what decides whether a mark is readable, so it answers per control and not per tab.
// `owned` is every name across every tab, which is what lets a refusal about a control the operator
// cannot see right now be HELD until they can. drawn is a subset of owned, always.
export function editorRefusalFields(view: EditorControlsShown): {
  drawn: readonly string[];
  owned: readonly string[];
} {
  const steps = Array.from(
    { length: Math.max(0, view.followUpSteps) },
    (_, i) => followUpStepField(i),
  );
  const owned = [...OWNED_FIELDS.map((f) => f.field), ...steps];
  const drawn = [
    ...OWNED_FIELDS.filter(
      (f) => f.tab === view.tab && (!f.needs || view[f.needs]),
    ).map((f) => f.field),
    ...(view.tab === "behavior" && view.followUpEnabled ? steps : []),
  ];
  return { drawn, owned };
}

// WHAT A WRITE CARRIED, by the server's names, read from the patch about to be sent and NOT from
// what the editor draws: `drawn` is whether a MARK CAN BE READ, `sent` is what the REQUEST PUT ON
// THE WIRE, and they disagree by construction (`buildSettings()` serializes the whole bag, blocks
// switched off included). A carried field this omits gets no staleness check (`placeRefusal` marks
// the box without comparing, under a value the operator may have changed), and a later successful
// save would fail to clear that mark, because the clear asks this map too.
export function sentFromPatch(
  patch: Record<string, unknown>,
  owned: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of owned) {
    const found = readPatchPath(patch, field);
    if (found.present) out[field] = found.value;
  }
  return out;
}

// The value a refused name has inside a patch, and whether the patch carries it at all.
//
// Both spellings land in the same bag: `settings.tts.credentialRef` names the agent row and
// `guardrails.customPolicy` names the settings bag, and the only names that live OUTSIDE `settings`
// are the row's own columns. Absence is answered separately from an undefined value, because
// "the write did not mention this" and "the write sent nothing here" are different facts and only
// the first one means there is nothing to compare against.
function readPatchPath(
  patch: Record<string, unknown>,
  field: string,
): { present: boolean; value: unknown } {
  const column = field === "name" || field === "systemPrompt";
  const root = column
    ? patch
    : field.startsWith("modelConfig.")
      ? patch.modelConfig
      : patch.settings;
  const path = column
    ? [field]
    : field
        .replace(/^settings\./, "")
        .replace(/^modelConfig\./, "")
        // `followUp.steps[2].instructions` is the server's spelling; the index is a step of the walk.
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".");
  let node: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const step = path[i] as string;
    if (!node || typeof node !== "object")
      return { present: false, value: undefined };
    const bag = node as Record<string, unknown>;
    if (!Object.hasOwn(bag, step)) return { present: false, value: undefined };
    node = bag[step];
  }
  return { present: true, value: node };
}
