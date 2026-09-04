import { describe, expect, test } from "bun:test";
import { contextNamesUsedBy } from "@/client/pages/resources/CodeToolTestModal";

// Round 25. The test dialog said it ran the body "exactly as the agent would" and then sent no
// `context` at all, so every advertised variable arrived `undefined`: a body reading
// `context.contact_name` was tested against a value the agent will never supply. The HTTP tool's
// dialog has always collected these — it asks `contextNamesReferencedBy` which `{{names}}` the
// template mentions and draws a field per name (ToolEditModal.tsx). This is the same question for a
// body: which of the runtime's names does this code actually read.
describe("contextNamesUsedBy", () => {
  const rows: Array<[string, string, string[]]> = [
    ["dot access", "return context.contact_name;", ["contact_name"]],
    [
      "bracket access, both quotes",
      `return [context["contact_email"], context['inbox_name']];`,
      ["contact_email", "inbox_name"],
    ],
    [
      "canonical order, not the order they appear",
      "return [context.agent_name, context.conversation_id];",
      ["conversation_id", "agent_name"],
    ],
    [
      "each name once",
      "context.contact_id; context.contact_id;",
      ["contact_id"],
    ],
    // Not a runtime name: the two attribute bags are objects, not strings, and no field can be
    // typed for them. A name the runtime does not expose is not invented either.
    [
      "only names the runtime exposes",
      "return [context.conversationAttributes, context.whatever, context.contact_id];",
      ["contact_id"],
    ],
    // The word has to be a WHOLE name: `contact_name_2` is somebody else's variable.
    [
      "not a prefix of a longer identifier",
      "return context.contact_name_2;",
      [],
    ],
    // A body that reads nothing asks for nothing, which is what keeps the dialog empty for the
    // ordinary tool.
    // Round 26: optional chaining is how a careful body reads a variable a turn may not have, so it
    // is the FIRST spelling to expect here, not an exotic one.
    [
      "optional chaining, dot and bracket",
      `return [context?.contact_email, context?.["inbox_name"]];`,
      ["contact_email", "inbox_name"],
    ],
    ["a body that reads no context", "return input.cpf.length;", []],
    ["something that is not code", "", []],
  ];
  for (const [name, code, want] of rows) {
    test(name, () => {
      expect(contextNamesUsedBy(code)).toEqual(want);
    });
  }
});
