import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";
import { passwordFingerprint } from "@/api/lib/auth";
import config from "@/config";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The client apps' routes at the request boundary: with CLIENT_CHANNEL_ENABLED off they answer what a
// missing route answers, before auth and the body; on, the two that mint a key (create and rotate)
// are a person's act confirmed with their password, and a wrong one reaches no service. The service
// itself is proved against the database in tests/modules/client-apps.test.ts; here it is wrapped to
// record that it was (or was not) reached, and calls through for everything else.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const service = await import("@/modules/client-apps/service");
const real = { ...service };
const reached: string[] = [];
const APP = {
  id: "7",
  agentId: "1",
  name: "Sinete",
  publicId: "app_x",
  allowedOrigins: ["https://app.exemplo.com"],
  anonymousEnabled: false,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileEnabled: false,
  turnstileSiteKey: null,
  turnstileSecret: null,
  secrets: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
mock.module("@/modules/client-apps/service", () => ({
  ...real,
  listClientApps: async () => {
    reached.push("list");
    return [APP];
  },
  createClientApp: async (_ctx: unknown, agentId: bigint) => {
    reached.push(`create:${agentId}`);
    return { app: APP, secret: { kid: "key_x", secret: "s3gr3do" } };
  },
  rotateClientAppSecret: async () => {
    reached.push("rotate");
    return { app: APP, secret: { kid: "key_y", secret: "outro" } };
  },
}));

const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/client-apps/service", () => real);
});

const ADMIN_ID = 9469n;
const TENANT_ID = 9469n;
const PASSWORD = "senha-certa-123";
let cookie = "";

function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; auth?: boolean } = {},
) {
  return server.handle(
    new BunRequest(`http://localhost/api/v1/client-apps${path}`, {
      method,
      headers: {
        ...(opts.auth === false ? {} : { cookie }),
        "content-type": "application/json",
      },
      ...(opts.raw !== undefined
        ? { body: opts.raw }
        : opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
    }),
  );
}

const ROUTES: Array<[string, string]> = [
  ["GET", "/?agentId=1"],
  ["GET", "/7"],
  ["POST", "/"],
  ["PATCH", "/7"],
  ["DELETE", "/7"],
  ["POST", "/7/secrets"],
  ["DELETE", "/7/secrets/key_x"],
];

describe("client apps at the request boundary", () => {
  const was = config.clientChannel.enabled;
  beforeAll(async () => {
    const passwordHash = await Bun.password.hash(PASSWORD);
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId: TENANT_ID,
        email: "admin@example.com",
        passwordHash,
        googleId: null,
        name: null,
        role: "TENANT_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    cookie = `fazerai_auth_token=${await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
      tenantId: TENANT_ID.toString(),
      pwd: passwordFingerprint(passwordHash),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret))}`;
  });
  afterAll(() => {
    config.clientChannel.enabled = was;
  });

  test("off, every route answers what a missing route answers, before auth and the body", async () => {
    config.clientChannel.enabled = false;
    const missing = await server.handle(
      new BunRequest("http://localhost/api/v1/nao-existe", { method: "GET" }),
    );
    const statuses: number[] = [];
    for (const [method, path] of ROUTES) {
      statuses.push((await call(method, path, { auth: false })).status);
      statuses.push((await call(method, path, { raw: "{nope" })).status);
    }
    expect(statuses).toEqual(ROUTES.flatMap(() => [404, 404]));
    expect(missing.status).toBe(404);
    expect(reached).toEqual([]);
  });

  test("on, creating an app needs the person's password, and a wrong one reaches no service", async () => {
    config.clientChannel.enabled = true;
    reached.length = 0;
    const body = {
      agentId: "1",
      name: "Sinete",
      allowedOrigins: ["https://app.exemplo.com"],
    };
    const statuses = [
      (await call("POST", "/", { body })).status,
      (await call("POST", "/", { body: { ...body, password: "errada" } }))
        .status,
    ];
    expect(statuses).toEqual([422, 403]);
    expect(reached).toEqual([]);
    const ok = await call("POST", "/", {
      body: { ...body, password: PASSWORD },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).secret).toEqual({
      kid: "key_x",
      secret: "s3gr3do",
    });
    expect(reached).toEqual(["create:1"]);
  });

  test("on, rotating a key needs the password too; listing does not", async () => {
    config.clientChannel.enabled = true;
    reached.length = 0;
    const statuses = [
      (await call("POST", "/7/secrets", { body: { password: "errada" } }))
        .status,
      (await call("POST", "/7/secrets", { body: { password: PASSWORD } }))
        .status,
      (await call("GET", "/?agentId=1")).status,
    ];
    expect(statuses).toEqual([403, 200, 200]);
    expect(reached).toEqual(["rotate", "list"]);
  });
});
