import { describe, expect, test } from "bun:test";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The breaker's write route refuses a limit that is not a whole number of at least 1 at the schema,
// as a 422, before the role guard: a typo must come back readable, never as a guard stored as the
// default. Unauthenticated on purpose, so a valid body stops at the guard and proves the schema let
// it through. The resume route is admin-only too.

setupPrismaMock();
const app = (await import("@/app")).default;

const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const call = (method: string, path: string, body?: unknown) =>
  app.handle(
    new BunReq(`http://localhost/api/v1/tenant-settings/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe("the proactive breaker at the HTTP boundary", () => {
  test("a negative, fractional, zero or textual limit is a schema refusal", async () => {
    for (const limit of [-5, 1.5, 0, "abc"]) {
      const res = await call("PUT", "proactive-breaker", {
        mode: "fixed",
        limit,
      });
      expect([limit, res.status]).toEqual([limit, 422]);
    }
    const res = await call("PUT", "proactive-breaker", { mode: "sometimes" });
    expect(res.status).toBe(422);
  });

  test("a valid body gets past the schema and stops at the role guard", async () => {
    const res = await call("PUT", "proactive-breaker", {
      mode: "fixed",
      limit: 3,
    });
    expect([401, 403]).toContain(res.status);
  });

  test("resume and read need a session", async () => {
    expect([401, 403]).toContain(
      (await call("POST", "proactive-breaker/resume")).status,
    );
    expect([401, 403]).toContain(
      (await call("GET", "proactive-breaker")).status,
    );
  });
});
