// WHO READS EACH PIECE OF OPERATOR TEXT: the one registry two test files read, so a rename's surface
// and the fence over it cannot disagree (issue #604).
//
// The classes are about SITES of the walker in `src/modules/agents/text-caps.ts`, not about stored
// paths, because one site can write several paths: the `toolGuidance` loop writes one per native
// tool and the guardrails loop writes one per direction. A rename cannot treat two paths of one
// `add()` call differently, so collapsing them loses no resolution. `*` stands for one segment.

// Rewritten by a rename, because a tool name in this text MEANS the agent's toolset. That is the
// axis, and it is not "the reader has tools": four of these are read by the tool-calling model
// itself, and the two guardrail ones are read by a model that has none (`analyze.ts` calls
// `withStructuredOutput` and says so twice) yet are rules ABOUT what the agent may call, so a stale
// name there is a policy pointed at a tool that no longer exists. The round's blind holdout caught
// this: the first version of this file called the class `model_with_tools`, which was false for two
// of its six members.
export const NAMES_AGENT_TOOLS = [
  "followUp.steps[*].instructions",
  "guardrails.customPolicy",
  // The walker writes this one inside its per-direction loop, under `if (dir === "output")`, so the
  // SITE carries the interpolation even though only one direction ever reaches it.
  "guardrails.*.generationPrompt",
  "handoff.instructions",
  "kanban.instructions",
  "toolGuidance.*",
  // Issue #859: the notice the agent reads on an audio turn and the note on reply_as_text, both read
  // by the tool-calling model, where a tool name means the agent's toolset.
  "tts.spokenNoticeText",
  "tts.textChoiceNote",
];

// The sites of the class above that did not exist when the one rename migration so far ran
// (`20260909120000`, `assign_label` → `set_labels`): no row could have held the old name there, so
// that migration was right not to read them, and its test asks only for the sites it could meet. The
// NEXT rename of a native is written after them and has to cover them like the rest of the class.
export const NEWER_THAN_THE_LAST_RENAME = [
  "tts.spokenNoticeText",
  "tts.textChoiceNote",
];

// Reaches a model AND names nothing: the vision extraction prompt instructs a model that is handed
// no toolset (`src/modules/vision/service.ts`) to read an image, and it is not a rule about the
// agent's behaviour either, so a tool name in it means nothing in either spelling. This is what
// separates it from the two guardrail prompts above, which no `has tools` test can tell apart.
export const NO_TOOL_MEANING = ["vision.extractionPrompt"];

// Read by a PERSON. `set_labels` means no more to a customer than `assign_label` did, so a rename
// here would edit a message a customer reads and fix nothing.
export const PERSON_FACING = [
  "availability.awayMessage",
  "contactAuth.denyMessage",
  "guardrails.*.handoffMessage",
  "guardrails.*.templateMessage",
  "signature.text",
];

// PROSE THAT DOES NOT LIVE IN THE SETTINGS BAG. An HTTP or CODE tool definition is a row on its own
// table, so `text-caps.ts` knows nothing about it, and two of its columns are prose the MODEL reads:
// the tool's own description and the per-argument descriptions inside `input_schema`. Keyed by
// `<model>.<column>` because that is what the fence reads out of `prisma/schema.prisma`.
//
// Only the `String` columns of those two models are classified, not every column: a `Json` blob or a
// URL template is not prose, and a fence that demanded a decision about `appointment` would be a tax
// on unrelated work. A new STRING column on a tool definition is a prose candidate by default, which
// is the case worth stopping.
export const TOOL_COLUMNS: Record<
  string,
  "names_agent_tools" | "person" | "not_prose"
> = {
  // The model receives these as the tool's description and as each argument's hint.
  "ToolDefinition.description": "names_agent_tools",
  "CodeToolDefinition.description": "names_agent_tools",
  // The identifier and the display name the operator typed. NOT rewritten by a rename of a NATIVE
  // name: `20260903120000` already moved any tool that answered to a native's name, per tenant and
  // to a derived `<name>_N`, so there is no global replacement to make here.
  "ToolDefinition.name": "not_prose",
  "ToolDefinition.label": "not_prose",
  "CodeToolDefinition.name": "not_prose",
  "CodeToolDefinition.label": "not_prose",
  // The slow-tool acknowledgement, which the CUSTOMER reads.
  "ToolDefinition.ackMessage": "person",
  // Not prose at all: mechanics the model never reads as text.
  "ToolDefinition.method": "not_prose",
  "ToolDefinition.urlTemplate": "not_prose",
  "ToolDefinition.allowedHosts": "not_prose",
  "ToolDefinition.credentialRef": "not_prose",
  // The operator's code. The model is shown the description, never the body.
  "CodeToolDefinition.code": "not_prose",
};

export const CLASSIFIED = [
  ...NAMES_AGENT_TOOLS,
  ...NO_TOOL_MEANING,
  ...PERSON_FACING,
];

// A site pattern as a matcher: `*` stands for one path segment.
export function matchesSite(site: string, path: string): boolean {
  return new RegExp(
    `^${site.replace(/[.[\]]/g, "\\$&").replace(/\*/g, "[^.]+")}$`,
  ).test(path);
}

// Which class a stored path belongs to, or null when nothing claims it.
export function classOf(
  path: string,
): "names_agent_tools" | "no_tool_meaning" | "person" | null {
  if (NAMES_AGENT_TOOLS.some((s) => matchesSite(s, path)))
    return "names_agent_tools";
  if (NO_TOOL_MEANING.some((s) => matchesSite(s, path)))
    return "no_tool_meaning";
  if (PERSON_FACING.some((s) => matchesSite(s, path))) return "person";
  return null;
}
