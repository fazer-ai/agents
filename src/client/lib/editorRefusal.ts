import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";

// WHERE THE AGENT EDITOR DRAWS A VALUE THE SERVER CAN NAME, as one map.
//
// Two things ask this question and they used to answer it apart. A config-health warning holds a
// dotted path for a value already over its cap and wants a "Go to"; a refusal holds a dotted path for
// the value this save just carried and wants somewhere to put the sentence. Same question — which
// tab, which section — and keeping two lists is exactly how `availability.awayMessage` and
// `contactAuth.denyMessage` ended up in neither: both have a textarea on the Behavior tab, and a
// warning about either said "this note has no field in the console, so it can only be shortened
// through the API", which is false about a control two clicks away.
//
// The credential half is not restated here at all. `SETTINGS_CREDENTIAL_PATHS` already carries the
// editor location beside each path, for the import warning's deep link, and its own comment records
// why: deriving the location as "the behavior tab, section = block" was right for four entries and
// wrong for the fifth. Restating it would be a fourth copy of a list that has already been wrong
// three times.

export type EditorTab =
  | "general"
  | "behavior"
  | "guardrails"
  | "channelRedirect"
  | "tools";

export interface EditorTarget {
  tab: EditorTab;
  // The DOM anchor of the section to scroll to (matches the section's `id`). Absent for a value the
  // tab draws outside any section — the agent's name and prompt sit at the top of General.
  sectionId?: string;
}

// TWO SPELLINGS reach this map, because the two producers root their path differently and neither is
// wrong on its own:
//
//   `SettingsTextTooLongError`      -> `guardrails.customPolicy`        (root = the settings bag)
//   `assertCredentialRefsResolve`   -> `settings.tts.credentialRef`     (root = the agent row)
//
// Both are the server's own name for the same wire field. Normalising them is a contract change that
// reaches REST and MCP, so this map accepts both and the divergence is written down rather than
// papered over: fazer-ai/agents#349 measured it, and a reader who trusts one spelling silently loses
// half the fields.
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
      /^toolGuidance\.(set_custom_attribute|assign_label|update_kanban_task)$/,
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
  { match: /^followUp\.steps\[/, tab: "behavior", sectionId: "proactive" },
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

// The names the editor declares, by the tab that draws them.
//
// TAB-GATED, and only tab-gated, which is a decision rather than an omission. Several of these
// controls sit behind a switch inside their own section — the vision prompt appears with vision on,
// the deny message with the authorization gate on — so a list that answered "drawn right now" to the
// letter would carry a dozen booleans out of three component files and into this one, and every
// drift between them would reappear as the silence the mechanism exists to prevent.
//
// What makes the tab the right granularity is a property of the WRITE BOUNDARY, not a tolerance:
// both producers refuse only the text or the ref a write INTRODUCES or CHANGES
// (`collectOversizedTextChanges`, `collectCredentialRefWrites`, and both say so in their own
// comments, with the reason). Changing one of these values requires its control, and its control
// requires the switch. So a refusal naming a field whose switch is off cannot arrive from this
// editor, and the declaration is exact for every refusal that can. `tests/client/editor-refusal.
// test.ts` pins that invariant, because it is the thing this simplification rests on.
const TAB_FIELDS: Readonly<Record<EditorTab, readonly string[]>> = {
  general: ["name", "systemPrompt", "modelConfig.credentialRef"],
  behavior: [
    "settings.stt.credentialRef",
    "settings.tts.credentialRef",
    "settings.tts.normalizeCredentialRef",
    "settings.vision.credentialRef",
    "settings.contactAuth.credentialRef",
    "settings.memory.compaction.credentialRef",
    "availability.awayMessage",
    "contactAuth.denyMessage",
    "vision.extractionPrompt",
  ],
  guardrails: [
    "settings.guardrails.credentialRef",
    "guardrails.customPolicy",
    "guardrails.input.templateMessage",
    "guardrails.output.templateMessage",
    "guardrails.output.generationPrompt",
  ],
  tools: [
    "handoff.instructions",
    "kanban.instructions",
    "toolGuidance.set_custom_attribute",
    "toolGuidance.assign_label",
    "toolGuidance.update_kanban_task",
  ],
  // The redirect tab writes its own block through its own save and declares nothing here yet; the
  // knowledge and playground tabs draw no value the server refuses by name.
  channelRedirect: [],
};

// One follow-up step's note, by the name the server spells it with. Brackets and not dots, because
// that is what `collectOversizedTextChanges` reports and the wire carries it verbatim — the numeric
// segment rule in placeRefusal reads `steps.0`, which this is not.
export function followUpStepField(index: number): string {
  return `followUp.steps[${index}].instructions`;
}

// What the editor draws now, and everything it can mark. `drawn` is a subset of `owned`, always: the
// second is the first over every tab, which is what lets a refusal about another tab's control be
// held until the operator gets there.
export function editorRefusalFields(view: {
  // Any of the editor's tabs, not only the five that write an agent: the page also draws Channels,
  // Knowledge, Playground and Experiments, and each of those answers with an empty list. Typed wide
  // on purpose — narrowing it would make the caller decide which tabs count, which is this module's
  // question and not the page's.
  tab: string;
  // How many follow-up steps the Proactive section is showing. The note of a step that does not
  // exist is a name nothing can render, so the list stops where the editor's does.
  followUpSteps: number;
}): { drawn: readonly string[]; owned: readonly string[] } {
  const steps = Array.from(
    { length: Math.max(0, view.followUpSteps) },
    (_, i) => followUpStepField(i),
  );
  const forTab = (tab: string): string[] => [
    ...(TAB_FIELDS[tab as EditorTab] ?? []),
    ...(tab === "behavior" ? steps : []),
  ];
  return {
    drawn: forTab(view.tab),
    owned: Object.keys(TAB_FIELDS).flatMap(forTab),
  };
}
