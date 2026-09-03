import { describe, expect, test } from "bun:test";
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
