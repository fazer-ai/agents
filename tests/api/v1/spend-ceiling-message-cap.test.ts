import { describe, expect, test } from "bun:test";
import { TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// What the route accepts and what the service refuses have to be the same number: the Zod schema in
// `updateSpendCeiling` caps the customer sentence at TEMPLATE_MESSAGE_MAX, and a longer message the
// route's body schema let through would throw a raw ZodError in the service and reach the global
// `onError` (src/app.ts) as a 500, on an endpoint that documents 422.
//
// Driven through the REAL app, since a unit asserting the TypeBox type would pass on a route that
// never used it. Unauthenticated on purpose: schema validation runs BEFORE the role guard, which is
// what makes the pair of answers below the whole assertion.

setupPrismaMock();
const app = (await import("@/app")).default;

const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const put = (overCeilingMessage: string) =>
  app.handle(
    new BunReq("http://localhost/api/v1/tenant-settings/spend-ceiling", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overCeilingMessage }),
    }),
  );

describe("the over-ceiling message at the HTTP boundary", () => {
  test("one character past the cap is a schema refusal, not a server error", async () => {
    const res = await put("x".repeat(TEMPLATE_MESSAGE_MAX + 1));
    expect(res.status).toBe(422);
  });

  // The control, and the half that makes the number meaningful rather than the direction: a message
  // AT the cap must get past the schema, so it stops at the role guard instead. Without this, a
  // route that refused every string would pass the test above.
  test("a message exactly at the cap is not refused by the schema", async () => {
    const res = await put("x".repeat(TEMPLATE_MESSAGE_MAX));
    expect(res.status).not.toBe(422);
    expect([401, 403]).toContain(res.status);
  });
});
