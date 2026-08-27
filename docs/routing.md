# Routing — BrowserRouter + the `serve.routes` carve-out

Why deep-link refreshes work and why `/api/*` is not served as HTML. Four pieces of plumbing are load-bearing, and three of them exist because of a Bun runtime behaviour that has no opt-out. Includes the smoke test to run on every Elysia upgrade.

The template uses `BrowserRouter` (in `src/client/App.tsx`) so URLs are canonical (`/settings/profile`, not `/#/settings/profile`). To make refreshes on deep routes work, `src/app.ts` registers a catch-all `.get("/*", indexHandler)` that serves `index.html` for any non-API, non-asset request.

Four pieces of plumbing are load-bearing:

1. **`serve.routes` carve-out** on the root Elysia constructor:
   ```ts
   new Elysia({ serve: { routes: { "/api": false, "/api/*": false } } })
   ```
   Bun's native routes table is consulted before Elysia's `fetch` handler. When `.get("/*", htmlBundle)` is registered as a static handler, Bun stores the `HTMLBundle` directly in that table, and any `/api/*` request would be served as HTML before Elysia could route it. The `false` entries disable Bun's interception so `/api` paths fall through to Elysia. The bare `/api` carve-out covers requests without a trailing slash (Bun treats `/api` and `/api/` as separate keys). Asset paths under `/assets/*` and hashed bundle files at the root do **not** need carve-outs because `staticPlugin` registers them as more-specific entries in the same table and Bun picks the more specific match.

2. **GET 404 guards for `/api` and `/api/*`** registered between the API group and the catch-all:
   ```ts
   .get("/api", ({ set }) => { set.status = 404; return { error: "Not Found" } })
   .get("/api/*", ({ set }) => { set.status = 404; return { error: "Not Found" } })
   .get("/*", indexHandler)
   ```
   Once Bun delegates to Elysia, the catch-all `/*` *would* swallow GETs for missing API paths and serve `index.html` (prod) or `{}` (dev — because the HTMLBundle, returned from a dynamic Elysia handler, is JSON-serialized). The explicit GET guards make missing API paths return JSON 404 instead. `.all()` doesn't work here — Elysia's trie gives `.get()` wildcards higher priority than `.all()` wildcards. Non-GET methods on missing API paths are caught by the `onError` NOT_FOUND handler (the GET-only catch-all never matches them). WebSocket upgrades for `/api/realtime/*` are also unaffected because `.ws()` registrations outrank `.get` wildcards.

3. **Dev vs prod `indexHandler`**. In dev the catch-all hands Elysia the `HTMLBundle` from `public/index.html` so Bun's bundler resolves the `<script>` reference and HMR keeps working on deep routes; in prod it serves the pre-built `dist/index.html` via `Bun.file`. The conditional `await import("@/public/index.html")` only runs in dev.

4. **`publicPath: "/"` in `build.ts`**. Without it, Bun emits relative asset paths (`./index-abc.js`) in `dist/index.html`. A browser at `/settings/profile` would resolve those against the current pathname (`/settings/index-abc.js`), 404 → SPA catch-all returns `index.html` → `<script type="module">` chokes on HTML. Absolute paths from the document root sidestep this. When `BUN_PUBLIC_CDN_URL` is set the CDN URL takes over (same effect, different origin). The dev server already emits absolute `/_bun/...` paths automatically, so this only matters for the prod build.

The root cause lives in the Bun runtime (the static `routes` table has unconditional priority over `fetch` and there is no opt-out for HTML bundles): see [oven-sh/bun#17595](https://github.com/oven-sh/bun/issues/17595), [#17363](https://github.com/oven-sh/bun/issues/17363), [#23999](https://github.com/oven-sh/bun/issues/23999). The Elysia-side discussion and the carve-out pattern are tracked in [elysiajs/elysia#1515](https://github.com/elysiajs/elysia/issues/1515) (root-cause analysis by @a-rebets, 2025-11-11) and [#1347](https://github.com/elysiajs/elysia/issues/1347). Confirmed working on Elysia 1.4.28.

**On every Elysia upgrade**, re-run the smoke test before bumping in `main`:

1. In a temp dir, install the upgraded Elysia version
2. Register a static `.get("/*", htmlBundle)` plus a `.get("/api/health", () => ({ ok: true }))` (no carve-out)
3. Fetch `/api/health`: if it returns HTML, the bug is still present and the carve-out is still needed; if it returns JSON, the bug is fixed

If the bug is fixed, simplify `src/app.ts` by removing the `serve.routes` carve-out, drop this section, and add a regression test. Issue/PR status is not a reliable gate, only the runtime check is.
