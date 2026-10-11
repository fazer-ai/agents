import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Preloaded BEFORE ./setup.ts (`preload` in bunfig.toml): `@testing-library/dom` builds `screen` at
// import time and, with no global document, makes every query throw. `@testing-library/jest-dom`
// imports it through its own entrypoint, and ESM imports are hoisted above any statement, so
// `register()` cannot share a module with that import.

// Bun's native WebSocket, Response and Request, captured before happy-dom replaces them. A real
// `Bun.serve` needs the native Response, WebSocket tests need the Bun-only `{ headers }` option, and
// happy-dom's Request silently DROPS forbidden headers such as `Cookie`, so a cookie-authenticated
// route driven through `app.handle()` needs `globalThis.BunRequest` (also `BunWebSocket`, `BunResponse`).
// A client that has to reach a real socket (an MCP SDK transport) needs the native fetch, Headers and
// abort pair together: Bun's fetch refuses happy-dom's AbortSignal.
const __nativeBunGlobals = globalThis as {
  BunWebSocket?: typeof WebSocket;
  BunResponse?: typeof Response;
  BunRequest?: typeof Request;
  BunFetch?: typeof fetch;
  BunHeaders?: typeof Headers;
  BunAbortController?: typeof AbortController;
  BunAbortSignal?: typeof AbortSignal;
};
__nativeBunGlobals.BunWebSocket = WebSocket;
__nativeBunGlobals.BunResponse = Response;
__nativeBunGlobals.BunRequest = Request;
__nativeBunGlobals.BunFetch = fetch;
__nativeBunGlobals.BunHeaders = Headers;
__nativeBunGlobals.BunAbortController = AbortController;
__nativeBunGlobals.BunAbortSignal = AbortSignal;

GlobalRegistrator.register();

// A page that subscribes to the tenant's realtime events opens a socket on render. happy-dom's
// WebSocket dials through `ws`, and a refused connection emits an `error` nobody listens to, which
// surfaces as an unhandled error inside whichever test happens to be running when it lands. No DOM
// test talks to a live socket (the realtime tests use `BunWebSocket`, the hook tests a fake), so the
// global one never connects: it stays CONNECTING until closed, and emits nothing.
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  constructor(readonly url: string | URL) {
    super();
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}
globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;
