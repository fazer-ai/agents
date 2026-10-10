import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { codeToolsController, writeBody } from "@/api/v1/code-tools.controller";
import { codeToolCreateSchema } from "@/modules/code-tools/service";

// The same drift guard tools-controller.test.ts holds: Elysia's `normalize` strips any request-body
// field the route's schema does not declare, so every field the service accepts must be declared
// here or it is silently dropped before the service sees it.
describe("code-tools controller writeBody vs service schema (drift guard)", () => {
  test("every service create field is exposed in the Elysia body schema", () => {
    const bodyKeys = new Set(Object.keys(writeBody.properties));
    const serviceKeys = Object.keys(codeToolCreateSchema.shape);
    expect(serviceKeys.filter((k) => !bodyKeys.has(k))).toEqual([]);
  });
});

// The transport must not rebuild the field map. A record schema turns a `__proto__` field into the
// object's prototype on the way in, so the service's refusal would judge a schema the caller never
// sent and the tool would save with its declared argument missing. Each route's own registered body
// schema is mounted on a bare app and fed the raw JSON a caller sends.
describe("the write body keeps the schema map as it arrived", () => {
  const RAW_SCHEMA =
    '{"cpf":{"type":"string"},"__proto__":{"type":"string","required":true}}';

  async function ownKeysThrough(
    schema: unknown,
    raw: string,
    pick: (body: Record<string, unknown>) => unknown,
  ): Promise<string[]> {
    const app = new Elysia().post(
      "/t",
      ({ body }) => ({
        keys: Object.keys(pick(body as Record<string, unknown>) as object),
      }),
      { body: schema as typeof writeBody },
    );
    const res = await app.handle(
      new Request("http://localhost/t", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { keys: string[] }).keys;
  }

  const bodyOf = (method: string, path: string): unknown => {
    const route = (
      codeToolsController.routes as unknown as {
        method: string;
        path: string;
        hooks?: { body?: unknown };
      }[]
    ).find((r) => r.method === method && r.path === path);
    if (!route?.hooks?.body) throw new Error(`${method} ${path} has no body`);
    return route.hooks.body;
  };

  test("the create and update routes hand the service every field, __proto__ included", async () => {
    for (const [method, path] of [
      ["POST", "/v1/code-tools/"],
      ["PATCH", "/v1/code-tools/:id"],
    ] as const) {
      const keys = await ownKeysThrough(
        bodyOf(method, path),
        `{"name":"consulta","label":"Consulta","description":"d","code":"return 1","inputSchema":${RAW_SCHEMA}}`,
        (body) => body.inputSchema,
      );
      expect({ route: `${method} ${path}`, keys }).toEqual({
        route: `${method} ${path}`,
        keys: ["cpf", "__proto__"],
      });
    }
  });

  test("the test route hands the run every field, __proto__ included", async () => {
    const keys = await ownKeysThrough(
      bodyOf("POST", "/v1/code-tools/test"),
      `{"definition":{"code":"return 1","inputSchema":${RAW_SCHEMA}}}`,
      (body) => (body.definition as Record<string, unknown>).inputSchema,
    );
    expect(keys).toEqual(["cpf", "__proto__"]);
  });
});
