import { CONTEXT_VAR_NAMES } from "@/modules/tool-definitions/normalize";

// What a code tool's body can reach, as DATA rather than as prose in three places.
//
// The same vocabulary was written out three times before this module existed: the help popover in
// the console, the description of `code_tool_create`, and `docs/graph.md`. Three copies of a list
// that the runtime builds in one place is three chances to drift, and the drift is silent because
// nothing reads prose. Now the console's completion offers these names, the MCP `code_tool_schema`
// tool serves them, and the popover renders them, so the three surfaces cannot disagree.
//
// IMPORT-FREE except for `normalize`, which is itself import-free: this reaches the browser bundle
// (tests/client/bundle-boundary.test.ts), so anything it pulls in reaches it too.

// A value the body reads off `context`, with the two things an operator needs before writing a line
// against it: what type it holds, and whether it is there at all.
export interface CodeToolContextVar {
  name: string;
  // Every interpolated context value is a STRING, including the ids. `contact_id` is
  // `String(chatwootContactId)`, so `context.contact_id === 123` is false for the contact numbered
  // 123 and `Number(context.contact_id)` is what compares. The two bags are the exception.
  type: "string" | "object";
  // ABSENT, not empty, when the source has no value: `httpToolContext` is built by spreading
  // conditionals (graph/prepare.ts), so a contact with no e-mail has no `contact_email` KEY. That is
  // why every one of these is written as optional and why the body reads them with `??`.
  always: boolean;
  description: string;
}

// The ten interpolated names, in the order `CONTEXT_VAR_NAMES` declares them, plus the two attribute
// bags the precondition loader reads at CALL time. The list is asserted against `CONTEXT_VAR_NAMES`
// by test, so a name added to the runtime's allowlist and not described here fails rather than
// quietly going undiscoverable.
export const CODE_TOOL_CONTEXT_VARS: readonly CodeToolContextVar[] = [
  {
    name: "conversation_id",
    type: "string",
    always: false,
    description:
      "Chatwoot conversation id. Absent when the tool runs outside a conversation (the playground, a test run).",
  },
  {
    name: "message_id",
    type: "string",
    always: false,
    description:
      "Chatwoot id of the message that triggered this turn. Absent outside a conversation.",
  },
  {
    name: "contact_id",
    type: "string",
    always: false,
    description: "Chatwoot contact id. Absent when the conversation has none.",
  },
  {
    name: "contact_name",
    type: "string",
    always: false,
    description: "The contact's name. Absent when the contact has none.",
  },
  {
    name: "contact_email",
    type: "string",
    always: false,
    description: "The contact's e-mail. Absent when the contact has none.",
  },
  {
    name: "contact_phone",
    type: "string",
    always: false,
    description: "The contact's phone. Absent when the contact has none.",
  },
  {
    name: "inbox_id",
    type: "string",
    always: false,
    description: "Chatwoot inbox id. Absent outside a conversation.",
  },
  {
    name: "inbox_name",
    type: "string",
    always: false,
    description: "The inbox's name. Absent when the inbox has none.",
  },
  {
    name: "company_name",
    type: "string",
    always: false,
    description: "The tenant's name. Absent when the tenant has none.",
  },
  {
    name: "agent_name",
    type: "string",
    always: true,
    description: "The agent's name. The one value that is always present.",
  },
  {
    name: "conversationAttributes",
    type: "object",
    always: true,
    description:
      "The conversation's custom attributes, mirrored from Chatwoot and read when the tool is CALLED, so a value set_custom_attribute wrote in an EARLIER step of the turn is already here. Not one written in the same step: the tool calls of a single model message run together, so those two race. Empty object when there are none.",
  },
  {
    name: "contactAttributes",
    type: "object",
    always: true,
    description:
      "The contact's custom attributes, on the same terms as conversationAttributes. Empty object when there are none.",
  },
];

// What the SANDBOX puts in scope, beyond the two parameters. Measured against the worker rather
// than assumed: `tests/graph/code-sandbox.test.ts` runs `Object.getOwnPropertyNames(globalThis)`
// inside it and asserts every name here is really there, so an advertised global that the sandbox
// stops installing fails instead of completing to a ReferenceError at call time.
//
// It is a CURATED subset, not the whole list: the interpreter also exposes `Float16Array`,
// `SharedArrayBuffer`, `escape` and two dozen others that nobody writing a twenty-line body reaches
// for, and a popup that lists them buries the four that are this sandbox's own.
export interface CodeToolGlobal {
  name: string;
  // `variable` for a value, `class` for a constructor, `function` for a callable: the three
  // `Completion.type` values CodeMirror draws a different icon for.
  kind: "variable" | "class" | "function";
  // Only for the four the sandbox itself installs. The standard library explains itself, and a
  // description per constructor is prose nobody reads and four locales to keep in step.
  description?: string;
}

export const CODE_TOOL_GLOBALS: readonly CodeToolGlobal[] = [
  {
    name: "TIMEZONE",
    kind: "variable",
    description: "The agent's IANA time zone, as a string.",
  },
  {
    name: "NOW_LOCAL",
    kind: "variable",
    description:
      "The moment the call started, in the agent's zone, as an ISO string.",
  },
  {
    name: "console",
    kind: "variable",
    description:
      "log, warn, error, info and debug. What they print reaches the agent as the Output block, after the returned value.",
  },
  {
    name: "Date",
    kind: "class",
    description:
      "Runs in the agent's zone rather than UTC, so `new Date().getHours()` is the hour where the agent is.",
  },
  { name: "JSON", kind: "variable" },
  { name: "Math", kind: "variable" },
  { name: "Object", kind: "class" },
  { name: "Array", kind: "class" },
  { name: "String", kind: "class" },
  { name: "Number", kind: "class" },
  { name: "Boolean", kind: "class" },
  { name: "RegExp", kind: "class" },
  { name: "Map", kind: "class" },
  { name: "Set", kind: "class" },
  { name: "Error", kind: "class" },
  { name: "parseInt", kind: "function" },
  { name: "parseFloat", kind: "function" },
  { name: "isNaN", kind: "function" },
  { name: "encodeURIComponent", kind: "function" },
  { name: "decodeURIComponent", kind: "function" },
];

// The names alone, for a caller that only needs the list.
export const CODE_TOOL_CONTEXT_NAMES: readonly string[] =
  CODE_TOOL_CONTEXT_VARS.map((v) => v.name);

// The interpolated half, which is the half that has to match the runtime's allowlist. The two bags
// are not in `CONTEXT_VAR_NAMES` because they are not interpolated into an HTTP tool's templates;
// they reach a code tool's `context` and nothing else.
export const CODE_TOOL_INTERPOLATED_NAMES: readonly string[] =
  CONTEXT_VAR_NAMES;
