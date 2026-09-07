import { describe, expect, it } from "bun:test";
import { sampleLeaves } from "@/modules/tool-definitions/appointment";
import {
  MAX_VALUE_CHARS,
  renderResponseTemplate,
  templateLeaves,
} from "@/modules/tool-definitions/response-template";
import {
  fingerprintShape,
  readStorableShape,
  redactSample,
  SAMPLE_SHAPE_MAX_CHARS,
  storableShape,
} from "@/modules/tool-definitions/sample-shape";

// THE REDACTION IS THE PRIVACY INVARIANT, so it is proved as a table rather than by example: every
// JSON type, and for each one what survives. What survives is STRUCTURE and, for a string, LENGTH —
// never a byte the customer's API returned.

describe("redactSample: what survives, by type", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["a string keeps only its length", "Ana", "xxx"],
    ["the empty string stays empty", "", ""],
    ["a number keeps its width, all nines", 150, 999],
    ["a negative keeps its sign and its point", -42.5, -99.9],
    ["a single digit stays one digit", 7, 9],
    ["a boolean collapses to true", false, true],
    ["null is not data and stays null", null, null],
    ["an object keeps its keys", { nome: "Ana" }, { nome: "xxx" }],
    ["an array keeps its length", ["Ana", "Bia"], ["xxx", "xxx"]],
    ["an empty array stays empty", [], []],
    [
      "nesting is walked to the leaves",
      { c: { r: [{ n: "Consulta", p: 150 }] } },
      { c: { r: [{ n: "xxxxxxxx", p: 999 }] } },
    ],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(redactSample(input)).toEqual(want);
    });
  }

  it("keeps no character of the original, for any string", () => {
    const secret = "joao.silva@cliente.com.br";
    const out = redactSample({ email: secret }) as { email: string };
    expect(out.email).toHaveLength(secret.length);
    for (const ch of new Set(secret)) expect(out.email).not.toInclude(ch);
  });

  it("stands in with ASCII only, so the renderer's clip never spends a unit on a surrogate", () => {
    const out = redactSample("𝕬𝕭𝕮") as string;
    expect(out).toMatch(/^[\x20-\x7e]*$/);
  });
});

// WHY LENGTH IS PRESERVED AT ALL. The per-value clip is what #456 exists to prevent, and a preview
// over a fixed `"string"` would show a template fitting where the real values overflow. So the
// assertion is not "the length matches" — it is that the RENDERER answers the same about both.
describe("redactSample: the preview over a shape clips exactly where the response would", () => {
  const render = (body: unknown) =>
    renderResponseTemplate({ template: "{{v}}" }, body).text;

  it("a value under the cap renders at its real length", () => {
    const v = "a".repeat(MAX_VALUE_CHARS - 1);
    expect(render(redactSample({ v })).length).toBe(render({ v }).length);
  });

  it("a value at the cap renders unclipped on both", () => {
    const v = "a".repeat(MAX_VALUE_CHARS);
    expect(render({ v })).not.toInclude("[truncated]");
    expect(render(redactSample({ v }))).not.toInclude("[truncated]");
  });

  it("a value past the cap is clipped and marked on both", () => {
    const v = "a".repeat(MAX_VALUE_CHARS + 1);
    expect(render({ v })).toInclude("[truncated]");
    expect(render(redactSample({ v }))).toInclude("[truncated]");
  });

  it("a very long value is stored bounded, and still previews as clipped", () => {
    const v = "a".repeat(MAX_VALUE_CHARS * 50);
    const out = redactSample({ v }) as { v: string };
    expect(out.v.length).toBeLessThanOrEqual(MAX_VALUE_CHARS + 2);
    expect(render(out)).toInclude("[truncated]");
  });
});

describe("storableShape", () => {
  it("carries the status the sample came back under", () => {
    expect(storableShape({ a: "x" }, 404)).toEqual({
      status: 404,
      body: { a: "x" },
    });
  });

  it("keeps a hand-pasted sample's null status, which reads as 2xx", () => {
    expect(storableShape({ a: 1 }, null)).toEqual({
      status: null,
      body: { a: 9 },
    });
  });

  it("refuses a shape past the size cap instead of storing a truncated one", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) wide[`field_${i}`] = "some value";
    expect(JSON.stringify(wide).length).toBeGreaterThan(SAMPLE_SHAPE_MAX_CHARS);
    expect(storableShape(wide, 200)).toBeNull();
  });

  it("stores an ordinary response", () => {
    const shape = storableShape({ cliente: { nome: "Ana" } }, 200);
    expect(shape).not.toBeNull();
    expect(shape?.body).toEqual({ cliente: { nome: "xxx" } });
  });
});

// THE SERVER-SIDE HALF OF THE INVARIANT. A client that sends the response instead of the shape must
// not be able to write one, so this is not a formality: it is the reason the column can be said to
// hold no customer data at all.
describe("readStorableShape: what a client sends is not what gets stored", () => {
  it("redacts a raw response a client sent as if it were a shape", () => {
    const stored = readStorableShape({
      status: 200,
      body: { cliente: { nome: "Ana", cpf: "12345678901" } },
    });
    expect(stored?.body).toEqual({
      cliente: { nome: "xxx", cpf: "xxxxxxxxxxx" },
    });
  });

  it("drops a status that is not an integer", () => {
    expect(readStorableShape({ status: "200", body: {} })?.status).toBeNull();
    expect(readStorableShape({ status: 1.5, body: {} })?.status).toBeNull();
  });

  it("reads nothing out of a value that carries no body", () => {
    for (const raw of [null, undefined, 7, "x", [], {}, { status: 200 }]) {
      expect(readStorableShape(raw)).toBeNull();
    }
  });

  it("refuses an oversized body a client sent, like the local path does", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) wide[`field_${i}`] = "some value";
    expect(readStorableShape({ status: 200, body: wide })).toBeNull();
  });
});

// ROUND 1 OF REVIEW, and its P1 is the first of these: redacting VALUES alone did not keep this
// module's promise. A response keyed by customer data copied a person's identifier into the column
// verbatim, under a header claiming the opposite.
describe("a key is data unless it looks like a schema", () => {
  it("drops a map keyed by an e-mail address, subtree and all", () => {
    const out = redactSample({
      users: { "ana@example.com": { nome: "Ana" } },
    }) as { users: Record<string, unknown> };
    expect(Object.keys(out.users)).toEqual([]);
    expect(JSON.stringify(out)).not.toInclude("ana");
  });

  it("drops a key that is a CPF, which IS a legal path segment", () => {
    const out = redactSample({ clientes: { "12345678901": { n: "Ana" } } });
    expect(JSON.stringify(out)).toBe('{"clientes":{}}');
  });

  it("keeps the field names an operator actually writes paths against", () => {
    const out = redactSample({
      cliente: { nome: "Ana", data_nascimento: "x", campo_2: 1, $ref: "y" },
    });
    expect(Object.keys((out as { cliente: object }).cliente).sort()).toEqual([
      "$ref",
      "campo_2",
      "data_nascimento",
      "nome",
    ]);
  });

  // Values could never carry one (every stand-in is ASCII) and keys were passing through untouched:
  // Postgres refuses both inside a jsonb write, so the whole tool save failed at the database.
  it("drops a key Postgres would refuse, so the save cannot fail on the column", () => {
    const lone = String.fromCharCode(0xd800);
    const out = redactSample({ "a b": 1, [lone]: 2, ok: 3 });
    expect(JSON.stringify(out)).toBe('{"ok":9}');
  });

  it("keeps an own __proto__ key, which assigning onto {} silently drops", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"nome":"Ana"},"ok":1}');
    const out = redactSample(parsed) as Record<string, unknown>;
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(out))).toEqual(
      JSON.parse('{"__proto__":{"nome":"xxx"},"ok":9}'),
    );
  });
});

// The picker's whole invariant is that it offers what its own reader accepts. A number past 2^53 is
// REFUSED by both readers — `JSON.parse` has already lost the digits — so a shape that turned it
// into `0` offered a path the real response does not.
describe("a number the readers refuse is still refused after redaction", () => {
  // Past the cap and EXACTLY representable, so the literal is not itself a rounded lie (biome
  // refuses one that is, and it is right: the value this test is about is the one at runtime).
  const big = Number.MAX_SAFE_INTEGER + 1;

  it("is offered by neither reader, before or after", () => {
    expect(sampleLeaves({ id: big }).map((l) => l.path)).toEqual([]);
    expect(templateLeaves({ id: big }).map((l) => l.path)).toEqual([]);
    expect(sampleLeaves(redactSample({ id: big })).map((l) => l.path)).toEqual(
      [],
    );
    expect(
      templateLeaves(redactSample({ id: big })).map((l) => l.path),
    ).toEqual([]);
  });

  it("still offers the ordinary number beside it", () => {
    const out = redactSample({ id: big, preco: 150 });
    expect(templateLeaves(out).map((l) => l.path)).toEqual(["preco"]);
  });

  it("renders at the width the real number would", () => {
    for (const n of [0, 7, 150, -42.5, 1234567890]) {
      expect(String(redactSample(n))).toHaveLength(String(n).length);
    }
  });
});

// The service runs the redaction AGAIN on the way in, and the browser's fingerprint is computed on
// the shape before that second pass. So a redaction that moved on its own output would report every
// restored sample as stale — the fingerprint would be comparing two different things.
describe("the redaction is a fixed point of itself", () => {
  it("does not move on a second pass, for the values that stressed it", () => {
    const body = {
      s: "Ana",
      long: "a".repeat(MAX_VALUE_CHARS * 3),
      zero: 0,
      price: 150,
      neg: -42.5,
      big: Number.MAX_SAFE_INTEGER + 1,
      round: 0.30000000000000004,
      exp: 1e21,
      b: false,
      nil: null,
      list: [{ n: "x" }, { n: "yy" }],
    };
    const once = redactSample(body);
    expect(redactSample(once)).toEqual(once);
    expect(fingerprintShape({ status: 200, body: redactSample(once) })).toBe(
      fingerprintShape({ status: 200, body: once }),
    );
  });
});

describe("fingerprintShape", () => {
  it("does not care what order the keys came back in, because jsonb reorders them", () => {
    expect(
      fingerprintShape({ status: 200, body: { nome: "x", cpf: "y" } }),
    ).toBe(fingerprintShape({ status: 200, body: { cpf: "y", nome: "x" } }));
  });

  it("moves when the shape actually differs", () => {
    expect(fingerprintShape({ status: 200, body: { a: 9 } })).not.toBe(
      fingerprintShape({ status: 200, body: { a: 9, b: 9 } }),
    );
    expect(fingerprintShape({ status: 200, body: { a: 9 } })).not.toBe(
      fingerprintShape({ status: 404, body: { a: 9 } }),
    );
  });

  it("keeps array order, which is not a key order", () => {
    expect(fingerprintShape({ status: 200, body: ["a", "bb"] })).not.toBe(
      fingerprintShape({ status: 200, body: ["bb", "a"] }),
    );
  });

  it("answers for no shape at all", () => {
    expect(fingerprintShape(null)).toBe("");
  });
});

// Measured in the column, not reasoned: jsonb normalises a numeric literal, so a sentinel written as
// `1e308` came back as three hundred and nine digits while the size cap had counted it as six
// characters on the way in.
describe("the refused sentinel is cheap to store", () => {
  it("serializes in the width of an ordinary id", () => {
    const out = redactSample({ id: Number.MAX_SAFE_INTEGER + 1 });
    expect(JSON.stringify(out).length).toBeLessThan(40);
  });
});
