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
