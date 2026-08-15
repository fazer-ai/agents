import { describe, expect, test } from "bun:test";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
import { describeShape } from "@/modules/flowlog/shape";

// Decision table for what a tool call may leave in ExecutionLog.detail (issue #78). Each row is a
// value the model could plausibly send and the shape that stands in for it.

const DECLARED = new Set([
  "cpf",
  "limit",
  "ativo",
  "filtro",
  "X-Custom-Header",
]);

const cases: Array<{
  name: string;
  value: unknown;
  declared?: ReadonlySet<string>;
  want: unknown;
}> = [
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
    // The key looks exactly like a schema field, which is why the shape of a string cannot be the
    // test: no tool declared it, so it is counted.
    name: "an identifier-looking key that no tool declared is counted, not named",
    value: { cpf: "1", Maria: "cliente vip" },
    want: { cpf: "string(1)", "[unnamed keys]": 1 },
  },
  {
    name: "several undeclared keys collapse into one count",
    value: { "12345678900": 1, "Rua das Flores, 42": 2 },
    want: { "[unnamed keys]": 2 },
  },
  {
    name: "a declared header-ish key is kept",
    value: { "X-Custom-Header": "abc" },
    want: { "X-Custom-Header": "string(3)" },
  },
  {
    // Nothing below the top level has a declaration behind it, so nesting reports a count and stops.
    name: "a nested object reports its size and none of its names",
    value: { filtro: { status: "pago", cpf: "12345678900" } },
    want: { filtro: "object(2 keys)" },
  },
  {
    name: "with no declarations at all, an object is only its size",
    value: { cpf: "1", limit: 2 },
    declared: new Set<string>(),
    want: { "[unnamed keys]": 2 },
  },
];

describe("describeShape", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(describeShape(c.value, c.declared ?? DECLARED)).toEqual(c.want);
    });
  }

  test("a value with no declarations named for it never yields a key", () => {
    const deep = { a: { b: { c: { d: { e: { f: "segredo" } } } } } };
    expect(describeShape(deep)).toBe("object(1 keys)");
  });

  // The whole point: whatever the model wrote, none of it comes back out.
  test("no value survives, at any depth", () => {
    const payload = {
      documento: "123.456.789-00",
      endereco: { rua: "Rua das Flores", numero: 42 },
      anexos: ["nota-fiscal-maria-silva.pdf"],
      url: "https://cdn.loja.com.br/pedidos/48213/foto.png?token=segredo",
    };
    const json = JSON.stringify(
      describeShape(
        payload,
        new Set(["documento", "endereco", "anexos", "url"]),
      ),
    );
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
      endereco: "object(2 keys)",
      anexos: "array(1)",
      url: "string(60)",
    });
  });
});

// The escape hatch: `agent.settings.observability.logToolValues`. Off by default, and only a literal
// true (or its string form, since a settings bag can come from JSON) turns it on.
describe("readObservabilityConfig", () => {
  const rows: Array<{ name: string; settings: unknown; want: boolean }> = [
    { name: "no settings at all", settings: null, want: false },
    { name: "no observability block", settings: {}, want: false },
    { name: "an empty block", settings: { observability: {} }, want: false },
    {
      name: "explicitly on",
      settings: { observability: { logToolValues: true } },
      want: true,
    },
    {
      name: "on as the string a JSON bag may carry",
      settings: { observability: { logToolValues: "true" } },
      want: true,
    },
    {
      name: "anything else is off, not truthy",
      settings: { observability: { logToolValues: 1 } },
      want: false,
    },
    {
      name: "explicitly off",
      settings: { observability: { logToolValues: false } },
      want: false,
    },
  ];
  for (const r of rows) {
    test(`${r.want ? "on" : "off"}: ${r.name}`, () => {
      expect(readObservabilityConfig(r.settings).logToolValues).toBe(r.want);
    });
  }
});
