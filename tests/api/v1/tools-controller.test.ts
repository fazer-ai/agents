import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { writeBody } from "@/api/v1/tools.controller";
import { toolDefinitionCreateSchema } from "@/modules/tool-definitions/service";

// Elysia's `normalize` strips any request-body field NOT declared in the route's body schema, so
// every field the service's zod schema accepts MUST also appear in the controller's `writeBody`, or
// it is silently dropped before the service sees it.
describe("tools controller writeBody vs service schema (drift guard)", () => {
  test("every service create field is exposed in the Elysia body schema", () => {
    const bodyKeys = new Set(Object.keys(writeBody.properties));
    const serviceKeys = Object.keys(toolDefinitionCreateSchema.shape);
    const missing = serviceKeys.filter((k) => !bodyKeys.has(k));
    expect(missing).toEqual([]);
  });
});

// The same `normalize` behavior lets a client still sending the retired `riskTier` keep working.
// Driven through a real request against the route's OWN body schema, because the service's create
// schema is `.strict()`: if the field ever reached it, the write would fail with unrecognized_keys.
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

// `body` is NOT declared structurally in the REST schema: Elysia's `normalize` strips what a schema
// does not declare, so a union of the three modes would answer a plain-object body with 200 and
// `body: {}`, emptying the operator's payload in silence. Passed through intact, a plain JSON object
// (the one shape `parseBody` does not execute) reaches the service, which refuses it with a message
// worth reading. The contract lives in the description.
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
