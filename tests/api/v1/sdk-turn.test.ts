import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";
import config from "@/config";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The SDK's turn at the request boundary: called from an embedding app's page with the JWT its server
// signed. The token is verified for real (jose); the app lookup and the turn itself are replaced, so
// what this file proves is the door: CORS only for the app's origins and on every answer the page must
// read (401, 429), a foreign origin refused, the user taken from the token as one of THIS app's users,
// the per-user limit, and the whole route absent with CLIENT_CHANNEL_ENABLED off.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const ORIGIN = "https://app.exemplo.com";
const KEY = "chave-da-aplicacao-de-teste-0123456789";
const APP = {
  id: 77n,
  tenantId: 5n,
  agentId: 9n,
  publicId: "app_teste",
  allowedOrigins: [ORIGIN],
  anonymousEnabled: false,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileSecret: null,
  keys: new Map([["key_a", KEY]]),
};

// An app no other test touches, so nothing has looked it up before the test that needs it fresh.
const OTHER_APP = { ...APP, id: 78n, publicId: "app_outra" };

const apps = await import("@/modules/client-apps/service");
const realApps = { ...apps };
let lookups = 0;
mock.module("@/modules/client-apps/service", () => ({
  ...realApps,
  resolveClientApp: async (publicId: string) => {
    lookups += 1;
    if (publicId === APP.publicId) return APP;
    return publicId === OTHER_APP.publicId ? OTHER_APP : null;
  },
}));

const channel = await import("@/modules/client-channel/service");
const realChannel = { ...channel };
const turns: Array<Parameters<typeof realChannel.runClientTurn>[0]> = [];
mock.module("@/modules/client-channel/service", () => ({
  ...realChannel,
  runClientTurn: async (
    params: Parameters<typeof realChannel.runClientTurn>[0],
  ) => {
    turns.push(params);
    return { threadId: "t1", status: "done" as const, reply: "oi" };
  },
}));

const server = (await import("@/app")).default;

const was = { ...config.clientChannel, sdk: { ...config.clientChannel.sdk } };
const ipBudget = config.rateLimit.userPerMin;
afterAll(() => {
  config.rateLimit.userPerMin = ipBudget;
  config.clientChannel.enabled = was.enabled;
  config.clientChannel.sdk = was.sdk;
  mock.module("@/modules/client-apps/service", () => realApps);
  mock.module("@/modules/client-channel/service", () => realChannel);
});

async function sign(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; key?: string; exp?: string } = {},
) {
  return new SignJWT({ name: "Ana", ...claims })
    .setProtectedHeader({ alg: "HS256", kid: opts.kid ?? "key_a" })
    .setAudience(APP.publicId)
    .setSubject((claims.sub as string) ?? "42")
    .setExpirationTime(opts.exp ?? "10m")
    .sign(new TextEncoder().encode(opts.key ?? KEY));
}

function call(
  method: "POST" | "OPTIONS",
  opts: {
    app?: string;
    origin?: string | null;
    token?: string;
    body?: string;
  } = {},
) {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  return server.handle(
    new BunRequest(
      `http://localhost/api/v1/sdk/${opts.app ?? APP.publicId}/turn`,
      {
        method,
        headers: {
          ...(origin ? { origin } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(method === "OPTIONS"
            ? {
                "access-control-request-method": "POST",
                "access-control-request-headers": "authorization,content-type",
              }
            : { "content-type": "application/json" }),
        },
        ...(method === "POST"
          ? {
              body:
                opts.body ?? JSON.stringify({ message: "oi", clientTools: [] }),
            }
          : {}),
      },
    ),
  );
}

const acao = (r: Response) => r.headers.get("access-control-allow-origin");

describe("the SDK's turn at the request boundary", () => {
  beforeEach(() => {
    config.clientChannel.enabled = true;
    config.clientChannel.sdk = { userPerMin: 1000, appPerMin: 1000 };
    config.rateLimit.userPerMin = ipBudget;
    turns.length = 0;
  });

  test("off, the route answers what a missing route answers, preflight included", async () => {
    config.clientChannel.enabled = false;
    const statuses = [
      (await call("OPTIONS")).status,
      (await call("POST", { token: await sign() })).status,
    ];
    expect(statuses).toEqual([404, 404]);
    expect(turns.length).toBe(0);
  });

  test("the preflight opens only for the app's own origins", async () => {
    const allowed = await call("OPTIONS");
    const foreign = await call("OPTIONS", { origin: "https://outra.com" });
    const unknownApp = await call("OPTIONS", { app: "app_nada" });
    expect({
      allowed: [allowed.status, acao(allowed)],
      allowsAuth: allowed.headers
        .get("access-control-allow-headers")
        ?.includes("authorization"),
      foreign: [foreign.status, acao(foreign)],
      unknownApp: [unknownApp.status, acao(unknownApp)],
    }).toEqual({
      allowed: [204, ORIGIN],
      allowsAuth: true,
      foreign: [403, null],
      unknownApp: [403, null],
    });
  });

  test("a valid token runs the turn as one of this app's users, in the app's tenant and agent", async () => {
    const res = await call("POST", {
      token: await sign({
        sub: "42",
        email: "ana@exemplo.com",
        scope: "org-1",
      }),
    });
    expect([
      res.status,
      acao(res),
      res.headers.get("access-control-allow-credentials"),
    ]).toEqual([200, ORIGIN, null]);
    expect((await res.json()).reply).toBe("oi");
    const t = turns[0];
    expect({
      tenant: t?.ctx.tenantId,
      agent: t?.agentId,
      user: t?.user,
    }).toEqual({
      tenant: 5n,
      agent: 9n,
      user: {
        id: "app:77:42",
        name: "Ana",
        email: "ana@exemplo.com",
        scope: "org-1",
      },
    });
  });

  test("a refused token is a 401 the page can read, the same for every reason", async () => {
    const bad = [
      undefined,
      "nao-e-um-jwt",
      await sign({}, { key: "outra-chave-qualquer-0123456789abcdef" }),
      await sign({}, { kid: "key_desconhecida" }),
      await sign({}, { exp: "2h" }),
    ];
    const answers: Array<[number, string | null, string]> = [];
    for (const token of bad) {
      const r = await call("POST", { token });
      answers.push([r.status, acao(r), (await r.json()).error]);
    }
    const unknownApp = await call("POST", {
      app: "app_nada",
      origin: null,
      token: await sign(),
    });
    expect(answers).toEqual(bad.map(() => [401, ORIGIN, "Invalid token"]));
    expect(unknownApp.status).toBe(401);
    expect(turns.length).toBe(0);
  });

  test("a foreign origin is refused before the token is read, with no CORS header", async () => {
    const r = await call("POST", {
      origin: "https://outra.com",
      token: await sign(),
    });
    expect([r.status, acao(r)]).toEqual([403, null]);
    expect(turns.length).toBe(0);
  });

  test("with no Origin (a server holding a token) the token alone decides", async () => {
    const r = await call("POST", { origin: null, token: await sign() });
    expect([r.status, acao(r)]).toEqual([200, null]);
  });

  test("a user over their budget gets a 429 the page can read, with Retry-After, and another user still passes", async () => {
    config.clientChannel.sdk = { userPerMin: 2, appPerMin: 1000 };
    const ana = await sign({ sub: "limite-ana" });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 3; i++) {
      last = await call("POST", { token: ana });
      statuses.push(last.status);
    }
    const bia = await call("POST", {
      token: await sign({ sub: "limite-bia" }),
    });
    expect(statuses).toEqual([200, 200, 429]);
    expect({
      acao: last ? acao(last) : null,
      retryAfter: Number(last?.headers.get("retry-after")) > 0,
      other: bia.status,
      exposed: last?.headers.get("access-control-expose-headers"),
    }).toEqual({
      acao: ORIGIN,
      retryAfter: true,
      other: 200,
      exposed: "Retry-After",
    });
  });

  test("a body refused before the handler runs still carries the app's CORS headers", async () => {
    const token = await sign();
    const invalid = await call("POST", { token, body: "{}" });
    const unparsable = await call("POST", { token, body: "{nope" });
    expect({
      invalid: [invalid.status, acao(invalid)],
      unparsable: [unparsable.status >= 400, acao(unparsable)],
      credentials: invalid.headers.get("access-control-allow-credentials"),
    }).toEqual({
      invalid: [422, ORIGIN],
      unparsable: [true, ORIGIN],
      credentials: null,
    });
    expect(turns.length).toBe(0);
  });

  test("an address over its budget is refused before the app is looked up, preflight included, and the app's page can still read it", async () => {
    await call("POST", { token: await sign() });
    turns.length = 0;
    config.rateLimit.userPerMin = 0;
    const before = lookups;
    const preflight = await call("OPTIONS");
    const post = await call("POST", { token: await sign() });
    const foreign = await call("POST", {
      origin: "https://outra.com",
      token: await sign(),
    });
    expect({
      preflight: preflight.status,
      post: post.status,
      retryAfter: Number(post.headers.get("retry-after")) > 0,
      readable: [acao(post), post.headers.get("access-control-expose-headers")],
      foreign: [foreign.status, acao(foreign)],
      looked: lookups - before,
    }).toEqual({
      preflight: 429,
      post: 429,
      retryAfter: true,
      readable: [ORIGIN, "Retry-After"],
      foreign: [429, null],
      looked: 0,
    });
    expect(turns.length).toBe(0);
  });

  test("a path segment no app id can be is refused as the client's error, never a 500, and nothing is looked up", async () => {
    const before = lookups;
    const preflight = await call("OPTIONS", { app: "%zz" });
    const post = await call("POST", { app: "%zz", token: await sign() });
    const noOrigin = await call("POST", {
      app: "%zz",
      origin: null,
      token: await sign(),
    });
    expect({
      preflight: preflight.status,
      post: post.status,
      noOrigin: noOrigin.status,
      looked: lookups - before,
    }).toEqual({ preflight: 403, post: 422, noOrigin: 422, looked: 0 });
    expect(turns.length).toBe(0);
  });

  test("a preflight's lookup is what an address-budget refusal right after it reads its origins from", async () => {
    await call("OPTIONS", { app: OTHER_APP.publicId });
    config.rateLimit.userPerMin = 0;
    const post = await call("POST", {
      app: OTHER_APP.publicId,
      token: await sign(),
    });
    expect([post.status, acao(post)]).toEqual([429, ORIGIN]);
  });

  test("the widget's script is served for other origins' pages, and is absent with the channel off", async () => {
    const get = () =>
      server.handle(new BunRequest("http://localhost/api/v1/sdk/agent.js"));
    const on = await get();
    const script = await on.text();
    config.clientChannel.enabled = false;
    const off = await get();
    expect({
      status: on.status,
      type: on.headers.get("content-type"),
      corp: on.headers.get("cross-origin-resource-policy"),
      defines: script.includes("fazer-ai-agent"),
      off: off.status,
    }).toEqual({
      status: 200,
      type: "text/javascript; charset=utf-8",
      corp: "cross-origin",
      defines: true,
      off: 404,
    });
  });
});
