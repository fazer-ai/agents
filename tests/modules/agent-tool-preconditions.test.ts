import { describe, expect, test } from "bun:test";
import { AppError } from "@/lib/errors";
import { assertSettingsToolPreconditions } from "@/modules/agents/service";
import {
  evaluatePrecondition,
  invalidToolPreconditions,
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
          good: { kind: "attribute", scope: "contact", key: "cpf" },
          bad_kind: { kind: "nope" },
          bad_scope: { kind: "attribute", scope: "moon", key: "cpf" },
        },
      }),
    ).toEqual(["bad_kind", "bad_scope"]);
  });

  test("a bag of the wrong shape is ONE refusal, because there are no names", () => {
    expect(invalidToolPreconditions({ toolPreconditions: [] })).toEqual([
      "toolPreconditions",
    ]);
  });
});

describe("assertSettingsToolPreconditions", () => {
  const good = { kind: "attribute", scope: "contact", key: "cpf" };

  test("accepts a valid bag", () => {
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { create_invoice: good } },
        undefined,
      ),
    ).not.toThrow();
  });

  test("refuses a new invalid entry, naming the tool as the field", () => {
    try {
      assertSettingsToolPreconditions(
        { toolPreconditions: { create_invoice: { kind: "nope" } } },
        undefined,
      );
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.field).toBe("toolPreconditions.create_invoice");
    }
  });

  test("does NOT refuse an invalid entry that was already stored", () => {
    // The operator came to edit something else. Making them fix a rule they did not touch refuses a
    // field they are not looking at, and the change they DID make is what the refusal blocks.
    const stored = { toolPreconditions: { legacy: { kind: "nope" } } };
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { legacy: { kind: "nope" }, ok: good } },
        stored,
      ),
    ).not.toThrow();
  });

  test("refuses when a stored-valid entry is edited into an invalid one", () => {
    const stored = { toolPreconditions: { create_invoice: good } };
    expect(() =>
      assertSettingsToolPreconditions(
        { toolPreconditions: { create_invoice: { kind: "attribute" } } },
        stored,
      ),
    ).toThrow();
  });
});
