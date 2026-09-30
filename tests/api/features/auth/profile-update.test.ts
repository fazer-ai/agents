// The display name is the one profile field a person edits about themselves: trimmed, blank clears
// it (the console then shows the email), and only for the signed-in account. /auth/me carries the
// account facts the Settings pages show next to it.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Elysia } from "elysia";
import { Prisma } from "@/../generated/prisma/client";
import {
  mockFindUnique,
  mockUpdate,
  mockUser,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const { authController } = await import("@/api/features/auth/auth.controller");
const { authPlugin } = await import("@/api/lib/auth");

const nativeGlobals = globalThis as unknown as {
  BunRequest: typeof Request;
  BunResponse: typeof Response;
};
const happyResponse = globalThis.Response;

const app = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(mockUser, mockUser.passwordHash),
  }))
  .use(authController);

let cookie = "";
type UpdateArgs = {
  where: { id: bigint };
  data: { name: string | null };
  select: Record<string, boolean>;
};
let updates: UpdateArgs[] = [];

function patchMe(body: unknown, withCookie = true) {
  return app.handle(
    new nativeGlobals.BunRequest("http://localhost/auth/me", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(withCookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  (globalThis as { Response: typeof Response }).Response =
    nativeGlobals.BunResponse;
});

afterAll(() => {
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

beforeEach(async () => {
  resetPrismaMocks();
  updates = [];
  mockFindUnique.mockImplementation(() =>
    Promise.resolve({ ...mockUser, googleId: "google-sub" }),
  );
  mockUpdate.mockImplementation(((args: UpdateArgs) => {
    updates.push(args);
    return Promise.resolve({ ...mockUser, name: args.data.name });
  }) as never);
  const { token } = (await (
    await app.handle(new Request("http://localhost/mint", { method: "POST" }))
  ).json()) as { token: string };
  cookie = `fazerai_auth_token=${token}`;
});

describe("PATCH /auth/me", () => {
  test("stores the trimmed name for the signed-in account and answers with it", async () => {
    const res = await patchMe({ name: "  Ana Souza  " });
    expect(res.status).toBe(200);
    expect(updates).toEqual([
      expect.objectContaining({
        where: { id: mockUser.id },
        data: { name: "Ana Souza" },
      }),
    ]);
    const body = (await res.json()) as { user: { id: string; name: string } };
    expect(body.user).toMatchObject({ id: "1", name: "Ana Souza" });
  });

  // The mock takes any selection, the real client refuses a field the schema marks @ignore (the
  // person row's legacy role), so the selection is held to the fields the client knows.
  test("selects only fields the Prisma client exposes on the person row", async () => {
    await patchMe({ name: "Ana" });
    const known = new Set<string>(Object.values(Prisma.UserScalarFieldEnum));
    expect(Object.keys(updates[0]?.select ?? {})).not.toHaveLength(0);
    for (const field of Object.keys(updates[0]?.select ?? {}))
      expect(known.has(field)).toBe(true);
  });

  test("answers with the role resolved for the session", async () => {
    const body = (await (await patchMe({ name: "Ana" })).json()) as {
      user: { role: string };
    };
    expect(body.user.role).toBe(mockUser.role);
  });

  test("a blank name clears it", async () => {
    const res = await patchMe({ name: "   " });
    expect(res.status).toBe(200);
    expect(updates[0]?.data).toEqual({ name: null });
  });

  test("anonymous is refused and writes nothing", async () => {
    const res = await patchMe({ name: "Ana" }, false);
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  test("a name over 100 characters is refused before any write", async () => {
    const res = await patchMe({ name: "a".repeat(101) });
    expect(res.status).toBe(422);
    expect(updates).toEqual([]);
  });
});

describe("GET /auth/me", () => {
  test("carries when the account was created and whether Google is linked", async () => {
    const res = await app.handle(
      new nativeGlobals.BunRequest("http://localhost/auth/me", {
        headers: { Cookie: cookie },
      }),
    );
    const body = (await res.json()) as {
      user: { createdAt: string; googleLinked: boolean; hasPassword: boolean };
    };
    expect(body.user).toMatchObject({
      createdAt: mockUser.createdAt.toISOString(),
      googleLinked: true,
      hasPassword: true,
    });
  });
});
