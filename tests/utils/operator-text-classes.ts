// WHO READS EACH PIECE OF OPERATOR TEXT: the one registry two test files read, so a rename's surface
// and the fence over it cannot disagree (issue #604).
//
// The classes are about SITES of the walker in `src/modules/agents/text-caps.ts`, not about stored
// paths, because one site can write several paths: the `toolGuidance` loop writes one per native
// tool and the guardrails loop writes one per direction. A rename cannot treat two paths of one
// `add()` call differently, so collapsing them loses no resolution. `*` stands for one segment.

// Rewritten by a rename: the text is appended to a tool description or folded into a prompt handed
// to a model that can call tools, so a stale name there is a rule about a tool that does not exist.
export const MODEL_WITH_TOOLS = [
  "followUp.steps[*].instructions",
  "guardrails.customPolicy",
  // The walker writes this one inside its per-direction loop, under `if (dir === "output")`, so the
  // SITE carries the interpolation even though only one direction ever reaches it.
  "guardrails.*.generationPrompt",
  "handoff.instructions",
  "kanban.instructions",
  "toolGuidance.*",
];

// Reaches a model, but one that is handed no tools at all, so a tool name in it names nothing in
// either spelling (`src/modules/vision/service.ts` builds no toolset).
export const MODEL_WITHOUT_TOOLS = ["vision.extractionPrompt"];

// Read by a PERSON. `set_labels` means no more to a customer than `assign_label` did, so a rename
// here would edit a message a customer reads and fix nothing.
export const PERSON_FACING = [
  "availability.awayMessage",
  "contactAuth.denyMessage",
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
  "model_with_tools" | "person" | "not_prose"
> = {
  // The model receives these as the tool's description and as each argument's hint.
  "ToolDefinition.description": "model_with_tools",
  "CodeToolDefinition.description": "model_with_tools",
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
  ...MODEL_WITH_TOOLS,
  ...MODEL_WITHOUT_TOOLS,
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
): "model_with_tools" | "model_without_tools" | "person" | null {
  if (MODEL_WITH_TOOLS.some((s) => matchesSite(s, path)))
    return "model_with_tools";
  if (MODEL_WITHOUT_TOOLS.some((s) => matchesSite(s, path)))
    return "model_without_tools";
  if (PERSON_FACING.some((s) => matchesSite(s, path))) return "person";
  return null;
}
