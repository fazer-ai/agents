import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";
import config from "@/config";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The client turn route answers in JSON unless the host asks for `text/event-stream`, and only then
// hands the turn a progress callback. The turn itself is wrapped (tests/modules/client-channel-stream
// proves the stream and the events); this file proves the route picks the answer by the Accept header,
// and that with CLIENT_CHANNEL_ENABLED off it answers what a route that does not exist answers.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const service = await import("@/modules/client-channel/service");
const real = { ...service };
const streamed: boolean[] = [];
mock.module("@/modules/client-channel/service", () => ({
  ...real,
  runClientTurn: mock(
    async (params: Parameters<typeof real.runClientTurn>[0]) => {
      streamed.push(!!params.onEvent);
      params.onEvent?.({ type: "tool", phase: "start", name: "calculator" });
      params.onEvent?.({
        type: "tool",
        phase: "end",
        name: "calculator",
        ok: true,
      });
      return { threadId: "t1", status: "done" as const, reply: "deu 2" };
    },
  ),
}));

const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/client-channel/service", () => real);
});

const ADMIN_ID = 9468n;
const TENANT_ID = 9468n;
let cookie = "";

function turn(
  accept?: string,
  opts: { path?: string; auth?: boolean; body?: string; tenant?: string } = {},
) {
  return server.handle(
    new BunRequest(
      `http://localhost/api/v1/agents/1/${opts.path ?? "client/turn"}`,
      {
        method: "POST",
        headers: {
          ...(opts.auth === false ? {} : { cookie }),
          ...(opts.tenant ? { "x-tenant-id": opts.tenant } : {}),
          "content-type": "application/json",
          ...(accept ? { accept } : {}),
        },
        body:
          opts.body ??
          JSON.stringify({
            user: { id: "ana" },
            message: "quanto é 1+1?",
            clientTools: [],
          }),
      },
    ),
  );
}

describe("POST /v1/agents/:id/client/turn: JSON or a stream", () => {
  const was = config.clientChannel.enabled;
  afterAll(() => {
    config.clientChannel.enabled = was;
  });
  beforeAll(async () => {
    config.clientChannel.enabled = true;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId: TENANT_ID,
        email: "admin@example.com",
        passwordHash: null,
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
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret))}`;
  });

  test("without the header the answer is the JSON one, and the turn gets no callback", async () => {
    streamed.length = 0;
    const res = await turn("application/json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      threadId: "t1",
      status: "done",
      reply: "deu 2",
    });
    expect(streamed).toEqual([false]);
  });

  // A resume value is persisted by the graph, so a malformed one that reached it would fail every
  // corrected retry too: refused here, and the turn never runs.
  test("a tool answer of the wrong shape is refused before the turn runs", async () => {
    streamed.length = 0;
    const body = (answers: unknown) =>
      JSON.stringify({ user: { id: "ana" }, answers, clientTools: [] });
    const statuses = [];
    for (const answers of [
      { c1: { ok: false } },
      { c1: { ok: false, error: 7 } },
      { c1: { ok: "yes", result: 1 } },
      { c1: "pronto" },
    ]) {
      statuses.push((await turn(undefined, { body: body(answers) })).status);
    }
    expect(statuses).toEqual([422, 422, 422, 422]);
    expect(streamed).toEqual([]);
    const ok = await turn(undefined, {
      body: body({
        c1: { ok: true, result: 1 },
        c2: { ok: false, error: "x" },
      }),
    });
    expect(ok.status).toBe(200);
  });

  test("a user id in the SDK's namespaces is refused, so the host's key cannot speak for an app's user or an anonymous visitor", async () => {
    streamed.length = 0;
    const body = (id: string) =>
      JSON.stringify({ user: { id }, message: "oi", clientTools: [] });
    const statuses = [
      (await turn(undefined, { body: body("app:77:42") })).status,
      (await turn(undefined, { body: body("anon:77:AAAAAAAAAAAAAAAAAAAAAA") }))
        .status,
      (await turn(undefined, { body: body("ana:app:1") })).status,
    ];
    expect(statuses).toEqual([422, 422, 200]);
    expect(streamed).toEqual([false]);
  });

  test("with text/event-stream the tools come first, then the same answer", async () => {
    streamed.length = 0;
    const res = await turn("text/event-stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const text = await res.text();
    expect(text.match(/^event: .*$/gm)).toEqual([
      "event: tool",
      "event: tool",
      "event: done",
    ]);
    expect(text).toContain(
      'data: {"threadId":"t1","status":"done","reply":"deu 2"}',
    );
    expect(streamed).toEqual([true]);
  });

  test("off, the route answers what a missing route answers, before auth, the tenant selector and the body", async () => {
    config.clientChannel.enabled = false;
    try {
      streamed.length = 0;
      const missing = await turn(undefined, { path: "nao/existe" });
      const expected = { status: missing.status, body: await missing.text() };
      expect(expected.status).toBe(404);
      for (const opts of [
        {},
        { auth: false },
        { body: JSON.stringify({ user: {} }) },
        { body: "{ not json" },
        { tenant: "999999" },
      ]) {
        const res = await turn(undefined, opts);
        expect({ status: res.status, body: await res.text() }).toEqual(
          expected,
        );
      }
      const sse = await turn("text/event-stream");
      expect(sse.status).toBe(404);
      expect(streamed).toEqual([]);
    } finally {
      config.clientChannel.enabled = true;
    }
  });

  // The reference is built once, with the switch as the process started; tests start with it off.
  test("off, the API reference leaves the route out", async () => {
    const res = await server.handle(
      new BunRequest("http://localhost/api/docs/json"),
    );
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths).length).toBeGreaterThan(10);
    expect(Object.keys(spec.paths).some((p) => p.includes("client/turn"))).toBe(
      false,
    );
  });

  test("the console learns the switch from /auth/me", async () => {
    const me = async () =>
      (await (
        await server.handle(
          new BunRequest("http://localhost/api/auth/me", {
            headers: { cookie },
          }),
        )
      ).json()) as { clientChannelEnabled?: boolean };
    expect((await me()).clientChannelEnabled).toBe(true);
    config.clientChannel.enabled = false;
    try {
      expect((await me()).clientChannelEnabled).toBe(false);
    } finally {
      config.clientChannel.enabled = true;
    }
  });
});
