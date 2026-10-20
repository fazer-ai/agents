import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { appUserId } from "@/modules/client-apps/token";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The widget's list of earlier conversations at the request boundary: the same door as the turn
// (origin, token, request budget), the token's user and scope handed to the list as the turn hands
// them to its thread, and the page's cursor carried both ways without the page reading it. Which
// threads the list holds is proven against the database in tests/modules/client-channel-history.test.ts.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const ORIGIN = "https://app.exemplo.com";
const KEY = "chave-da-aplicacao-de-teste-0123456789";
const APP = {
  tenantId: 5n,
  agentId: 9n,
  allowedOrigins: [ORIGIN],
  anonymousEnabled: true,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileSecret: null,
  keys: new Map([["key_a", KEY]]),
  id: 97n,
  publicId: "app_historico",
};

const apps = await import("@/modules/client-apps/service");
const realApps = { ...apps };
mock.module("@/modules/client-apps/service", () => ({
  ...realApps,
  resolveClientApp: async (publicId: string) =>
    publicId === APP.publicId ? APP : null,
}));

const THREAD_A = "5:client:9:0b0f5a8e-6c1d-4d7e-9a51-1c2f3e4d5a6b";
const THREAD_B = "5:client:9:7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910";
const identity = await import("@/modules/client-channel/identity");
const realIdentity = { ...identity };
const asked: Array<Parameters<typeof realIdentity.listClientThreads>[0]> = [];
const read: Array<Parameters<typeof realIdentity.readClientTranscript>[0]> = [];
mock.module("@/modules/client-channel/identity", () => ({
  ...realIdentity,
  // The owner's thread is A; any other is not theirs, as the module answers it.
  readClientTranscript: async (
    p: Parameters<typeof realIdentity.readClientTranscript>[0],
  ) => {
    read.push(p);
    if (p.threadId !== THREAD_A)
      throw new AppError("thread not found", 404, "errors.threadNotFound");
    return {
      recorded: true,
      messages: [
        {
          id: 41n,
          role: "user" as const,
          text: "Por que a nota foi rejeitada?",
          voice: true,
          createdAt: new Date("2026-10-20T12:04:00.000Z"),
        },
        {
          id: 42n,
          role: "agent" as const,
          text: "Faltou o CNPJ.",
          voice: false,
          createdAt: new Date("2026-10-20T12:05:00.000Z"),
        },
      ],
      next: 41n,
    };
  },
  listClientThreads: async (
    p: Parameters<typeof realIdentity.listClientThreads>[0],
  ) => {
    asked.push(p);
    return {
      threads: [
        {
          threadId: THREAD_A,
          title: "Por que a nota foi rejeitada?",
          lastTurnAt: new Date("2026-10-20T12:05:00.000Z"),
        },
        {
          threadId: THREAD_B,
          title: null,
          lastTurnAt: new Date("2026-10-19T09:00:00.000Z"),
        },
      ],
      next: {
        before: new Date("2026-10-19T09:00:00.000Z"),
        beforeId: THREAD_B,
      },
    };
  },
}));

const turnsRun: Array<{ voice?: boolean }> = [];
const channel = await import("@/modules/client-channel/service");
const realChannel = { ...channel };
mock.module("@/modules/client-channel/service", () => ({
  ...realChannel,
  runClientTurn: async (p: { voice?: boolean }) => {
    turnsRun.push(p);
    return {
      threadId: THREAD_A,
      status: "done" as const,
      reply: "oi",
    };
  },
}));

const server = (await import("@/app")).default;

const was = { ...config.clientChannel, sdk: { ...config.clientChannel.sdk } };
afterAll(() => {
  config.clientChannel.enabled = was.enabled;
  config.clientChannel.sdk = was.sdk;
  mock.module("@/modules/client-apps/service", () => realApps);
  mock.module("@/modules/client-channel/identity", () => realIdentity);
  mock.module("@/modules/client-channel/service", () => realChannel);
});

async function sign(claims: Record<string, string> = {}, sub = "42") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "key_a" })
    .setAudience(APP.publicId)
    .setSubject(sub)
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(KEY));
}

function threads(
  opts: { token?: string; origin?: string | null; cursor?: string } = {},
) {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  const query = opts.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : "";
  return server.handle(
    new BunRequest(
      `http://localhost/api/v1/sdk/${APP.publicId}/threads${query}`,
      {
        headers: {
          ...(origin ? { origin } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
    ),
  );
}

function transcript(
  thread: string,
  opts: { token?: string; before?: string } = {},
) {
  const query = opts.before ? `?before=${encodeURIComponent(opts.before)}` : "";
  return server.handle(
    new BunRequest(
      `http://localhost/api/v1/sdk/${APP.publicId}/threads/${encodeURIComponent(thread)}/messages${query}`,
      {
        headers: {
          origin: ORIGIN,
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      },
    ),
  );
}

async function anonymousToken(): Promise<string> {
  const res = await server.handle(
    new BunRequest(`http://localhost/api/v1/sdk/${APP.publicId}/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    }),
  );
  return ((await res.json()) as { token: string }).token;
}

const acao = (r: Response) => r.headers.get("access-control-allow-origin");

describe("the SDK's list of conversations at the request boundary", () => {
  beforeEach(() => {
    config.clientChannel.enabled = true;
    config.clientChannel.sdk = { userPerMin: 1000, appPerMin: 1000 };
    asked.length = 0;
  });

  test("a signed-in user's list is asked for that user, scope and agent, and answered with its cursor", async () => {
    const res = await threads({ token: await sign({ scope: "org-1" }) });
    const p = asked[0];
    expect({
      status: res.status,
      acao: acao(res),
      body: await res.json(),
      tenant: p?.ctx.tenantId,
      agent: p?.agentId,
      user: p?.user.id,
      scope: p?.user.scope,
      limit: p?.limit,
      cursor: p?.cursor,
    }).toEqual({
      status: 200,
      acao: ORIGIN,
      body: {
        threads: [
          {
            threadId: THREAD_A,
            title: "Por que a nota foi rejeitada?",
            lastTurnAt: "2026-10-20T12:05:00.000Z",
          },
          {
            threadId: THREAD_B,
            title: null,
            lastTurnAt: "2026-10-19T09:00:00.000Z",
          },
        ],
        nextCursor: `${Date.parse("2026-10-19T09:00:00.000Z")}_${THREAD_B}`,
      },
      tenant: 5n,
      agent: 9n,
      user: appUserId(APP.id, "42"),
      scope: "org-1",
      limit: 20,
      cursor: undefined,
    });
  });

  test("the cursor the page hands back is the next page's start", async () => {
    const first = (await (await threads({ token: await sign() })).json()) as {
      nextCursor: string;
    };
    const res = await threads({
      token: await sign(),
      cursor: first.nextCursor,
    });
    expect({ status: res.status, cursor: asked[1]?.cursor }).toEqual({
      status: 200,
      cursor: {
        before: new Date("2026-10-19T09:00:00.000Z"),
        beforeId: THREAD_B,
      },
    });
  });

  test("a cursor the instance did not write is refused with its key, and nothing is listed", async () => {
    const res = await threads({
      token: await sign(),
      cursor: "123_not-a-thread",
    });
    expect({
      status: res.status,
      error: ((await res.json()) as { error?: string }).error,
      asked: asked.length,
    }).toEqual({
      status: 400,
      error: "This page cursor is not valid; ask for the list again",
      asked: 0,
    });
  });

  test("an anonymous visitor's list is asked for the visitor's own id", async () => {
    const res = await threads({ token: await anonymousToken() });
    expect({
      status: res.status,
      anonymous: asked[0]?.user.id.startsWith(`anon:${APP.id}:`),
    }).toEqual({ status: 200, anonymous: true });
  });

  test("a foreign origin and a missing token are refused as the turn refuses them, and nothing is listed", async () => {
    const foreign = await threads({
      token: await sign(),
      origin: "https://outro.exemplo.com",
    });
    const tokenless = await threads();
    expect({
      foreign: foreign.status,
      foreignAcao: acao(foreign),
      tokenless: tokenless.status,
      asked: asked.length,
    }).toEqual({ foreign: 403, foreignAcao: null, tokenless: 401, asked: 0 });
  });

  test("the preflight lets the page ask with GET", async () => {
    const res = await server.handle(
      new BunRequest(`http://localhost/api/v1/sdk/${APP.publicId}/threads`, {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
    );
    expect({
      status: res.status,
      acao: acao(res),
      methods: res.headers.get("access-control-allow-methods"),
    }).toEqual({ status: 204, acao: ORIGIN, methods: "GET, POST, OPTIONS" });
  });

  test("listing spends the same request budget as the turn", async () => {
    config.clientChannel.sdk = { userPerMin: 1, appPerMin: 1000 };
    const token = await sign({}, "orcamento");
    const listed = await threads({ token });
    const turn = await server.handle(
      new BunRequest(`http://localhost/api/v1/sdk/${APP.publicId}/turn`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "oi", clientTools: [] }),
      }),
    );
    expect({ listed: listed.status, turn: turn.status }).toEqual({
      listed: 200,
      turn: 429,
    });
  });

  test("with the channel off the route does not exist", async () => {
    config.clientChannel.enabled = false;
    const res = await threads({ token: await sign() });
    expect({ status: res.status, asked: asked.length }).toEqual({
      status: 404,
      asked: 0,
    });
  });
});

describe("the SDK's transcript of a conversation at the request boundary", () => {
  beforeEach(() => {
    config.clientChannel.enabled = true;
    config.clientChannel.sdk = { userPerMin: 1000, appPerMin: 1000 };
    read.length = 0;
  });

  test("the owner's conversation is read for that user, scope, agent and thread, with where the older page starts", async () => {
    const res = await transcript(THREAD_A, {
      token: await sign({ scope: "org-1" }),
    });
    const p = read[0];
    expect({
      status: res.status,
      acao: acao(res),
      body: await res.json(),
      agent: p?.agentId,
      user: p?.user.id,
      scope: p?.user.scope,
      thread: p?.threadId,
      limit: p?.limit,
      before: p?.before,
    }).toEqual({
      status: 200,
      acao: ORIGIN,
      body: {
        recorded: true,
        messages: [
          {
            role: "user",
            text: "Por que a nota foi rejeitada?",
            voice: true,
            at: "2026-10-20T12:04:00.000Z",
          },
          {
            role: "agent",
            text: "Faltou o CNPJ.",
            at: "2026-10-20T12:05:00.000Z",
          },
        ],
        before: "41",
      },
      agent: 9n,
      user: appUserId(APP.id, "42"),
      scope: "org-1",
      thread: THREAD_A,
      limit: 50,
      before: undefined,
    });
  });

  test("the page's `before` asks for the messages before it", async () => {
    const res = await transcript(THREAD_A, {
      token: await sign(),
      before: "41",
    });
    expect({ status: res.status, before: read[0]?.before }).toEqual({
      status: 200,
      before: 41n,
    });
  });

  test("a `before` that is not a message id is refused, and nothing is read", async () => {
    const res = await transcript(THREAD_A, {
      token: await sign(),
      before: "x1",
    });
    expect({ status: res.status, read: read.length }).toEqual({
      status: 400,
      read: 0,
    });
  });

  test("another user's conversation is not found", async () => {
    const res = await transcript(THREAD_B, { token: await sign({}, "outro") });
    expect({
      status: res.status,
      error: ((await res.json()) as { error?: string }).error,
    }).toEqual({ status: 404, error: "Thread not found." });
  });

  test("a missing token is refused before anything is read", async () => {
    const res = await transcript(THREAD_A);
    expect({ status: res.status, read: read.length }).toEqual({
      status: 401,
      read: 0,
    });
  });

  test("the preflight lets the page read a conversation", async () => {
    const res = await server.handle(
      new BunRequest(
        `http://localhost/api/v1/sdk/${APP.publicId}/threads/${encodeURIComponent(THREAD_A)}/messages`,
        {
          method: "OPTIONS",
          headers: {
            origin: ORIGIN,
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        },
      ),
    );
    expect({ status: res.status, acao: acao(res) }).toEqual({
      status: 204,
      acao: ORIGIN,
    });
  });

  test("a turn says whether its message was spoken, for the transcript", async () => {
    turnsRun.length = 0;
    const token = await sign();
    const post = (body: object) =>
      server.handle(
        new BunRequest(`http://localhost/api/v1/sdk/${APP.publicId}/turn`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ clientTools: [], ...body }),
        }),
      );
    await post({ message: "falado", voice: true });
    await post({ message: "escrito" });
    expect(turnsRun.map((p) => p.voice)).toEqual([true, undefined]);
  });
});
