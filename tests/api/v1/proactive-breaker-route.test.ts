import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// The breaker's write route refuses a limit that is not a whole number of at least 1 at the schema,
// as a 422, before the role guard: a typo must come back readable, never as a guard stored as the
// default. As an AGENT on purpose: a valid body then stops at the role guard, which proves the schema
// let it through. With no session at all the gate answers 401 before the input is looked at.

setupPrismaMock();
const app = (await import("@/app")).default;

const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const agent = { ...mockUser, role: "AGENT" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(agent));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(agent, agent.passwordHash),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

const call = (method: string, path: string, body?: unknown, session = true) =>
  app.handle(
    new BunReq(`http://localhost/api/v1/tenant-settings/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: `fazerai_auth_token=${token}` } : {}),
      },
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
    expect(res.status).toBe(403);
    expect((await call("POST", "proactive-breaker/resume")).status).toBe(403);
  });

  test("without a session nothing is read or written", async () => {
    for (const [method, path] of [
      ["GET", "proactive-breaker"],
      ["PUT", "proactive-breaker"],
      ["POST", "proactive-breaker/resume"],
    ] as const) {
      const status = (await call(method, path, undefined, false)).status;
      expect([method, [401, 403].includes(status)]).toEqual([method, true]);
    }
  });
});
