import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// The rounds' page cursor at the HTTP boundary: `before` is a round's id as `nextBefore` gave it, and
// anything else is refused before any read.

setupPrismaMock();
const app = (await import("@/app")).default;

const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const admin = { ...mockUser, role: "TENANT_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin, admin.passwordHash),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

const get = (path: string) =>
  app.handle(
    new BunReq(`http://localhost${path}`, {
      headers: { cookie: `fazerai_auth_token=${token}` },
    }),
  );

describe("the rounds' page cursor", () => {
  test("a cursor that is not a round's id is a 422", async () => {
    for (const before of ["abc", "0", "-1", "1.5", " 7"])
      expect(
        (
          await get(
            `/api/v1/occurrences/runs?before=${encodeURIComponent(before)}`,
          )
        ).status,
      ).toBe(422);
  });
});
