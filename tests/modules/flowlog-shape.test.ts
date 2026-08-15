import { describe, expect, test } from "bun:test";
import { describeShape } from "@/modules/flowlog/shape";

// Decision table for what a tool call may leave in ExecutionLog.detail (issue #78). Each row is a
// value the model could plausibly send and the shape that stands in for it.

const cases: Array<{ name: string; value: unknown; want: unknown }> = [
  {
    name: "a string keeps only its length",
    value: "12345678900",
    want: "string(11)",
  },
  {
    name: "an empty string is still distinguishable",
    value: "",
    want: "string(0)",
  },
  {
    name: "a number is a number, whatever it holds",
    value: 12345678900,
    want: "number",
  },
  { name: "a boolean", value: true, want: "boolean" },
  { name: "null is not the same as absent", value: null, want: "null" },
  { name: "undefined", value: undefined, want: "undefined" },
  {
    name: "an array keeps only its length",
    value: ["a", "b"],
    want: "array(2)",
  },
  { name: "an empty array", value: [], want: "array(0)" },
  {
    name: "an object keeps its schema keys and loses every value",
    value: { cpf: "12345678900", limit: 5, ativo: false },
    want: { cpf: "string(11)", limit: "number", ativo: "boolean" },
  },
  {
    name: "nesting is described too",
    value: { filtro: { status: "pago", itens: [1, 2, 3] } },
    want: { filtro: { status: "string(4)", itens: "array(3)" } },
  },
  {
    name: "a key the model invented is counted, not named",
    value: { cpf: "1", "Maria Souza": "cliente vip" },
    want: { cpf: "string(1)", "[unnamed keys]": 1 },
  },
  {
    name: "several invented keys collapse into one count",
    value: { "12345678900": 1, "Rua das Flores, 42": 2 },
    want: { "[unnamed keys]": 2 },
  },
  {
    name: "a header-ish key looks like a schema field and is kept",
    value: { "X-Custom-Header": "abc" },
    want: { "X-Custom-Header": "string(3)" },
  },
];

describe("describeShape", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(describeShape(c.value)).toEqual(c.want);
    });
  }

  test("stops descending at a bounded depth", () => {
    const deep = { a: { b: { c: { d: { e: { f: "segredo" } } } } } };
    expect(describeShape(deep)).toEqual({
      a: { b: { c: { d: "object(1 keys)" } } },
    });
  });

  // The whole point: whatever the model wrote, none of it comes back out.
  test("no value survives, at any depth", () => {
    const payload = {
      documento: "123.456.789-00",
      endereco: { rua: "Rua das Flores", numero: 42 },
      anexos: ["nota-fiscal-maria-silva.pdf"],
      url: "https://cdn.loja.com.br/pedidos/48213/foto.png?token=segredo",
    };
    const json = JSON.stringify(describeShape(payload));
    for (const leak of [
      "123.456",
      "Flores",
      "maria-silva",
      "48213",
      "segredo",
      "cdn.loja",
    ]) {
      expect(json).not.toContain(leak);
    }
    // Still diagnosable: the four arguments are named, with their kinds.
    expect(JSON.parse(json)).toEqual({
      documento: "string(14)",
      endereco: { rua: "string(14)", numero: "number" },
      anexos: "array(1)",
      url: "string(60)",
    });
  });
});
