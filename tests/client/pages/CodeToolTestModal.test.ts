import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  contextNamesUsedBy,
  contextToSend,
} from "@/client/pages/resources/CodeToolTestModal";
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

// A blank box means "the turn did not have it", which is the case a body has to survive, EXCEPT for
// the one variable a turn always has. `httpToolContext` spreads `agent_name` unconditionally and
// the vocabulary says `always: true` on that basis, so a body may read it without a `??`. A dialog
// that can omit it simulates a turn that cannot happen and fails a body the runtime never fails.
describe("what the dialog sends", () => {
  test("a blank box is an ABSENT variable, for everything that can be absent", () => {
    expect(
      contextToSend(
        { contact_name: "Maria", contact_email: "" },
        ["contact_name", "contact_email", "inbox_name"],
        "Agent",
      ),
      // `agent_name` rides along on every send, scanned or not: the two tests below say why.
    ).toEqual({ contact_name: "Maria", agent_name: "Agent" });
  });

  test("agent_name is never absent: blank sends the default", () => {
    expect(contextToSend({ agent_name: "" }, ["agent_name"], "Agent")).toEqual({
      agent_name: "Agent",
    });
    expect(contextToSend({}, ["agent_name"], "Agente")).toEqual({
      agent_name: "Agente",
    });
    // What the operator typed still wins over the default.
    expect(
      contextToSend({ agent_name: "Sofia" }, ["agent_name"], "Agent"),
    ).toEqual({ agent_name: "Sofia" });
  });

  // The list is the one the dialog drew, so a variable it never asked about is not sent either.
  // `agent_name` is the one exception, and the test below is why.
  test("a name outside the collected list is not invented", () => {
    expect(contextToSend({ inbox_id: "7" }, ["contact_name"], "Agent")).toEqual(
      {
        agent_name: "Agent",
      },
    );
  });

  // The list is a SCAN of the body, and the scan reads member access. A body that destructures
  // (`const { agent_name } = context`) or aliases (`const c = context`) names nothing the regex can
  // see, so `names` comes back empty and the fallback inside the loop never ran: the dialog tested
  // a turn without `agent_name`, which is a turn that cannot happen, and failed a body the runtime
  // would have served. The guarantee belongs to the runtime, not to the scanner's eyesight.
  test("agent_name survives a body whose read the scan cannot see", () => {
    expect(contextNamesUsedBy("const { agent_name } = context;")).toEqual([]);
    expect(contextToSend({}, [], "Agente")).toEqual({ agent_name: "Agente" });
    // And what the operator typed still wins, even with the box off screen.
    expect(contextToSend({ agent_name: "Sofia" }, [], "Agente")).toEqual({
      agent_name: "Sofia",
    });
  });
});
