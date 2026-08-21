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

// Issue #150. The REST schema described `body` as a "request body template" whose placeholders are
// interpolated, which is what invited a plain JSON object — the one shape `parseBody` does not
// execute. The contract now lives in the description, and the refusal lives in the service.
//
// It is NOT declared structurally, and this is what stops that from being tried again. Elysia's
// `normalize` strips what a schema does not declare (the riskTier case above depends on it), so a
// union of the three modes answered a plain-object body with 200 and `body: {}` — measured, not
// assumed. The operator's payload emptied in silence is issue #150 itself, moved one layer earlier.
// Passing it through intact is what lets the service refuse it with a message worth reading.
describe("a request body in a shape the runtime does not execute", () => {
  const app = new Elysia().post("/tools", ({ body }) => ({ body }), {
    body: writeBody,
  });

  async function post(body: unknown) {
    const res = await app.handle(
      new Request("http://localhost/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Lookup order",
          urlTemplate: "https://shop.example.com/orders/{{id}}",
          body,
        }),
      }),
    );
    return {
      status: res.status,
      json: (await res.json()) as { body?: { body?: unknown } },
    };
  }

  test("reaches the service intact instead of being emptied on the way in", async () => {
    const authored = {
      order_id: "{{order_id}}",
      contact: { email: "{{contact_email}}" },
    };
    const r = await post(authored);
    expect(r.status).toBe(200);
    expect(r.json.body?.body).toEqual(authored);
  });

  test("the three shapes the runtime executes still pass through intact", async () => {
    for (const body of [
      { mode: "kv", rows: [{ key: "order_id", value: "{{order_id}}" }] },
      { mode: "raw", raw: '{"contact":{"email":"{{contact_email}}"}}' },
      {},
    ]) {
      const r = await post(body);
      expect(r.status).toBe(200);
      expect(r.json.body?.body).toEqual(body);
    }
  });
});
