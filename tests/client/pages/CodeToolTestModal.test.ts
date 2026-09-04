import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contextNamesUsedBy } from "@/client/pages/resources/CodeToolTestModal";
import { CONTEXT_VAR_NAMES } from "@/modules/tool-definitions/normalize";

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

// Round 27: the scan is a shortcut over arbitrary JavaScript, and these two spellings are ordinary
// rather than exotic. What the dialog owes is not seeing them, which no property scan can promise,
// but never being the reason a value cannot be supplied: the full list is one click away, and the
// scan only decides what the dialog OPENS with.
describe("what the scan cannot see", () => {
  const invisible = [
    "const { contact_email } = context;\nreturn contact_email;",
    "const c = context;\nreturn c.contact_email;",
  ];
  test("destructuring and aliases are missed, which is why the full list exists", () => {
    for (const code of invisible) {
      expect(contextNamesUsedBy(code)).toEqual([]);
    }
    // The escape hatch is the constant itself, so the dialog can always offer every name.
    expect(CONTEXT_VAR_NAMES).toContain("contact_email");
  });

  test("the dialog always offers the way out, whether or not the scan saw anything", () => {
    // A source fence, for the reason the fences in CodeToolEditModal.test.tsx give: what is being
    // asserted is that the button is not gated on the scan having found something.
    const src = readFileSync(
      "src/client/pages/resources/CodeToolTestModal.tsx",
      "utf8",
    );
    expect(src.includes("{!allContext && (")).toBe(true);
    expect(src.includes("? [...CONTEXT_VAR_NAMES]")).toBe(true);
  });
});
