// A password change revokes every session signed under the old password, and a socket authenticated
// once at upgrade would otherwise outlive that. These drive real sockets against the controller: an
// open socket closed by the change, and one whose session changed between the upgrade and `open`.

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
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const { realtimeController } = await import(
  "@/api/features/realtime/realtime.controller"
);
const { closeUserSockets } = await import(
  "@/api/features/realtime/realtime.service"
);
const { authPlugin } = await import("@/api/lib/auth");
const { WS_CLOSE } = await import("@/api/lib/realtime");

const nativeGlobals = globalThis as unknown as {
  BunWebSocket: typeof WebSocket;
  BunResponse: typeof Response;
};
const happyResponse = globalThis.Response;

const OLD_HASH = "$2b$10$theoldpasswordhash";
const NEW_HASH = "$2b$10$thenewpasswordhash";
// The mock's findUnique already shapes the entity into the person row getAuthUser reads.
const row = (passwordHash: string) => ({ ...mockUser, passwordHash });

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}
let server: ListeningApp["server"] | null = null;
let base = "";
let cookie = "";

beforeAll(async () => {
  (globalThis as { Response: typeof Response }).Response =
    nativeGlobals.BunResponse;
  const app = new Elysia()
    .use(authPlugin)
    .post("/mint", async ({ setAuthCookie }) => ({
      token: await setAuthCookie(mockUser, OLD_HASH),
    }))
    .group("/api", (a) => a.use(realtimeController));
  const listening = app.listen(0) as unknown as ListeningApp;
  server = listening.server;
  base = `localhost:${server.port}`;
  const { token } = (await (
    await app.handle(new Request("http://localhost/mint", { method: "POST" }))
  ).json()) as { token: string };
  cookie = `fazerai_auth_token=${token}`;
});

afterAll(() => {
  server?.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

beforeEach(() => {
  mockFindUnique.mockReset();
});

// Opens /events, and resolves once the socket closes, with the messages it received before that.
function connect(onFirstMessage?: () => void) {
  const WS = nativeGlobals.BunWebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new WS(`ws://${base}/api/realtime/events`, {
    headers: { Cookie: cookie },
  });
  const messages: unknown[] = [];
  const closed = new Promise<{ opened: boolean; code: number }>(
    (resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("socket did not close within 5s"));
      }, 5_000);
      ws.addEventListener("open", () => {
        opened = true;
      });
      ws.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
        if (messages.length === 1) onFirstMessage?.();
      });
      ws.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve({ opened, code: event.code });
      });
    },
  );
  return { ws, messages, closed };
}

// How many session reads the upgrade makes before `open` runs, measured on a socket that opens.
async function readsBeforeOpen(): Promise<number> {
  mockFindUnique.mockImplementation(() => Promise.resolve(row(OLD_HASH)));
  let reads = 0;
  const { ws, closed } = connect(() => {
    reads = mockFindUnique.mock.calls.length - 1;
    ws.close(1000, "probe");
  });
  await closed;
  mockFindUnique.mockReset();
  return reads;
}

describe("a password change and the realtime sockets", () => {
  test("a change between the upgrade and open refuses the socket before it subscribes", async () => {
    const before = await readsBeforeOpen();
    expect(before).toBeGreaterThan(0);
    let reads = 0;
    mockFindUnique.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(row(reads <= before ? OLD_HASH : NEW_HASH));
    });
    const { messages, closed } = connect();
    const result = await closed;
    expect(result.opened).toBe(true);
    expect(messages).toEqual([]);
    expect(result.code).toBe(WS_CLOSE.CREDENTIALS_CHANGED);
  });

  test("a session revoked before the upgrade never opens", async () => {
    mockFindUnique.mockImplementation(() => Promise.resolve(row(NEW_HASH)));
    const result = await connect().closed;
    expect(result.opened).toBe(false);
  });

  test("a client leaving during the re-check leaves no connection slot behind", async () => {
    const before = await readsBeforeOpen();
    const { realtimeConfig } = await import("@/api/lib/realtime");
    for (let i = 0; i <= realtimeConfig.maxConnectionsPerUser; i++) {
      let reads = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let socket: WebSocket | null = null;
      let rechecking: () => void = () => {};
      const inRecheck = new Promise<void>((resolve) => {
        rechecking = resolve;
      });
      mockFindUnique.mockImplementation(async () => {
        reads += 1;
        if (reads > before) {
          rechecking();
          await held;
        }
        return row(OLD_HASH);
      });
      const { ws, closed } = connect();
      socket = ws;
      // The client leaves while the server is still inside the re-check.
      await inRecheck;
      socket.close(1000, "gone");
      await closed;
      release();
      await Bun.sleep(20);
    }
    mockFindUnique.mockImplementation(() => Promise.resolve(row(OLD_HASH)));
    const { ws, messages, closed } = connect(() => ws.close(1000, "done"));
    await closed;
    expect(messages).toEqual([{ type: "subscribed", tenantId: "1" }]);
  });

  // Last, so the count of exactly one also proves the sockets of the tests above were untracked.
  test("an open socket is closed with CREDENTIALS_CHANGED", async () => {
    mockFindUnique.mockImplementation(() => Promise.resolve(row(OLD_HASH)));
    let swept = -1;
    const { messages, closed } = connect(() => {
      swept = closeUserSockets(mockUser.id, WS_CLOSE.CREDENTIALS_CHANGED);
    });
    const result = await closed;
    expect(swept).toBe(1);
    expect(messages).toEqual([{ type: "subscribed", tenantId: "1" }]);
    expect(result.code).toBe(WS_CLOSE.CREDENTIALS_CHANGED);
  });
});
