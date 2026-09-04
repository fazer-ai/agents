import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { writeBody } from "@/api/v1/code-tools.controller";
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

  test("code and description specifically are present", () => {
    expect(Object.keys(writeBody.properties)).toContain("code");
    expect(Object.keys(writeBody.properties)).toContain("description");
  });
});

// The transport must not rebuild the field map. A record schema turns a `__proto__` field into the
// object's prototype on the way in, so the service's refusal would judge a schema the caller never
// sent and the tool would save with its declared argument missing (measured: `t.Record` answers own
// keys `["cpf"]` for a body that also sent `__proto__`).
describe("the write body keeps the schema map as it arrived", () => {
  test("inputSchema is not a Record on either the write or the test route", () => {
    const src = readFileSync("src/api/v1/code-tools.controller.ts", "utf8");
    const records = [
      ...src.matchAll(/inputSchema: t\.Optional\(\s*t\.Record/g),
    ];
    expect(records.length).toBe(0);
    expect(src.includes("inputSchema: t.Optional(\n    t.Unknown({")).toBe(
      true,
    );
  });
});
