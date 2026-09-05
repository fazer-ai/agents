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
      "The conversation's custom attributes, mirrored from Chatwoot and read when the tool is CALLED, so a value written earlier in the same turn is already here. Empty object when there are none.",
  },
  {
    name: "contactAttributes",
    type: "object",
    always: true,
    description:
      "The contact's custom attributes, on the same terms as conversationAttributes. Empty object when there are none.",
  },
];

// The names alone, for a caller that only needs the list.
export const CODE_TOOL_CONTEXT_NAMES: readonly string[] =
  CODE_TOOL_CONTEXT_VARS.map((v) => v.name);

// The interpolated half, which is the half that has to match the runtime's allowlist. The two bags
// are not in `CONTEXT_VAR_NAMES` because they are not interpolated into an HTTP tool's templates;
// they reach a code tool's `context` and nothing else.
export const CODE_TOOL_INTERPOLATED_NAMES: readonly string[] =
  CONTEXT_VAR_NAMES;
