import { describe, expect, test } from "bun:test";
import { SignJWT, UnsecuredJWT } from "jose";
import { AppError } from "@/lib/errors";
import {
  chargeSdkLookup,
  chargeSdkRequest,
  FixedWindowLimiter,
  SdkRateLimitError,
} from "@/modules/client-apps/limits";
import { verifyClientAppToken } from "@/modules/client-apps/token";

// The JWT an embedding app's server signs for the SDK's turn, checked claim by claim, and the
// per-user and per-app budgets that stand in for the host's server on that route.

const KEY = "chave-da-aplicacao-de-teste-0123456789";
const NOW = new Date("2026-10-09T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);
const APP = {
  id: 77n,
  tenantId: 5n,
  agentId: 9n,
  publicId: "app_teste",
  allowedOrigins: ["https://app.exemplo.com"],
  anonymousEnabled: false,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileSecret: null,
  keys: new Map([
    ["key_a", KEY],
    ["key_b", "a-chave-anterior-ainda-na-janela-0123"],
  ]),
};

function sign(
  claims: Record<string, unknown> = {},
  opts: { kid?: string | null; key?: string; alg?: string } = {},
) {
  const body: Record<string, unknown> = {
    sub: "42",
    aud: APP.publicId,
    exp: nowS + 600,
    ...claims,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const header: Record<string, unknown> = { alg: opts.alg ?? "HS256" };
  if (opts.kid !== null) header.kid = opts.kid ?? "key_a";
  return new SignJWT(body)
    .setProtectedHeader(header as { alg: string })
    .sign(new TextEncoder().encode(opts.key ?? KEY));
}

async function outcome(token: string, app: typeof APP | null = APP) {
  try {
    return (await verifyClientAppToken(app, `Bearer ${token}`, NOW)).id;
  } catch (e) {
    if (e instanceof AppError) return e.statusCode;
    throw e;
  }
}

describe("the app's token", () => {
  test("a token signed with a valid key names one of this app's users", async () => {
    const user = await verifyClientAppToken(
      APP,
      `Bearer ${await sign({ name: "Ana", email: "ana@exemplo.com", scope: "org" })}`,
      NOW,
    );
    expect(user).toEqual({
      id: "app:77:42",
      name: "Ana",
      email: "ana@exemplo.com",
      scope: "org",
      anonymous: false,
    });
    expect(
      await outcome(
        await sign({}, { kid: "key_b", key: APP.keys.get("key_b") }),
      ),
    ).toBe("app:77:42");
  });

  test("every way a token can be wrong is the same 401", async () => {
    const cases: Record<string, string> = {
      "another key": await sign(
        {},
        { key: "outra-chave-qualquer-0123456789abcdef" },
      ),
      "unknown kid": await sign({}, { kid: "key_x" }),
      "no kid": await sign({}, { kid: null }),
      "another app's aud": await sign({ aud: "app_outra" }),
      "no aud": await sign({ aud: undefined }),
      expired: await sign({ exp: nowS - 120 }),
      "no exp": await sign({ exp: undefined }),
      "exp past an hour": await sign({ exp: nowS + 2 * 3600 }),
      "no sub": await sign({ sub: undefined }),
      "empty sub": await sign({ sub: "" }),
      "sub too long": await sign({ sub: "x".repeat(256) }),
      "email not an email": await sign({ email: "nao" }),
      HS512: await sign({}, { alg: "HS512" }),
      unsigned: new UnsecuredJWT({
        sub: "42",
        aud: APP.publicId,
        exp: nowS + 600,
      }).encode(),
      garbage: "nao.e.jwt",
    };
    const got: Record<string, unknown> = {};
    for (const [name, token] of Object.entries(cases))
      got[name] = await outcome(token);
    expect(got).toEqual(
      Object.fromEntries(Object.keys(cases).map((k) => [k, 401])),
    );
    expect(await outcome(await sign(), null)).toBe(401);
  });

  test("an hour ahead, within the clock's skew, is still accepted", async () => {
    expect(await outcome(await sign({ exp: nowS + 3600 }))).toBe("app:77:42");
    expect(await outcome(await sign({ exp: nowS - 30 }))).toBe("app:77:42");
  });
});

describe("the SDK's budgets", () => {
  test("a user over their budget is refused until the window ends, without spending the app's", () => {
    const on = new FixedWindowLimiter();
    const limits = { userPerMin: 2, appPerMin: 4 };
    const t0 = 1_000_000;
    const run = (user: string, at: number) => {
      try {
        chargeSdkRequest(1n, user, at, limits, on);
        return "ok";
      } catch (e) {
        if (e instanceof SdkRateLimitError) return e.retryAfterS;
        throw e;
      }
    };
    const ana = [run("ana", t0), run("ana", t0), run("ana", t0 + 15_000)];
    const bia = [run("bia", t0), run("bia", t0)];
    const third = run("caio", t0);
    const later = run("ana", t0 + 60_000);
    expect({ ana, bia, third, later }).toEqual({
      ana: ["ok", "ok", 45],
      bia: ["ok", "ok"],
      third: 60,
      later: "ok",
    });
  });

  test("two apps never share a bucket", () => {
    const on = new FixedWindowLimiter();
    const limits = { userPerMin: 1, appPerMin: 100 };
    chargeSdkRequest(1n, "ana", 0, limits, on);
    expect(() => chargeSdkRequest(2n, "ana", 0, limits, on)).not.toThrow();
  });

  test("an address over its lookup budget is refused before anything is read", () => {
    const on = new FixedWindowLimiter();
    chargeSdkLookup("10.0.0.1", 0, 2, on);
    chargeSdkLookup("10.0.0.1", 0, 2, on);
    expect(() => chargeSdkLookup("10.0.0.1", 0, 2, on)).toThrow(
      SdkRateLimitError,
    );
    expect(() => chargeSdkLookup("10.0.0.2", 0, 2, on)).not.toThrow();
  });

  test("expired buckets are swept once a window, not on every new bucket", () => {
    const on = new FixedWindowLimiter();
    const s = 1000;
    for (let i = 0; i < 15_000; i++) on.hit(`a${i}`, 10, 0);
    for (let i = 0; i < 15_000; i++) on.hit(`b${i}`, 10, 30 * s);
    on.hit("c", 10, 61 * s);
    const afterFirstSweep = on.size;
    on.hit("d", 10, 95 * s);
    const withinTheWindow = on.size;
    on.hit("e", 10, 122 * s);
    expect({ afterFirstSweep, withinTheWindow, nextWindow: on.size }).toEqual({
      afterFirstSweep: 15_001,
      withinTheWindow: 15_002,
      nextWindow: 2,
    });
  });
});
