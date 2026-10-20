import { afterAll, describe, expect, mock, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import config from "@/config";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The anonymous session at the request boundary: a page of an app that allows anonymous visitors asks
// the instance for a session and a token, and the turn takes that token like the app's own. The app
// lookup and the turn are replaced; the credential and the token are signed and verified for real.
// What this file proves: only from the app's origins and only while the app allows it, the same
// browser keeps its session, a credential the instance did not sign starts a new one, new sessions
// are counted per address, the token names an anonymous user no host or tenant key can name, and it
// stops working the moment the operator turns anonymous sessions off.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const ORIGIN = "https://ajuda.exemplo.com";
const base = {
  tenantId: 5n,
  agentId: 9n,
  allowedOrigins: [ORIGIN],
  anonymousEnabled: true,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileSecret: null,
  keys: new Map([["key_a", "chave-da-aplicacao-de-teste-0123456789"]]),
};
const OPEN = { ...base, id: 81n, publicId: "app_aberta" };
const CLOSED = {
  ...base,
  id: 82n,
  publicId: "app_fechada",
  anonymousEnabled: false,
};
const TIGHT = {
  ...base,
  id: 83n,
  publicId: "app_justa",
  anonSessionsPerHour: 2,
};
const CHATTY = {
  ...base,
  id: 84n,
  publicId: "app_falante",
  anonMessagesPerMin: 2,
};
const CAPPED = {
  ...base,
  id: 85n,
  publicId: "app_com_teto",
  monthlyCeilingCents: 1000,
};
const CHALLENGED = {
  ...base,
  id: 86n,
  publicId: "app_com_desafio",
  turnstileSecret: "segredo-turnstile",
};
const CHALLENGED_TIGHT = {
  ...CHALLENGED,
  id: 87n,
  publicId: "app_desafio_justa",
  anonSessionsPerHour: 2,
};
// One new session an hour, for the renewal test alone: its allowance is spent on purpose.
const RENEWING = {
  ...base,
  id: 99n,
  publicId: "app_renova",
  anonSessionsPerHour: 1,
};
const APPS = new Map(
  [
    OPEN,
    CLOSED,
    TIGHT,
    CHATTY,
    CAPPED,
    CHALLENGED,
    CHALLENGED_TIGHT,
    RENEWING,
  ].map((a) => [a.publicId, a]),
);

const apps = await import("@/modules/client-apps/service");
const realApps = { ...apps };
mock.module("@/modules/client-apps/service", () => ({
  ...realApps,
  resolveClientApp: async (publicId: string) => APPS.get(publicId) ?? null,
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

const identity = await import("@/modules/client-channel/identity");
const realIdentity = { ...identity };
const handOvers: Array<
  Omit<
    Parameters<typeof realIdentity.handOverAnonymousThreads>[0],
    "base" | "checkpointer"
  >
> = [];
mock.module("@/modules/client-channel/identity", () => ({
  ...realIdentity,
  handOverAnonymousThreads: async (
    p: Parameters<typeof realIdentity.handOverAnonymousThreads>[0],
  ) => {
    const { base: _b, checkpointer: _c, ...rest } = p;
    handOvers.push(rest);
    return ["t-anonima"];
  },
}));
const checkpointer = await import("@/graph/checkpointer");
const realCheckpointer = { ...checkpointer };
mock.module("@/graph/checkpointer", () => ({
  ...realCheckpointer,
  getCheckpointer: async () => ({}),
}));

const spend = await import("@/modules/spend-ceiling/service");
const realSpend = { ...spend };
mock.module("@/modules/spend-ceiling/service", () => ({
  ...realSpend,
  readSpendSnapshot: async (_t: bigint, source: string) =>
    source === `app:${CAPPED.id}`
      ? {
          costUsd: 10,
          polledAt: new Date(),
          pollError: null,
          pollFailedAt: null,
        }
      : null,
}));

// Cloudflare is replaced: "resolvido" is the one token it accepts.
const turnstile = await import("@/modules/client-apps/turnstile");
const realTurnstile = { ...turnstile };
const verified: Array<[string, string]> = [];
mock.module("@/modules/client-apps/turnstile", () => ({
  ...realTurnstile,
  verifyTurnstile: async (secret: string, token: string) => {
    verified.push([secret, token]);
    return token === "resolvido";
  },
}));

const server = (await import("@/app")).default;

const was = { ...config.clientChannel };
config.clientChannel.enabled = true;
afterAll(() => {
  config.clientChannel.enabled = was.enabled;
  mock.module("@/modules/client-apps/service", () => realApps);
  mock.module("@/modules/client-channel/service", () => realChannel);
  mock.module("@/modules/client-channel/identity", () => realIdentity);
  mock.module("@/graph/checkpointer", () => realCheckpointer);
  mock.module("@/modules/spend-ceiling/service", () => realSpend);
  mock.module("@/modules/client-apps/turnstile", () => realTurnstile);
});

function post(
  app: string,
  path: "session" | "turn" | "session/claim",
  opts: { origin?: string | null; body?: unknown; token?: string } = {},
) {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  return server.handle(
    new BunRequest(`http://localhost/api/v1/sdk/${app}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(
        opts.body ??
          (path === "turn" ? { message: "oi", clientTools: [] } : {}),
      ),
    }),
  );
}

async function open(app = OPEN.publicId, body: unknown = {}) {
  const res = await post(app, "session", { body });
  return {
    status: res.status,
    acao: res.headers.get("access-control-allow-origin"),
    ...((res.ok ? await res.json() : {}) as {
      session?: string;
      token?: string;
    }),
  };
}

describe("the anonymous session", () => {
  test("a page of an app that allows it gets a session and a token for one anonymous user", async () => {
    const s = await open();
    const claims = decodeJwt(s.token as string);
    expect({
      status: s.status,
      acao: s.acao,
      session: /^anon_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(
        s.session as string,
      ),
      kid: decodeProtectedHeader(s.token as string).kid,
      aud: claims.aud,
      life: (claims.exp as number) - (claims.iat as number),
      sameId: (s.session as string).slice(5, 27) === claims.sub,
    }).toEqual({
      status: 200,
      acao: ORIGIN,
      session: true,
      kid: "anon",
      aud: OPEN.publicId,
      life: 600,
      sameId: true,
    });
  });

  test("sent back, the credential keeps the same session; one the instance did not sign starts another", async () => {
    const first = await open();
    const again = await open(OPEN.publicId, { session: first.session });
    const forged = `${(first.session as string).slice(0, -1)}${(first.session as string).endsWith("A") ? "B" : "A"}`;
    const replaced = await open(OPEN.publicId, { session: forged });
    const otherApp = await open(TIGHT.publicId, { session: first.session });
    expect({
      kept: again.session === first.session,
      sameUser:
        decodeJwt(again.token as string).sub ===
        decodeJwt(first.token as string).sub,
      forgedIsNew: replaced.session !== forged && replaced.status === 200,
      otherAppIsNew: otherApp.session !== first.session,
    }).toEqual({
      kept: true,
      sameUser: true,
      forgedIsNew: true,
      otherAppIsNew: true,
    });
  });

  test("refused for an app that does not allow it, from a foreign origin and with no origin", async () => {
    const statuses = [
      (await post(CLOSED.publicId, "session")).status,
      (
        await post(OPEN.publicId, "session", {
          origin: "https://outro.exemplo.com",
        })
      ).status,
      (await post(OPEN.publicId, "session", { origin: null })).status,
      (await post("app_nenhuma", "session")).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403]);
  });

  test("new sessions are counted per address, and renewing one already held is not", async () => {
    const a = await open(TIGHT.publicId);
    await open(TIGHT.publicId);
    const third = await post(TIGHT.publicId, "session");
    const renewed = await open(TIGHT.publicId, { session: a.session });
    expect({
      third: third.status,
      retryAfter: Number(third.headers.get("retry-after")) > 0,
      cors: third.headers.get("access-control-allow-origin"),
      renewed: renewed.status,
    }).toEqual({ third: 429, retryAfter: true, cors: ORIGIN, renewed: 200 });
  });
});

describe("renewing only, as a page that just reopened asks", () => {
  // The address's hourly allowance is spent first: a renewal that reached it would answer 429, so a
  // 404 says the unknown credential was refused before any new session was counted.
  test("a held session is renewed; an unknown or missing one is refused before the allowance", async () => {
    const held = await open(RENEWING.publicId, {});
    const spent = (await post(RENEWING.publicId, "session")).status;
    const forged = `${(held.session as string).slice(0, -1)}${(held.session as string).endsWith("A") ? "B" : "A"}`;
    const renewed = await open(RENEWING.publicId, {
      session: held.session,
      renew: true,
    });
    const unknown = await post(RENEWING.publicId, "session", {
      body: { session: forged, renew: true },
    });
    const missing = await post(RENEWING.publicId, "session", {
      body: { renew: true },
    });
    expect({
      spent,
      renewed: [renewed.status, renewed.session === held.session],
      unknown: [
        unknown.status,
        ((await unknown.json()) as { error?: string }).error,
      ],
      cors: unknown.headers.get("access-control-allow-origin"),
      missing: missing.status,
    }).toEqual({
      spent: 429,
      renewed: [200, true],
      unknown: [404, "This anonymous session is not known; open a new one"],
      cors: ORIGIN,
      missing: 404,
    });
  });
});

describe("the Turnstile challenge before a new session", () => {
  test("a new session needs a token Cloudflare accepts, checked with the app's secret", async () => {
    verified.length = 0;
    const none = await post(CHALLENGED.publicId, "session");
    const noneBody = (await none.json()) as { field?: string };
    const wrong = await open(CHALLENGED.publicId, { turnstile: "errado" });
    const solved = await open(CHALLENGED.publicId, { turnstile: "resolvido" });
    expect({
      none: none.status,
      field: noneBody.field,
      wrong: wrong.status,
      solved: solved.status,
      token: decodeProtectedHeader(solved.token as string).kid,
      verified,
    }).toEqual({
      none: 403,
      field: "turnstile",
      wrong: 403,
      solved: 200,
      token: "anon",
      verified: [
        ["segredo-turnstile", "errado"],
        ["segredo-turnstile", "resolvido"],
      ],
    });
  });

  test("renewing a held session asks no challenge; a credential the instance did not sign does", async () => {
    const solved = await open(CHALLENGED.publicId, { turnstile: "resolvido" });
    verified.length = 0;
    const renewed = await open(CHALLENGED.publicId, {
      session: solved.session,
    });
    const forged = await post(CHALLENGED.publicId, "session", {
      body: { session: `${(solved.session as string).slice(0, -2)}xx` },
    });
    expect({
      renewed: renewed.status,
      same: renewed.session === solved.session,
      forged: forged.status,
      verified: verified.length,
    }).toEqual({ renewed: 200, same: true, forged: 403, verified: 0 });
  });

  test("an app with the challenge off ignores the field", async () => {
    verified.length = 0;
    const s = await open(OPEN.publicId, { turnstile: "errado" });
    expect({ status: s.status, verified: verified.length }).toEqual({
      status: 200,
      verified: 0,
    });
  });

  test("a request with no token spends nothing, so a stale credential's probe cannot lock the solved retry out", async () => {
    const LONE = {
      ...CHALLENGED,
      id: 88n,
      publicId: "app_desafio_um",
      anonSessionsPerHour: 1,
    };
    APPS.set(LONE.publicId, LONE);
    const probes = [];
    for (let i = 0; i < 3; i++)
      probes.push(
        (
          await post(LONE.publicId, "session", {
            body: { session: "anon_desconhecida.sig" },
          })
        ).status,
      );
    const solved = await open(LONE.publicId, { turnstile: "resolvido" });
    expect({ probes, solved: solved.status }).toEqual({
      probes: [403, 403, 403],
      solved: 200,
    });
  });

  test("a failed challenge spends the address's hourly allowance, and past it Cloudflare is not called", async () => {
    verified.length = 0;
    await open(CHALLENGED_TIGHT.publicId, { turnstile: "errado" });
    await open(CHALLENGED_TIGHT.publicId, { turnstile: "errado" });
    const third = await open(CHALLENGED_TIGHT.publicId, {
      turnstile: "resolvido",
    });
    expect({ third: third.status, verified: verified.length }).toEqual({
      third: 429,
      verified: 2,
    });
  });
});

describe("the turn with an anonymous token", () => {
  test("runs as an anonymous user of this app, with no name, email or scope", async () => {
    const s = await open();
    turns.length = 0;
    const res = await post(OPEN.publicId, "turn", { token: s.token });
    expect({ status: res.status, user: turns[0]?.user }).toEqual({
      status: 200,
      user: { id: `anon:${OPEN.id}:${decodeJwt(s.token as string).sub}` },
    });
  });

  test("is limited by the app's messages per session", async () => {
    const s = await open(CHATTY.publicId);
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await post(CHATTY.publicId, "turn", { token: s.token })).status,
      );
    expect(statuses).toEqual([200, 200, 429]);
  });

  test("stops working when the operator turns anonymous sessions off", async () => {
    const s = await open();
    APPS.set(OPEN.publicId, { ...OPEN, anonymousEnabled: false });
    try {
      expect(
        (await post(OPEN.publicId, "turn", { token: s.token })).status,
      ).toBe(401);
    } finally {
      APPS.set(OPEN.publicId, OPEN);
    }
  });

  test("is not accepted by another app", async () => {
    const s = await open();
    expect(
      (await post(TIGHT.publicId, "turn", { token: s.token })).status,
    ).toBe(401);
  });
});

describe("the preflight", () => {
  test("answers the session route for the app's origins", async () => {
    const res = await server.handle(
      new BunRequest(`http://localhost/api/v1/sdk/${OPEN.publicId}/session`, {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );
    expect({
      status: res.status,
      acao: res.headers.get("access-control-allow-origin"),
    }).toEqual({
      status: 204,
      acao: ORIGIN,
    });
  });
});

describe("handing an anonymous session over", () => {
  const signed = (sub: string, scope?: string) =>
    new SignJWT(scope ? { scope } : {})
      .setProtectedHeader({ alg: "HS256", kid: "key_a" })
      .setAudience(OPEN.publicId)
      .setSubject(sub)
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(base.keys.get("key_a")));

  test("the signed-in user takes the session's conversations, in the token's scope", async () => {
    const s = await open();
    handOvers.length = 0;
    const res = await post(OPEN.publicId, "session/claim", {
      token: await signed("42", "org-9"),
      body: { session: s.session },
    });
    expect({
      status: res.status,
      acao: res.headers.get("access-control-allow-origin"),
      body: await res.json(),
      handOvers,
    }).toEqual({
      status: 200,
      acao: ORIGIN,
      body: { threadIds: ["t-anonima"] },
      handOvers: [
        {
          ctx: {
            tenantId: 5n,
            userId: null,
            role: "TENANT_ADMIN",
            actorType: "system",
          },
          agentId: 9n,
          from: `anon:${OPEN.id}:${decodeJwt(s.token as string).sub}`,
          to: {
            id: `app:${OPEN.id}:42`,
            scope: "org-9",
            name: undefined,
            email: undefined,
          },
        },
      ],
    });
  });

  test("an anonymous token cannot take a session, and a credential the instance did not sign hands nothing", async () => {
    const s = await open();
    handOvers.length = 0;
    const byAnon = await post(OPEN.publicId, "session/claim", {
      token: s.token,
      body: { session: s.session },
    });
    const forged = await post(OPEN.publicId, "session/claim", {
      token: await signed("42"),
      body: {
        session:
          "anon_AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      },
    });
    expect({
      byAnon: byAnon.status,
      forged: [forged.status, await forged.json()],
      handOvers: handOvers.length,
    }).toEqual({ byAnon: 401, forged: [200, { threadIds: [] }], handOvers: 0 });
  });
});

describe("the app's own spend ceiling on the turn", () => {
  test("an app past its ceiling refuses the turn, with its CORS so the page can read it", async () => {
    const s = await open(CAPPED.publicId);
    turns.length = 0;
    const res = await post(CAPPED.publicId, "turn", { token: s.token });
    expect({
      status: res.status,
      acao: res.headers.get("access-control-allow-origin"),
      ran: turns.length,
    }).toEqual({ status: 429, acao: ORIGIN, ran: 0 });
  });
});
