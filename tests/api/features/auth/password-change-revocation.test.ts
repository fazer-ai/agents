// Changing the password signs out every other session of the account, keeps the caller signed in on
// a re-issued cookie, and closes the account's open sockets. A change that loses a race to another
// one is refused and revokes nothing.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Elysia } from "elysia";
import {
  mockFindUnique,
  mockUpdateMany,
  mockUser,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const { authController } = await import("@/api/features/auth/auth.controller");
const { hashPassword } = await import("@/api/features/auth/auth.service");
const { trackSocket, untrackSocket } = await import(
  "@/api/features/realtime/realtime.service"
);
const { authPlugin, passwordFingerprint } = await import("@/api/lib/auth");
const { WS_CLOSE } = await import("@/api/lib/realtime");

const nativeGlobals = globalThis as unknown as {
  BunRequest: typeof Request;
  BunResponse: typeof Response;
};
const happyResponse = globalThis.Response;

const OLD_PASSWORD = "the-old-password";
const NEW_PASSWORD = "the-new-password";

let stored = "";
let oldCookie = "";
let closes: number[] = [];

const app = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(mockUser, stored),
  }))
  .use(authController);

function payloadOf(token: string): { pwd?: string } {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function changePassword(cookie: string) {
  return app.handle(
    new nativeGlobals.BunRequest("http://localhost/auth/password", {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    }),
  );
}

function me(cookie: string) {
  return app.handle(
    new nativeGlobals.BunRequest("http://localhost/auth/me", {
      headers: { Cookie: cookie },
    }),
  );
}

beforeAll(() => {
  // NOTE: happy-dom's Response drops Set-Cookie, which is what carries the re-issued session.
  (globalThis as { Response: typeof Response }).Response =
    nativeGlobals.BunResponse;
});

afterAll(() => {
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

beforeEach(async () => {
  resetPrismaMocks();
  stored = await hashPassword(OLD_PASSWORD);
  mockFindUnique.mockImplementation(() =>
    Promise.resolve({ ...mockUser, passwordHash: stored }),
  );
  mockUpdateMany.mockImplementation(((args: {
    where: { passwordHash: string };
    data: { passwordHash: string };
  }) => {
    if (args.where.passwordHash !== stored)
      return Promise.resolve({ count: 0 });
    stored = args.data.passwordHash;
    return Promise.resolve({ count: 1 });
  }) as never);
  const { token } = (await (
    await app.handle(new Request("http://localhost/mint", { method: "POST" }))
  ).json()) as { token: string };
  oldCookie = `fazerai_auth_token=${token}`;
  closes = [];
  trackSocket(mockUser.id, "tab", { close: (code) => closes.push(code ?? 0) });
});

describe("PATCH /auth/password", () => {
  test("revokes the other sessions, re-issues the caller's own, and closes the sockets", async () => {
    const res = await changePassword(oldCookie);
    expect(res.status).toBe(200);
    expect(closes).toEqual([WS_CLOSE.CREDENTIALS_CHANGED]);

    const reissued = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("fazerai_auth_token="));
    expect(reissued).toBeDefined();
    const token = (reissued ?? "").split(";")[0]?.split("=")[1] ?? "";
    expect(payloadOf(token).pwd).toBe(passwordFingerprint(stored));

    expect((await me(`fazerai_auth_token=${token}`)).status).toBe(200);
    const before = (await (await me(oldCookie)).json()) as { user: unknown };
    expect(before.user).toBeNull();
  });

  test("a change that lost the race to another one answers 409 and revokes nothing", async () => {
    mockUpdateMany.mockImplementation(() => Promise.resolve({ count: 0 }));
    const res = await changePassword(oldCookie);
    expect(res.status).toBe(409);
    expect(closes).toEqual([]);
    expect(res.headers.getSetCookie()).toEqual([]);
    untrackSocket(mockUser.id, "tab");
  });
});
