import { describe, expect, test } from "bun:test";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { AppError } from "@/lib/errors";
import { assertSettingsToolPreconditions } from "@/modules/agents/service";
import {
  evaluatePrecondition,
  invalidToolPreconditions,
  isGuardableToolName,
  readToolPreconditions,
  unmetPreconditionMessage,
} from "@/modules/agents/tool-preconditions";

// The state a precondition reads. Kept in one place so a test that adds a field has to say what the
// field means for every kind of condition.
const EMPTY = {
  conversationAttributes: {},
  contactAttributes: {},
};

describe("readToolPreconditions", () => {
  test("reads a map keyed by tool name", () => {
    expect(
      readToolPreconditions({
        toolPreconditions: {
          handoff_to_human: {
            kind: "attribute",
            scope: "conversation",
            key: "article_url",
          },
        },
      }),
    ).toEqual({
      handoff_to_human: {
        kind: "attribute",
        scope: "conversation",
        key: "article_url",
      },
    });
  });

  // The write boundary refuses a non-native name (isGuardableToolName); the RUNTIME reader does not,
  // and the asymmetry is deliberate. An agent import copies a settings bag verbatim, so such an entry
  // can exist without ever passing the write boundary, and dropping it here would remove a guard
  // whose name still matches a tool. What the seam adds is a report when it matches nothing.
  test("accepts a custom (non-native) tool name, because the seam is name-keyed", () => {
    const read = readToolPreconditions({
      toolPreconditions: {
        create_invoice: { kind: "attribute", scope: "contact", key: "cpf" },
      },
    });
    expect(read.create_invoice).toEqual({
      kind: "attribute",
      scope: "contact",
      key: "cpf",
    });
  });

  test.each([
    ["not an object", { toolPreconditions: "nope" }],
    ["an array", { toolPreconditions: [] }],
    ["absent", {}],
    ["settings not an object", "nope"],
  ])("drops %s", (_label, settings) => {
    expect(readToolPreconditions(settings)).toEqual({});
  });

  test.each([
    ["an unknown kind", { kind: "whatever" }],
    ["a missing kind", { key: "cpf", scope: "contact" }],
    ["attribute with no key", { kind: "attribute", scope: "contact" }],
    [
      "attribute with a blank key",
      { kind: "attribute", scope: "contact", key: "  " },
    ],
    [
      "attribute with an unknown scope",
      { kind: "attribute", scope: "moon", key: "cpf" },
    ],
    ["null", null],
    ["a string", "cpf"],
  ])("drops a condition that is %s", (_label, cond) => {
    expect(
      readToolPreconditions({ toolPreconditions: { handoff_to_human: cond } }),
    ).toEqual({});
  });

  test("one bad condition does not drop a good sibling", () => {
    const read = readToolPreconditions({
      toolPreconditions: {
        handoff_to_human: { kind: "nope" },
        create_invoice: { kind: "attribute", scope: "contact", key: "cpf" },
      },
    });
    expect(Object.keys(read)).toEqual(["create_invoice"]);
  });
});

describe("evaluatePrecondition: attribute", () => {
  const cond = {
    kind: "attribute",
    scope: "conversation",
    key: "article_url",
  } as const;

  test("unmet when the bag has no such key", () => {
    expect(evaluatePrecondition(cond, EMPTY)).toBe(false);
  });

  test("met when the key carries a value", () => {
    expect(
      evaluatePrecondition(cond, {
        ...EMPTY,
        conversationAttributes: {
          article_url: "https://financefootball.com/x",
        },
      }),
    ).toBe(true);
  });

  test.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["undefined", undefined],
  ])("unmet when the value is %s", (_label, value) => {
    expect(
      evaluatePrecondition(cond, {
        ...EMPTY,
        conversationAttributes: { article_url: value },
      }),
    ).toBe(false);
  });

  test.each([
    ["a number", 42],
    ["false", false],
    ["zero", 0],
  ])(
    "met when the value is %s, because present is present",
    (_label, value) => {
      expect(
        evaluatePrecondition(cond, {
          ...EMPTY,
          conversationAttributes: { article_url: value },
        }),
      ).toBe(true);
    },
  );

  test("reads the scope it was given, not the other bag", () => {
    const state = {
      ...EMPTY,
      contactAttributes: { article_url: "https://financefootball.com/x" },
    };
    expect(evaluatePrecondition(cond, state)).toBe(false);
    expect(evaluatePrecondition({ ...cond, scope: "contact" }, state)).toBe(
      true,
    );
  });

  test("equals compares the value, trimmed, as a string", () => {
    const withEquals = { ...cond, equals: "gold" } as const;
    expect(
      evaluatePrecondition(withEquals, {
        ...EMPTY,
        conversationAttributes: { article_url: " gold " },
      }),
    ).toBe(true);
    expect(
      evaluatePrecondition(withEquals, {
        ...EMPTY,
        conversationAttributes: { article_url: "silver" },
      }),
    ).toBe(false);
  });
});

describe("unmetPreconditionMessage", () => {
  test("names the tool, the attribute and its scope, for the model to act on", () => {
    const msg = unmetPreconditionMessage("create_invoice", {
      kind: "attribute",
      scope: "contact",
      key: "cpf",
    });
    expect(msg).toContain("create_invoice");
    expect(msg).toContain("cpf");
    expect(msg).toContain("contact");
  });

  test("names the required value when the condition has one", () => {
    const msg = unmetPreconditionMessage("create_invoice", {
      kind: "attribute",
      scope: "conversation",
      key: "plan",
      equals: "gold",
    });
    expect(msg).toContain("gold");
  });
});

describe("invalidToolPreconditions", () => {
  test("nothing to report when the bag is absent", () => {
    expect(invalidToolPreconditions({})).toEqual([]);
  });

  test("names each entry that does not parse", () => {
    expect(
      invalidToolPreconditions({
        toolPreconditions: {
          private_note: { kind: "attribute", scope: "contact", key: "cpf" },
          assign_label: { kind: "nope" },
          send_image: { kind: "attribute", scope: "moon", key: "cpf" },
        },
      }),
    ).toEqual(["assign_label", "send_image"]);
  });

  test("a bag of the wrong shape is ONE refusal, because there are no names", () => {
    expect(invalidToolPreconditions({ toolPreconditions: [] })).toEqual([
      "toolPreconditions",
    ]);
  });

  // Round 5 of PR #378: the key was not checked at all, only the value. Every case below parses as a
  // perfectly good condition and names something the runtime will never match, so the API answered
  // 200 on a rule that guards nothing and the tool the operator meant to fence kept running.
  describe("the KEY is a tool name, and it is checked", () => {
    const good = { kind: "attribute", scope: "contact", key: "cpf" } as const;

    test("a padded name is refused, not trimmed", () => {
      // Trimming would be the repair, and the repair is wrong here: ` handoff_to_human ` and
      // `handoff_to_human` are different keys in the stored bag, so a save that silently canonicalized
      // one onto the other could overwrite a rule the operator did not open.
      expect(
        invalidToolPreconditions({
          toolPreconditions: { " handoff_to_human ": good },
        }),
      ).toEqual([" handoff_to_human "]);
    });

    test("the empty name is refused", () => {
      expect(
        invalidToolPreconditions({ toolPreconditions: { "": good } }),
      ).toEqual([""]);
    });

    test("an MCP name is refused: its exposed form is not stable identity", () => {
      // `mcp__<slug>__<tool>` where the slug falls back to the connection id, and an import recreates
      // the connection under a different one. The rule would survive the import and match nothing.
      expect(
        invalidToolPreconditions({
          toolPreconditions: { mcp__crm__create_deal: good },
        }),
      ).toEqual(["mcp__crm__create_deal"]);
    });

    test("every name in the native catalog is accepted", () => {
      // Asserted over the CATALOG rather than a hand-written list: a native tool added later must be
      // guardable the day it ships, and a hardcoded list here would pass while the console offered a
      // name the API refused.
      const bag: Record<string, unknown> = {};
      for (const n of NATIVE_TOOL_NAMES) bag[n] = good;
      expect(invalidToolPreconditions({ toolPreconditions: bag })).toEqual([]);
    });

    test("isGuardableToolName agrees with the catalog, both ways", () => {
      for (const n of NATIVE_TOOL_NAMES)
        expect(isGuardableToolName(n)).toBe(true);
      for (const n of ["", " ", "create_invoice", "mcp__a__b", "__proto__"]) {
        expect(isGuardableToolName(n)).toBe(false);
      }
    });
  });
});

describe("assertSettingsToolPreconditions", () => {
  const good = { kind: "attribute", scope: "contact", key: "cpf" };

  test("accepts a valid bag", () => {
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { handoff_to_human: good } },
        undefined,
      ),
    ).not.toThrow();
  });

  test("refuses a new invalid entry, naming the tool as the field", () => {
    try {
      assertSettingsToolPreconditions(
        { toolPreconditions: { handoff_to_human: { kind: "nope" } } },
        undefined,
      );
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.field).toBe("toolPreconditions.handoff_to_human");
    }
  });

  test("does NOT refuse an invalid entry that was already stored", () => {
    // The operator came to edit something else. Making them fix a rule they did not touch refuses a
    // field they are not looking at, and the change they DID make is what the refusal blocks.
    const stored = { toolPreconditions: { legacy: { kind: "nope" } } };
    expect(() =>
      assertSettingsToolPreconditions(
        {
          toolPreconditions: {
            legacy: { kind: "nope" },
            private_note: good,
          },
        },
        stored,
      ),
    ).not.toThrow();
  });

  test("refuses when a stored-valid entry is edited into an invalid one", () => {
    const stored = { toolPreconditions: { handoff_to_human: good } };
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { handoff_to_human: { kind: "attribute" } } },
        stored,
      ),
    ).toThrow();
  });
});

// Findings from review round 1 of PR #378. Each one is a way the rule was weaker than it read.
describe("round 1: a condition that would be silently weaker is refused", () => {
  test.each([
    ["a number", 42],
    ["a boolean", true],
    ["an object", { v: "x" }],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])(
    "refuses the whole condition when `equals` is %s, instead of dropping it",
    (_label, equals) => {
      // Dropping `equals` would turn "the attribute must be X" into "the attribute must exist",
      // which is a weaker rule than the operator wrote — and weaker in silence.
      const settings = {
        toolPreconditions: {
          t: { kind: "attribute", scope: "contact", key: "k", equals },
        },
      };
      expect(readToolPreconditions(settings)).toEqual({});
      expect(invalidToolPreconditions(settings)).toEqual(["t"]);
    },
  );

  test("an absent `equals` still means ANY value", () => {
    expect(
      readToolPreconditions({
        toolPreconditions: {
          t: { kind: "attribute", scope: "contact", key: "k" },
        },
      }).t,
    ).toEqual({ kind: "attribute", scope: "contact", key: "k" });
  });
});

describe("round 1: tool names are operator text, so the map has no prototype", () => {
  test("a rule named `__proto__` is stored as an entry, not as a prototype", () => {
    // Built through JSON.parse on purpose: an object LITERAL with `__proto__` sets the prototype of
    // the literal itself, so it cannot express the input this guards against. Production reads this
    // bag as parsed JSON out of Postgres, which is exactly the shape below.
    const read = readToolPreconditions(
      JSON.parse(
        '{"toolPreconditions":{"__proto__":{"kind":"attribute","scope":"contact","key":"k"}}}',
      ),
    );
    expect(Object.hasOwn(read, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(read)).toBe(null);
  });

  test("a tool named `toString` inherits nothing when it has no rule", () => {
    const read = readToolPreconditions({
      toolPreconditions: {
        other: { kind: "attribute", scope: "contact", key: "k" },
      },
    });
    // On a plain object this is a function, and a truthy one — every call to a tool with that name
    // would be refused by a rule nobody wrote.
    expect(read.toString).toBeUndefined();
    expect(read.constructor).toBeUndefined();
  });
});

describe("round 1: a stored-invalid entry is exempt only while it does not CHANGE", () => {
  test("refuses rewriting one invalid entry into a DIFFERENT invalid entry", () => {
    const stored = { toolPreconditions: { t: { kind: "nope" } } };
    expect(() =>
      assertSettingsToolPreconditions(
        {
          toolPreconditions: {
            t: { kind: "attribute", scope: "moon", key: "k" },
          },
        },
        stored,
      ),
    ).toThrow();
  });

  test("still accepts the byte-identical stored entry riding along untouched", () => {
    const stored = { toolPreconditions: { t: { kind: "nope" } } };
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { t: { kind: "nope" } } },
        stored,
      ),
    ).not.toThrow();
  });
});

describe("round 2: the attribute key is operator text too", () => {
  test.each(["constructor", "toString", "__proto__", "valueOf"])(
    "an absent attribute named `%s` does NOT satisfy a presence rule",
    (key) => {
      // On an ordinary bag parsed from jsonb these all resolve to something non-blank, so the guard
      // would read as satisfied on a conversation where the attribute was never set — the tool runs
      // exactly where the operator asked for it not to.
      expect(
        evaluatePrecondition(
          { kind: "attribute", scope: "conversation", key },
          { conversationAttributes: {}, contactAttributes: {} },
        ),
      ).toBe(false);
    },
  );

  test("an attribute genuinely named `constructor` still satisfies it", () => {
    expect(
      evaluatePrecondition(
        { kind: "attribute", scope: "conversation", key: "constructor" },
        {
          conversationAttributes: JSON.parse('{"constructor":"acme"}'),
          contactAttributes: {},
        },
      ),
    ).toBe(true);
  });
});

describe("round 2: a malformed BAG is refused at the write boundary", () => {
  test.each([
    ["an array", []],
    ["a string", "nope"],
    ["a number", 7],
  ])("refuses a new bag that is %s", (_l, bag) => {
    expect(() =>
      assertSettingsToolPreconditions({ toolPreconditions: bag }, undefined),
    ).toThrow();
  });

  test("accepts a malformed bag that was already stored, unchanged", () => {
    const stored = { toolPreconditions: "nope" };
    expect(() =>
      assertSettingsToolPreconditions({ toolPreconditions: "nope" }, stored),
    ).not.toThrow();
  });

  test("refuses replacing one malformed bag with a different malformed bag", () => {
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: "other" },
        { toolPreconditions: "nope" },
      ),
    ).toThrow();
  });
});
