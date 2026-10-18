// The playground's call runs the agent's real tools as the operator, so its socket is the operator's
// session and not only the ticket that opened it: a logout or a password change closes it, a session
// that changed between the upgrade and `open` is refused before the call starts, and a ticket must
// be the operator's own. These drive real sockets against the controller.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Elysia } from "elysia";
import * as playgroundService from "@/modules/playground/service";
import * as elevenlabs from "@/modules/voice-call/providers/elevenlabs";
import type { VoiceSessionConfig } from "@/modules/voice-call/providers/types";
import * as setup from "@/modules/voice-call/setup";
import { stubExports } from "@/tests/utils/module-stub";
import { POLL_DEADLINE_MS, until } from "@/tests/utils/poll";
import {
  mockEndedSessionCount,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const { voicePlaygroundController } = await import("@/api/v1/voice.controller");
const { closeSessionSockets, closeUserSockets } = await import(
  "@/api/features/realtime/realtime.service"
);
const { authPlugin } = await import("@/api/lib/auth");
const { WS_CLOSE } = await import("@/api/lib/realtime");
const { issuePlaygroundCallTicket } = await import(
  "@/modules/voice-call/playground"
);

// The call stops while it is configured, before any engine: how often that ran is what is read.
let configured = 0;
// Set by a test that needs the call still up when the session ends: the configuration waits.
let holdSetup = false;
let releaseSetup: () => void = () => {};
// Set by a test that needs the call to reach its engine: the setup succeeds, the agent has one tool
// (which counts its runs) and the engine only records what it was opened with.
let callsReady = false;
let toolRuns = 0;
let engineOpenedWith: VoiceSessionConfig | null = null;
stubExports(setup, {
  setUpAgentCalls: async () => {
    configured++;
    if (holdSetup) await new Promise<void>((go) => (releaseSetup = go));
    if (callsReady)
      return {
        ok: true,
        setup: {
          calls: { openingDelayMs: 1_600, toolSound: null },
          apiKey: "key",
          voice: "voice",
          providerAgentId: "agent",
        },
      };
    return { ok: false, problem: "no_credential" };
  },
});
stubExports(playgroundService, {
  loadPlaygroundVoiceAgent: async () => ({
    systemPrompt: "",
    tools: callsReady
      ? [
          {
            name: "lookup",
            description: "",
            parameters: { type: "object", properties: {} },
            invoke: async () => {
              toolRuns++;
              return "ran";
            },
          },
        ]
      : [],
  }),
});
stubExports(elevenlabs, {
  elevenLabsProvider: () => ({
    name: "elevenlabs",
    open: async (config: VoiceSessionConfig) => {
      engineOpenedWith = config;
      return { sendAudio() {}, begin() {}, close() {} };
    },
  }),
});

const nativeGlobals = globalThis as unknown as {
  BunWebSocket: typeof WebSocket;
  BunResponse: typeof Response;
};
const happyResponse = globalThis.Response;

const OLD_HASH = "$2b$10$theoldpasswordhash";
const NEW_HASH = "$2b$10$thenewpasswordhash";
// An admin of the ticket's tenant: the role the playground's call requires.
const row = (
  passwordHash: string,
  role: typeof mockUser.role = "TENANT_ADMIN",
) => ({ ...mockUser, passwordHash, role });

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}
let server: ListeningApp["server"] | null = null;
let cookie = "";

const ticketFor = (userId: bigint) =>
  issuePlaygroundCallTicket({ tenantId: 1n, userId, role: "TENANT_ADMIN" }, 3n);

beforeAll(async () => {
  (globalThis as { Response: typeof Response }).Response =
    nativeGlobals.BunResponse;
  const app = new Elysia()
    .use(authPlugin)
    .post("/mint", async ({ setAuthCookie }) => ({
      token: await setAuthCookie(mockUser, OLD_HASH),
    }))
    .group("/api", (a) => a.use(voicePlaygroundController));
  server = (
    app.listen({ port: 0, hostname: "127.0.0.1" }) as unknown as ListeningApp
  ).server;
  const minted = (await (
    await app.handle(new Request("http://localhost/mint", { method: "POST" }))
  ).json()) as { token: string };
  cookie = `fazerai_auth_token=${minted.token}`;
});

afterAll(() => {
  server?.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

// A test ends when its client sees the close; the server's close hook (which untracks the socket)
// may still be pending, and the next test's sweep would count that socket.
afterEach(async () => {
  holdSetup = false;
  releaseSetup();
  await until(
    "every socket of the test to be untracked",
    () => closeUserSockets(mockUser.id, WS_CLOSE.NORMAL) === 0,
  );
});

beforeEach(() => {
  mockFindUnique.mockReset();
  mockFindUnique.mockImplementation(() => Promise.resolve(row(OLD_HASH)));
  configured = 0;
  holdSetup = false;
  releaseSetup();
  callsReady = false;
  toolRuns = 0;
  engineOpenedWith = null;
});

const jtiOf = (sessionCookie: string): string =>
  JSON.parse(
    Buffer.from(sessionCookie.split(".")[1] ?? "", "base64url").toString(
      "utf8",
    ),
  ).jti;

// Opens the playground's socket and sends `start` the moment it opens, as the browser does. Resolves
// `closed` once the socket closes.
function connect(
  ticket: string,
  withCookie: string | null = cookie,
  sendStart = true,
) {
  const WS = nativeGlobals.BunWebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new WS(
    `ws://127.0.0.1:${server?.port}/api/v1/voice/playground/${encodeURIComponent(ticket)}`,
    withCookie ? { headers: { Cookie: withCookie } } : undefined,
  );
  const closed = new Promise<{ opened: boolean; code: number }>(
    (resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`socket did not close within ${POLL_DEADLINE_MS}ms`));
      }, POLL_DEADLINE_MS);
      ws.addEventListener("open", () => {
        opened = true;
        if (sendStart)
          ws.send(JSON.stringify({ event: "start", direction: "inbound" }));
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve({ opened, code: event.code });
      });
    },
  );
  return { ws, closed };
}

// How many session reads the upgrade makes before `open` re-checks it, measured on a call that
// starts: every read up to the call's configuration but the two after the upgrade, the re-check at
// `open` and the role read again when the call starts.
async function readsBeforeOpen(): Promise<number> {
  const { ws, closed } = connect(ticketFor(mockUser.id));
  await until("the probe call to be configured", () => configured === 1);
  const reads = mockFindUnique.mock.calls.length - 2;
  ws.close();
  await closed;
  mockFindUnique.mockReset();
  configured = 0;
  return reads;
}

describe("the playground call's socket and the operator's session", () => {
  test("a start sent as the socket opens reaches the call once the session is re-checked", async () => {
    const { ws, closed } = connect(ticketFor(mockUser.id));
    await until("the call to be configured", () => configured === 1);
    ws.close();
    await closed;
  });

  // The server's re-check is held while the client sends `start`; a ping answered on the same socket
  // proves the frame was handled (the pong comes after it), and only then is the re-check released.
  async function startDuringRecheck(leave: boolean) {
    const before = await readsBeforeOpen();
    let reads = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((go) => (release = go));
    let rechecking: () => void = () => {};
    const inRecheck = new Promise<void>((go) => (rechecking = go));
    mockFindUnique.mockImplementation(async () => {
      reads += 1;
      if (reads > before) {
        rechecking();
        await held;
      }
      return row(OLD_HASH);
    });
    const { ws, closed } = connect(ticketFor(mockUser.id), cookie, false);
    await inRecheck;
    ws.send(JSON.stringify({ event: "start", direction: "inbound" }));
    await new Promise<void>((done) => {
      ws.addEventListener("pong", () => done());
      (ws as unknown as { ping(): void }).ping();
    });
    if (leave) {
      ws.close();
      await closed;
      // The client's close lands before the server's close hook runs; untracking is that hook's.
      await until(
        "the server to run the socket's close",
        () => closeUserSockets(mockUser.id, WS_CLOSE.NORMAL) === 0,
      );
    }
    release();
    return { ws, closed };
  }

  test("a start that arrives during the re-check waits for it, and reaches the call", async () => {
    const { ws, closed } = await startDuringRecheck(false);
    await until("the call to be configured", () => configured === 1);
    ws.close();
    await closed;
  });

  test("a client that leaves during the re-check gets no call, even with its start in", async () => {
    await startDuringRecheck(true);
    // A full call after it: by the time it is configured, the first socket's re-check has ended.
    mockFindUnique.mockImplementation(() => Promise.resolve(row(OLD_HASH)));
    const { ws, closed } = connect(ticketFor(mockUser.id));
    await until("the next call to be configured", () => configured >= 1);
    ws.close();
    await closed;
    expect(configured).toBe(1);
  });

  // The call is held while it is configured, so what closes the socket is the sweep alone.
  test("a logout closes the call as signed out", async () => {
    holdSetup = true;
    const { closed } = connect(ticketFor(mockUser.id));
    await until("the call to be configured", () => configured === 1);
    expect(
      closeSessionSockets(mockUser.id, jtiOf(cookie), WS_CLOSE.UNAUTHORIZED),
    ).toBe(1);
    expect((await closed).code).toBe(WS_CLOSE.UNAUTHORIZED);
  });

  test("a password change closes the call", async () => {
    holdSetup = true;
    const { closed } = connect(ticketFor(mockUser.id));
    await until("the call to be configured", () => configured === 1);
    expect(closeUserSockets(mockUser.id, WS_CLOSE.CREDENTIALS_CHANGED)).toBe(1);
    expect((await closed).code).toBe(WS_CLOSE.CREDENTIALS_CHANGED);
  });

  test("a closed call leaves nothing for the next sweep", async () => {
    const { ws, closed } = connect(ticketFor(mockUser.id));
    await until("the call to be configured", () => configured === 1);
    ws.close();
    await closed;
    await until(
      "the socket to be untracked",
      () => closeUserSockets(mockUser.id, WS_CLOSE.CREDENTIALS_CHANGED) === 0,
    );
  });

  test("a password changed between the upgrade and open refuses it before the call starts", async () => {
    // The upgrade's reads see the old password; the one `open` makes sees the new one.
    const before = await readsBeforeOpen();
    expect(before).toBeGreaterThan(0);
    let reads = 0;
    mockFindUnique.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(row(reads <= before ? OLD_HASH : NEW_HASH));
    });
    const result = await connect(ticketFor(mockUser.id)).closed;
    expect(result.opened).toBe(true);
    expect(result.code).toBe(WS_CLOSE.CREDENTIALS_CHANGED);
    expect(configured).toBe(0);
  });

  test("a logout between the upgrade and open refuses it as signed out", async () => {
    const before = await readsBeforeOpen();
    let reads = 0;
    mockFindUnique.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(
        reads <= before
          ? row(OLD_HASH)
          : { ...row(OLD_HASH), endedSessions: [{ jti: jtiOf(cookie) }] },
      );
    });
    mockEndedSessionCount.mockImplementation(() => Promise.resolve(1));
    try {
      const result = await connect(ticketFor(mockUser.id)).closed;
      expect(result.code).toBe(WS_CLOSE.UNAUTHORIZED);
      expect(configured).toBe(0);
    } finally {
      mockEndedSessionCount.mockImplementation(() => Promise.resolve(0));
    }
  });

  test("an operator who is not an admin of the ticket's tenant is refused", async () => {
    mockFindUnique.mockImplementation(() =>
      Promise.resolve(row(OLD_HASH, "AGENT")),
    );
    const result = await connect(ticketFor(mockUser.id)).closed;
    expect(result.code).toBe(WS_CLOSE.POLICY_VIOLATION);
    expect(configured).toBe(0);
  });

  test("an operator demoted after the socket opened gets no call when it starts", async () => {
    const before = await readsBeforeOpen();
    mockFindUnique.mockImplementation(() => Promise.resolve(row(OLD_HASH)));
    const { ws, closed } = connect(ticketFor(mockUser.id), cookie, false);
    await until(
      "the session to be re-checked at open",
      () => mockFindUnique.mock.calls.length > before,
    );
    await new Promise<void>((done) => {
      ws.addEventListener("pong", () => done());
      (ws as unknown as { ping(): void }).ping();
    });
    mockFindUnique.mockImplementation(() =>
      Promise.resolve(row(OLD_HASH, "AGENT")),
    );
    ws.send(JSON.stringify({ event: "start", direction: "inbound" }));
    await closed;
    expect(configured).toBe(0);
  });

  // The call runs the agent's real tools as the operator: the role is read again before each one, so
  // an operator demoted mid-call runs nothing more, and the call ends.
  test("an operator demoted during the call runs no further tool, and the call closes", async () => {
    callsReady = true;
    const { closed } = connect(ticketFor(mockUser.id));
    await until("the call's engine to open", () => engineOpenedWith !== null);
    const [tool] = (engineOpenedWith as VoiceSessionConfig | null)?.tools ?? [];
    expect(await tool?.invoke({}, "call-1")).toBe("ran");
    expect(toolRuns).toBe(1);
    mockFindUnique.mockImplementation(() =>
      Promise.resolve(row(OLD_HASH, "AGENT")),
    );
    await expect(tool?.invoke({}, "call-2")).rejects.toThrow(
      "no longer an admin",
    );
    expect(toolRuns).toBe(1);
    expect((await closed).code).toBe(WS_CLOSE.POLICY_VIOLATION);
  });

  test("a ticket another operator was handed is refused", async () => {
    const result = await connect(ticketFor(mockUser.id + 1n)).closed;
    expect(result.code).toBe(WS_CLOSE.UNAUTHORIZED);
    expect(configured).toBe(0);
  });

  test("without the session cookie it never opens", async () => {
    const result = await connect(ticketFor(mockUser.id), null).closed;
    expect(result.opened).toBe(false);
    expect(configured).toBe(0);
  });
});
