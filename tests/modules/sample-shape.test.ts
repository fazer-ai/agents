import { describe, expect, it } from "bun:test";
import {
  MAX_VALUE_CHARS,
  renderResponseTemplate,
} from "@/modules/tool-definitions/response-template";
import {
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
    ["a number collapses to zero", 150, 0],
    ["a negative number collapses to zero", -42.5, 0],
    ["a boolean collapses to true", false, true],
    ["null is not data and stays null", null, null],
    ["an object keeps its keys", { nome: "Ana" }, { nome: "xxx" }],
    ["an array keeps its length", ["Ana", "Bia"], ["xxx", "xxx"]],
    ["an empty array stays empty", [], []],
    [
      "nesting is walked to the leaves",
      { c: { r: [{ n: "Consulta", p: 150 }] } },
      { c: { r: [{ n: "xxxxxxxx", p: 0 }] } },
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
      body: { a: 0 },
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
