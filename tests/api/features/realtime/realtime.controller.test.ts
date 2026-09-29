import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

setupPrismaMock();

const { realtimeController } = await import(
  "@/api/features/realtime/realtime.controller"
);

// tests/setup.ts captures Bun's native WebSocket and Response classes
// before happy-dom replaces them globally. Bun.serve needs the native
// Response (happy-dom's spec one is unrecognized by Bun's TCP layer);
// WebSocket tests need the Bun-only `{ headers }` constructor option that
// the spec WebSocket rejects. We restore `Response` to the native one only
// for the duration of this file.
const nativeGlobals = globalThis as unknown as {
  BunWebSocket: typeof WebSocket;
  BunResponse: typeof Response;
};
const BunWebSocket = nativeGlobals.BunWebSocket;
const BunResponse = nativeGlobals.BunResponse;
const happyResponse = globalThis.Response;

// `Elysia.listen()` returns the Elysia instance whose runtime shape
// exposes the underlying `Bun.Server` via `.server`, but TS surfaces a wider
// type that doesn't include `server`. Cast at the boundary.
interface ListeningApp {
  server: {
    port: number;
    stop(force: boolean): void;
  };
}
let server: ListeningApp["server"] | null = null;
let baseUrl = "";

beforeAll(() => {
  (globalThis as { Response: typeof Response }).Response = BunResponse;
  const app = new Elysia().group("/api", (a) => a.use(realtimeController));
  const listening = app.listen(0) as unknown as ListeningApp;
  server = listening.server;
  if (!server?.port) throw new Error("Failed to start test server");
  baseUrl = `ws://localhost:${server.port}/api/realtime/echo`;
});

afterAll(() => {
  server?.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

function tryConnect(
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ opened: boolean; closeCode: number }> {
  return new Promise((resolve, reject) => {
    // Bun extends WebSocket constructor with a `{ headers }` option.
    // Not part of the WHATWG WebSocket type, so we cast through `any`.
    const WS = BunWebSocket as unknown as new (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const headers: Record<string, string> = { ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    const ws = new WS(
      baseUrl,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );
    // Reject if neither handshake nor close ever fires — otherwise a
    // misbehaving server (or an upgrade that hangs at the TCP level)
    // would make the test hang until Bun's default test timeout, with no
    // hint as to which assertion was waiting.
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore — connection might already be in a terminal state.
      }
      reject(new Error("WebSocket handshake/close timed out after 5s"));
    }, 5_000);
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      ws.close(1000, "test");
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ opened, closeCode: event.code });
    });
    ws.addEventListener("error", () => {
      // Resolution happens on close.
    });
  });
}

// NOTE: The handshake gate is what matters here: `requireAuth` must abort
// the upgrade for any request that arrives without a valid `auth_token`
// cookie. The full message round-trip (echo, ticks, validation close) is
// verified end-to-end during the `bun dev` smoke test described in the
// plan's verification section. The macro itself has full HTTP coverage in
// `auth.controller.test.ts` and `admin.controller.test.ts`.
describe("realtimeController WS auth gate", () => {
  test("rejects upgrade without an auth cookie", async () => {
    const result = await tryConnect();
    expect(result.opened).toBe(false);
    // NOTE: Pre-upgrade rejection (HTTP 401 from `requireAuth`) surfaces as
    // CloseEvent.code 1002 (Protocol Error) in Bun's WebSocket client,
    // because the handshake didn't receive a 101 Switching Protocols. The
    // custom 4xxx codes (4401, 4402) only apply once the upgrade has
    // succeeded. Browsers may surface this as 1006 instead.
    expect([1002, 1006]).toContain(result.closeCode);
  });

  test("rejects upgrade with an invalid cookie", async () => {
    const result = await tryConnect("auth_token=not-a-real-jwt");
    expect(result.opened).toBe(false);
    expect([1002, 1006]).toContain(result.closeCode);
  });
});
