import { describe, expect, test } from "bun:test";
import { t, ValidationError } from "elysia";
import { fieldFromPointer, schemaRefusal } from "@/api/lib/schema-refusal";

// The decision table for a schema refusal: what the client is told, and what the server records.
// Issue #255.
//
// The errors are built the way Elysia builds them, from a schema and a value, so a row states the
// shape a route declares and the body that breaks it rather than a hand-assembled error object.

const SUBMITTED = "sk-live-DO-NOT-ECHO-ME";

const validationError = (
  on: string,
  schema: ReturnType<typeof t.Object> | ReturnType<typeof t.String>,
  value: unknown,
): ValidationError => new ValidationError(on, schema as never, value);

describe("fieldFromPointer", () => {
  // Every row states the schema a route declares AND the pointer TypeBox reported against it,
  // because the answer depends on both: a segment is a name only when the schema declares it. The
  // rows that end early are the point of the pass — a `t.Record` key is written by the caller, and
  // publishing it would put the caller's own string in the response and in the log.
  const declared = t.Object({
    name: t.String(),
    settings: t.Object({
      guardrails: t.Object({ templateMessage: t.String() }),
    }),
    items: t.Array(t.Object({ name: t.String() })),
    pair: t.Tuple([t.String(), t.Number()]),
    toolMocks: t.Record(t.String(), t.String({ maxLength: 10 })),
    nested: t.Object({ bag: t.Record(t.String(), t.String()) }),
    value: t.Union([t.String(), t.Record(t.String(), t.String())]),
    "a/b": t.String(),
    "a~b": t.String(),
    "a~1": t.String(),
  });

  const rows: Array<[string, unknown, unknown, string | undefined]> = [
    ["a top-level value", declared, "/name", "name"],
    [
      "a nested value",
      declared,
      "/settings/guardrails/templateMessage",
      "settings.guardrails.templateMessage",
    ],
    ["an array element", declared, "/items/0/name", "items.0.name"],
    ["a tuple position", declared, "/pair/0", "pair.0"],
    // A position past the end of a tuple is not a position the schema declares.
    ["a tuple position that does not exist", declared, "/pair/9", "pair"],
    // The rows this pass exists for: the segment after a record property is the CALLER's key.
    [
      "a record key, which the caller wrote",
      declared,
      `/toolMocks/${SUBMITTED}`,
      "toolMocks",
    ],
    [
      "a record key nested under a declared object",
      declared,
      `/nested/bag/${SUBMITTED}`,
      "nested.bag",
    ],
    // TypeBox does not descend into `anyOf` at all, so this pointer stops on its own; the row pins
    // that the walk agrees with it rather than inventing a segment.
    ["a value inside a union", declared, `/value/${SUBMITTED}`, "value"],
    // A property the schema never declared, which is what a caller-supplied segment looks like from
    // here whether or not a record produced it.
    ["a segment the schema does not declare", declared, "/nope", undefined],
    // `Object.hasOwn`, not a plain property read: every object has a `constructor`.
    [
      "a segment named after a prototype key",
      declared,
      "/constructor",
      undefined,
    ],
    // The whole value failed rather than one of its properties, so there is no input to name. An
    // empty string is what Elysia reports for it, and "root" is what it substitutes when serializing.
    ["the value as a whole", declared, "", undefined],
    [
      "the value as a whole, Elysia's own spelling",
      declared,
      "root",
      undefined,
    ],
    ["a pointer that names nothing", declared, "/", undefined],
    ["nothing reported at all", declared, undefined, undefined],
    // A standard-schema validator (zod and friends) reports segments, not a pointer, and its schema
    // is not a JSON Schema. Naming no field is the honest answer; publishing "0" as one is not.
    ["a standard-schema path array", declared, ["name"], undefined],
    ["a schema that could not be read at all", undefined, "/name", undefined],
    // RFC 6901 escapes. `~01` is the row that pins the ORDER: decoding `~0` first turns it into `~1`
    // and then into a separator, answering "a/". It reads "a~1" only while `~1` is decoded first.
    ["an escaped separator", declared, "/a~1b", "a/b"],
    ["an escaped tilde", declared, "/a~0b", "a~b"],
    ["an escaped tilde followed by a one", declared, "/a~01", "a~1"],
  ];

  for (const [name, schema, pointer, expected] of rows) {
    test(`${name} -> ${expected ?? "no field"}`, () => {
      expect(fieldFromPointer(pointer, schema)).toBe(expected as string);
    });
  }
});

describe("schemaRefusal", () => {
  test("a refused request value: 422, named, and localized", () => {
    const refusal = schemaRefusal(
      validationError("body", t.Object({ name: t.String({ minLength: 1 }) }), {
        name: "",
      }),
      "en",
    );
    expect(refusal.status).toBe(422);
    expect(refusal.body).toEqual({
      error: "The value sent in name is not valid.",
      field: "name",
    });
    expect(refusal.severity).toBe("warn");
  });

  test("the sentence follows Accept-Language, the field does not", () => {
    const of = (lang: string) =>
      schemaRefusal(
        validationError(
          "body",
          t.Object({ name: t.String({ minLength: 1 }) }),
          {
            name: "",
          },
        ),
        lang,
      );
    const en = of("en");
    const pt = of("pt-BR");
    expect(pt.body.error).toBe("O valor enviado em name não é válido.");
    expect(en.body.error).toBe("The value sent in name is not valid.");
    expect(pt.body.field).toBe("name");
    expect(en.body.field).toBe("name");
  });

  test("a query parameter is named the same way a body value is", () => {
    const refusal = schemaRefusal(
      validationError("query", t.Object({ limit: t.Number() }), {
        limit: "abc",
      }),
      "en",
    );
    expect(refusal.status).toBe(422);
    expect(refusal.body.field).toBe("limit");
  });

  test("a route parameter is named, like every other request side", () => {
    const refusal = schemaRefusal(
      validationError("params", t.Object({ id: t.Numeric() }), { id: "abc" }),
      "en",
    );
    expect(refusal.status).toBe(422);
    expect(refusal.body.field).toBe("id");
  });

  test("a header is named too", () => {
    const refusal = schemaRefusal(
      validationError("headers", t.Object({ "x-tenant": t.String() }), {}),
      "en",
    );
    expect(refusal.status).toBe(422);
    expect(refusal.body.field).toBe("x-tenant");
  });

  test("a value with no nameable input answers without a field at all", () => {
    const refusal = schemaRefusal(
      validationError("body", t.String(), 42),
      "en",
    );
    expect(refusal.status).toBe(422);
    expect(refusal.body).toEqual({ error: "The request is not valid." });
    expect(refusal.body.field).toBeUndefined();
  });

  test("a response that failed its own schema is a server fault, not a refusal", () => {
    const refusal = schemaRefusal(
      validationError("response", t.Object({ ok: t.String() }), {}),
      "en",
    );
    expect(refusal.status).toBe(500);
    expect(refusal.body).toEqual({ error: "Something went wrong" });
    expect(refusal.severity).toBe("error");
  });

  test("the log line carries the rule, and never the submitted value", () => {
    const refusal = schemaRefusal(
      validationError(
        "body",
        t.Object({
          name: t.String({ minLength: 1 }),
          value: t.Record(t.String(), t.String()),
        }),
        { name: "", value: { api_key: SUBMITTED } },
      ),
      "en",
    );
    expect(refusal.log).toBe(
      "refused body.name: Expected string length greater or equal to 1",
    );
    expect(refusal.log).not.toContain(SUBMITTED);
  });

  test("the log line survives an error that reports no rule", () => {
    const error = validationError(
      "body",
      t.Object({ name: t.String({ minLength: 1 }) }),
      { name: "" },
    );
    (error as { valueError?: unknown }).valueError = undefined;
    const refusal = schemaRefusal(error, "en");
    expect(refusal.status).toBe(422);
    expect(refusal.body).toEqual({ error: "The request is not valid." });
    expect(refusal.log).toBe("refused body: no rule reported");
  });
});
