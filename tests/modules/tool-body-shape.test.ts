import { describe, expect, test } from "bun:test";
import { buildHttpTool } from "@/graph/tools/http";
import {
  canonicalBodyShape,
  unsupportedBodyShape,
} from "@/modules/tool-definitions/body-shape";

// Issue #150. The decision table for what a tool body may be, kept apart from the transports that
// act on it: REST and the console refuse it in the service, MCP refuses it in the dry-run preview
// too (the preview never calls the service), and the bundle import warns and drops it rather than
// failing a whole bundle. All three ask this one function.

const CASES: { name: string; body: unknown; ok: boolean }[] = [
  // NOTE: legitimate absences — and NOT "no body". `{}` is what the code itself writes when nothing
  // is configured, and it selects the legacy `fields` branch (the payload is assembled from the
  // declared input fields; pinned in tests/graph/tools-http.test.ts). Refusing it would refuse
  // every tool the console has ever saved.
  { name: "absent", body: undefined, ok: true },
  { name: "null", body: null, ok: true },
  { name: "empty object", body: {}, ok: true },

  // NOTE: The three the runtime executes.
  {
    name: "kv",
    body: { mode: "kv", rows: [{ key: "a", value: "{{a}}" }] },
    ok: true,
  },
  { name: "kv with no rows", body: { mode: "kv" }, ok: true },
  { name: "raw", body: { mode: "raw", raw: '{"a":{{a}}}' }, ok: true },
  { name: "legacy fields", body: { mode: "fields" }, ok: true },

  // NOTE: The reported case: a plain JSON object that reads like a template and is not one.
  {
    name: "plain object, nested placeholder",
    body: { order_id: "{{order_id}}", contact: { email: "{{contact_email}}" } },
    ok: false,
  },
  // NOTE: Same shape one level flatter — it "worked" in the report only because the key happened to match
  // a declared field name, so the fields assembly produced it by coincidence.
  {
    name: "plain object, flat placeholder",
    body: { order_id: "{{order_id}}" },
    ok: false,
  },
  { name: "unknown mode", body: { mode: "template", raw: "…" }, ok: false },

  // NOTE: round 3 review, P1. A mode-only check accepted every one of these, and each loses the
  // author's payload in silence — the half-conversion is the likeliest of them all, because the
  // refusal above tells people to reach for mode "raw".
  {
    name: "raw with the old plain object still attached",
    body: { mode: "raw", contact: { email: "{{contact_email}}" } },
    ok: false,
  },
  {
    name: "kv with the old plain object still attached",
    body: { mode: "kv", rows: [], order_id: "{{order_id}}" },
    ok: false,
  },
  {
    name: "fields with keys it will never read",
    body: { mode: "fields", order_id: "{{order_id}}" },
    ok: false,
  },
  {
    name: "raw whose raw is not a string",
    body: { mode: "raw", raw: 1 },
    ok: false,
  },
  {
    name: "kv whose rows are not a list",
    body: { mode: "kv", rows: {} },
    ok: false,
  },
  {
    name: "kv with a malformed row",
    body: { mode: "kv", rows: [{ key: "a" }] },
    ok: false,
  },
  {
    name: "kv with a row carrying an extra key",
    body: { mode: "kv", rows: [{ key: "a", value: "b", note: "c" }] },
    ok: false,
  },
  { name: "raw with no raw at all", body: { mode: "raw" }, ok: true },
  { name: "non-string mode", body: { mode: 1 }, ok: false },
  { name: "array", body: [{ key: "a" }], ok: false },
  { name: "string", body: '{"a":1}', ok: false },
];

describe("tool body shape", () => {
  for (const c of CASES) {
    test(`${c.ok ? "accepts" : "refuses"}: ${c.name}`, () => {
      const reason = unsupportedBodyShape(c.body);
      expect(reason === null).toBe(c.ok);
    });
  }

  // NOTE: The refusal is only useful if it says what to do instead — the author's whole problem is that
  // the shape they reached for looks like the obvious one.
  test("the refusal names the supported modes and points nesting at raw", () => {
    const reason = unsupportedBodyShape({ contact: { email: "{{e}}" } });
    expect(reason).toContain('"mode":"kv"');
    expect(reason).toContain('"mode":"raw"');
    expect(reason).toContain("nested");
  });

  // NOTE: Naming what was actually received is what tells an author with several tools which one to open.
  test("the refusal names what it got", () => {
    expect(unsupportedBodyShape({ mode: "template" })).toContain('"template"');
    expect(unsupportedBodyShape({ contact: 1, order: 2 })).toContain("contact");
  });

  // NOTE: the half-conversion refusal has to name the keys being dropped, or the author reads it as
  // a complaint about the mode they just fixed.
  test("a half-converted body names the keys that would be lost", () => {
    const reason = unsupportedBodyShape({
      mode: "raw",
      contact: { email: "{{e}}" },
      order_id: "{{o}}",
    });
    expect(reason).toContain("contact");
    expect(reason).toContain("order_id");
    expect(reason).toContain("dropped");
  });
});

// NOTE: rounds 4 and 5, both P2, both the same defect at a different depth: `canonicalBodyShape`
// was written by reading the refusal rules instead of by reading `parseBody`, so the two disagreed
// wherever the runtime TOLERATES what an author may not write — an extra key beside `raw`, an extra
// key inside a row, a value of the wrong type. Each disagreement changes the request of a tool the
// import was only supposed to tidy.
//
// So the cases below are enumerated by WHERE the two questions can diverge (mode level, row level,
// field level, degenerate input) rather than picked by hand, and the property is asserted against
// the wire: whatever the refusal rejects, its canonical form must send byte-identical bytes.
describe("the canonical form of a refused body sends what the original sent", () => {
  const REFUSED: unknown[] = [
    // NOTE: extra keys, at each level that has one.
    { mode: "raw", raw: '{"a":1}', extra: "x" },
    { mode: "kv", rows: [{ key: "a", value: "{{valor}}" }], stray: "x" },
    { mode: "kv", rows: [{ key: "a", value: "{{valor}}", note: "legacy" }] },
    { mode: "fields", order_id: "{{order_id}}" },
    // NOTE: wrong types, at each field the runtime coerces rather than rejects.
    { mode: "raw", raw: 7 },
    { mode: "kv", rows: [{ key: "a", value: 7 }] },
    { mode: "kv", rows: [{ key: 7, value: "{{valor}}" }] },
    { mode: "kv", rows: {} },
    // NOTE: the row the runtime filters out rather than sends.
    { mode: "kv", rows: [{ key: "  ", value: "{{valor}}" }] },
    { mode: "kv", rows: [null] },

    // NOTE: no mode at all, and a mode nothing executes.
    { contact: { email: "{{valor}}" } },
    { mode: "template", raw: "x" },
    { mode: 7 },
    [{ key: "a", value: "b" }],
    "not an object",
  ];

  async function sent(body: unknown): Promise<string> {
    let out = "";
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      out = String(init?.body ?? "");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const tool = buildHttpTool(
      {
        name: "t",
        method: "POST",
        urlTemplate: "https://example.com/x",
        allowedHosts: ["example.com"],
        headers: {},
        inputSchema: { valor: { type: "string", required: true } },
        body,
      } as never,
      {
        fetchImpl,
        allowHttp: true,
        resolveCredential: async () => null,
      },
    );
    await tool.invoke({ valor: "TESTE" });
    return out;
  }

  for (const [i, body] of REFUSED.entries()) {
    test(`case ${i} is refused, and its canonical form is on the wire`, async () => {
      expect(unsupportedBodyShape(body)).not.toBeNull();
      const canonical = canonicalBodyShape(body);
      expect(unsupportedBodyShape(canonical)).toBeNull();
      expect(await sent(canonical)).toBe(await sent(body));
    });
  }
});

// NOTE: round 6 review, second P2, and it is fixed in the runtime rather than refused at the write:
// `payload[k] = v` on a plain object hits Object.prototype's setter when k is "__proto__", so the
// assignment succeeds, no own property appears, and JSON.stringify drops the row. Refusing the key
// would leave every already-stored row losing its value; a null-prototype payload makes the key
// ordinary, which is what an operator writing it meant. `constructor` was never affected (an own
// property simply shadows the inherited one) and is here so the fix is not mistaken for a ban.
describe("a payload key that collides with Object.prototype", () => {
  async function sent(body: unknown): Promise<string> {
    let out = "";
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      out = String(init?.body ?? "");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const tool = buildHttpTool(
      {
        name: "t",
        method: "POST",
        urlTemplate: "https://example.com/x",
        allowedHosts: ["example.com"],
        headers: {},
        inputSchema: {},
        body,
      } as never,
      { fetchImpl, allowHttp: true, resolveCredential: async () => null },
    );
    await tool.invoke({});
    return out;
  }

  test("a __proto__ row is sent, not silently dropped", async () => {
    const out = await sent({
      mode: "kv",
      rows: [
        { key: "__proto__", value: "x" },
        { key: "ok", value: "y" },
      ],
    });
    // NOTE: compared as entries on purpose — an object LITERAL keyed "__proto__" sets the
    // prototype instead of an own property, so the obvious expectation is the very trap this
    // tests for (JSON.parse, unlike a literal, does create an own key).
    expect(Object.entries(JSON.parse(out))).toEqual([
      ["__proto__", "x"],
      ["ok", "y"],
    ]);
  });

  test("the authoring rule does not refuse it", () => {
    expect(
      unsupportedBodyShape({
        mode: "kv",
        rows: [{ key: "__proto__", value: "x" }],
      }),
    ).toBeNull();
  });

  test("constructor was never affected and stays sendable", async () => {
    const out = await sent({
      mode: "kv",
      rows: [{ key: "constructor", value: "x" }],
    });
    expect(JSON.parse(out)).toEqual({ constructor: "x" });
  });
});

// NOTE: rounds 6 and 7. Round 6 asked for duplicate trimmed keys to be refused, on the grounds that
// the later row overwrites the earlier and one authored value never leaves. Round 7 found the hole in
// that, and measuring it turned the whole rule over: which row wins is decided PER CALL by the
// model's own arguments, because a row whose value is a lone {{aiField}} is skipped when the model
// omitted that field. So two rows on one key are not a mistake, they are a fallback idiom — and a
// refusal would have broken it, while a canonicalizer that deduplicates could never be
// byte-identical. The rule was removed rather than patched; these tests are what it left behind.
describe("two kv rows on the same key are a fallback, not a collision", () => {
  const BODY = {
    mode: "kv",
    rows: [
      { key: "a", value: "fallback" },
      { key: " a ", value: "{{opcional}}" },
    ],
  };

  async function sent(input: Record<string, unknown>): Promise<string> {
    let out = "";
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      out = String(init?.body ?? "");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const tool = buildHttpTool(
      {
        name: "t",
        method: "POST",
        urlTemplate: "https://example.com/x",
        allowedHosts: ["example.com"],
        headers: {},
        inputSchema: { opcional: { type: "string" } },
        body: BODY,
      } as never,
      { fetchImpl, allowHttp: true, resolveCredential: async () => null },
    );
    await tool.invoke(input);
    return out;
  }

  test("the model's value wins when it supplied one", async () => {
    expect(JSON.parse(await sent({ opcional: "supplied" }))).toEqual({
      a: "supplied",
    });
  });

  test("the earlier row is the default when the model omitted it", async () => {
    expect(JSON.parse(await sent({}))).toEqual({ a: "fallback" });
  });

  test("so it is not refused, and the canonical form keeps both rows", () => {
    expect(unsupportedBodyShape(BODY)).toBeNull();
    expect(canonicalBodyShape(BODY)).toEqual({
      mode: "kv",
      rows: [
        { key: "a", value: "fallback" },
        { key: " a ", value: "{{opcional}}" },
      ],
    });
  });
});
