import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { writeBody } from "@/api/v1/tools.controller";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";

// Regression guard: Elysia's `normalize` strips any request-body field NOT declared in the route's
// body schema. So every field the service's zod schema accepts MUST also appear in the controller's
// `writeBody`, or it is silently dropped before the service ever sees it. This is exactly how `label`
// once got stripped — the saved label stayed stuck at the backfilled identifier.
describe("tools controller writeBody vs service schema (drift guard)", () => {
  test("every service create field is exposed in the Elysia body schema", () => {
    const bodyKeys = new Set(Object.keys(writeBody.properties));
    const serviceKeys = Object.keys(toolDefinitionCreateSchema.shape);
    const missing = serviceKeys.filter((k) => !bodyKeys.has(k));
    expect(missing).toEqual([]);
  });

  test("label specifically is present (the field that regressed)", () => {
    expect(Object.keys(writeBody.properties)).toContain("label");
  });
});

// The same `normalize` behavior is what made dropping `riskTier` (issue #137) a plain removal
// instead of a staged deprecation: a client still sending the retired field must keep working.
// Driven through a real request against the route's OWN body schema, because the service's create
// schema is `.strict()` — if the field ever reached it, the write would fail with unrecognized_keys.
describe("a retired field still sent by an old client", () => {
  const app = new Elysia().post("/tools", ({ body }) => ({ body }), {
    body: writeBody,
  });

  test("riskTier is stripped before the handler, not rejected", async () => {
    const res = await app.handle(
      new Request("http://localhost/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Lookup order",
          urlTemplate: "https://shop.example.com/orders/{{id}}",
          riskTier: "high",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { body } = (await res.json()) as { body: Record<string, unknown> };
    expect(body).toEqual({
      label: "Lookup order",
      urlTemplate: "https://shop.example.com/orders/{{id}}",
    });
  });
});
