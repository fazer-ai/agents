import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Elysia cleans a body to its schema before the handler runs, so a key the occurrence monitor does
// not have would be dropped and the write answered 200 with nothing changed. Through the real app:
// the key is refused as a 422, and a request with no session is still told to sign in first.

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

const put = (body: unknown, session = true) =>
  app.handle(
    new BunReq("http://localhost/api/v1/occurrences/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(session ? { cookie: `fazerai_auth_token=${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const field = {
  key: "motivo",
  name: "Motivo",
  description: "O motivo",
  attribute: false,
};

describe("a key the occurrence monitor does not have, at the HTTP boundary", () => {
  test("is a 422 in the block and in a field", async () => {
    const top = await put({ digestHour: 9 });
    expect(top.status).toBe(422);
    // A key the block has, out of its range, is refused by the range.
    expect((await put({ concentrationShare: 1.5 })).status).toBe(422);
    const inField = await put({ fields: [field, { ...field, color: "red" }] });
    expect(inField.status).toBe(422);
    expect(((await inField.json()) as { field?: string }).field).toBe(
      "fields.1",
    );
  });

  test("is a 422 in the model, naming where", async () => {
    const model = {
      provider: "openai",
      model: null,
      credentialRef: "vault:1",
      baseURL: null,
    };
    const inModel = await put({ model: { ...model, temperature: 0 } });
    expect(inModel.status).toBe(422);
    expect(((await inModel.json()) as { field?: string }).field).toBe("model");
    // The old agent of the rounds is a key the block no longer has.
    expect((await put({ agentId: "7" })).status).toBe(422);
  });

  test("the names the block had before are refused, not dropped", async () => {
    const model = {
      provider: "openai",
      model: null,
      credentialRef: "vault:1",
      baseURL: null,
    };
    for (const body of [
      { subjectField: "assunto" },
      { problemField: "assunto" },
      { models: { reading: model } },
    ])
      expect([body, (await put(body)).status]).toEqual([body, 422]);
  });

  test("without a session is told to sign in first", async () => {
    const res = await put({ digestHour: 9 }, false);
    expect(res.status).toBe(401);
  });
});
