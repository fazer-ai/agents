import { describe, expect, test } from "bun:test";
import { unsupportedBodyShape } from "@/modules/tool-definitions/body-shape";

// Issue #150. The decision table for what a tool body may be, kept apart from the transports that
// act on it: REST and the console refuse it in the service, MCP refuses it in the dry-run preview
// too (the preview never calls the service), and the bundle import warns and drops it rather than
// failing a whole bundle. All three ask this one function.

const CASES: { name: string; body: unknown; ok: boolean }[] = [
  // NOTE: Legitimate absences. `{}` is what the code itself writes for "no body configuration", so
  // refusing it would refuse every GET tool the console has ever saved.
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
});
