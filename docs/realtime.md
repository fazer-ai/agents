# Realtime / WebSocket

The template ships a canonical WebSocket feature in `src/api/features/realtime/` plus a reusable `useWebSocket` hook in `src/client/hooks/`. Use them as the reference pattern when adding any WS route.

The demo exercises four reusable patterns:

1. **Topic broadcast** (`chat:global`): global chat with presence. Every message of `type: "message"` is published to the topic; every connection subscribes on `open`. Presence transitions (a user's first connect / last disconnect) also publish a `tick` event carrying the current `userCount` (distinct users with at least one open tab; opening or closing a non-last tab of the same user does NOT publish).
2. **Per-user push** (`user:<id>`): targeted delivery to every tab/device of a single user. The demo wires the `ping-self` message: the client sends it, the server calls `sendToUser(user.id, { type: "private-ping", at })`, every connection of that user receives the event, peers do not. This is the path for notifications, balance updates, "your job is done", per-user resource invalidations, etc.
3. **Auth-gated topic** (`admin:broadcasts`): client-driven subscribe with a permission check. The client sends `join-admin`; the controller validates `user.role === "ADMIN"` and either calls `ws.subscribe(TOPICS.ADMIN_BROADCASTS)` + replies `{ type: "joined", topic }`, or replies `{ type: "join-denied", topic, reason }`. Publishing (`admin-broadcast`) re-runs the check: joining is not the same as having permission right now. This is the canonical pattern for rooms (`chat:<roomId>`), per-doc collaboration (`doc:<docId>`), or any membership-gated channel.
4. **HTTP → WS bridge** (`POST /api/realtime/notify-me`): REST route that calls `sendToUser(user.id, ...)` server-side. Demonstrates that the trigger for a WS event does not need a WS connection of its own: background workers ("export finished"), webhooks ("Stripe payment landed"), cron jobs ("daily digest is ready"), or admin moderation actions all use this same `sendToUser` / `broadcastChatMessage` / `broadcastAdminMessage` path. The publisher injected at boot (`server.publish`) is process-global, so any code path can deliver to any topic.

Fan-out goes through **Bun's native pub/sub**: `ws.subscribe(topic)` registers the socket as a listener and `server.publish(topic, data)` (wrapped by the service's `publish()` after `src/index.ts` calls `setPublisher(...)`) delivers to every subscriber without us iterating manually. Closing the socket auto-unsubscribes; there is no explicit `ws.unsubscribe()` call in the close handler.

## Per-tenant events channel (`/api/realtime/events`)

The product's operational realtime (conversation metadata changes) rides a dedicated route, separate from the chat/presence demo (`/echo`). It is a **server-push only** socket (no `message` handler): the subscription topic is decided entirely server-side in `open`.

- **Topic** `TOPICS.tenant(tenantId)` → `tenant:<id>`. Payloads are **METADATA ONLY** — never message body or contact name, so a subscriber sees no more than the read API exposes. Two event kinds ride this one topic:
  - `ConversationEvent` (`type:"conversation"`) — a **persisted** mirror change: status, assignee, `lastEventAt`, our internal conversation row id.
  - `AgentActivityEvent` (`type:"agent-activity"`) — a **transient** "the agent is working" signal (the operator's typing indicator), NOT stored. `phase` is the envelope (`started` → `step`* → `finished`); `stage` is the coarse step (`thinking` = the model generating; `tool` = a tool executing, with its name in `tool`). Metadata only — an enum plus a tool name (operator config they already see), never content.
  - `AgentConfigEvent` (`type:"agent-config"`) — an agent's config changed (saved via the editor, the REST API, or the MCP server). Metadata only: agent row id + the new `updatedAt`. The open Agent editor compares `updatedAt` against the version it loaded and shows a "changed elsewhere" banner; the save itself carries an `updatedAt` precondition (409 `errors.agentModifiedElsewhere` on stale) as the authoritative anti-overwrite guard, so a missed WS event never lets a silent overwrite through.
- **Cross-tenant gate** (`resolveEventsTenant` in `realtime.service.ts`) is the WS analogue of the REST `X-Tenant-Id` rule, reusing the same `resolveRequestTenantContext` + `authorize` so the two transports cannot diverge:
  - a tenant-bound user (`TENANT_ADMIN`/`AGENT`) is **locked to their own tenant** — any `?tenantId=` selector they pass is ignored and flagged as an anomaly (no cross-tenant leak);
  - a `SUPER_ADMIN` **follows the active tenant** passed as `?tenantId=` (the same value the header switcher persists), authorized for any target;
  - a `SUPER_ADMIN` with no/invalid selector resolves to `no-tenant` (nothing to stream yet) — the socket stays open and subscribes to nothing.
- **Tenant switch = full reload.** The header `TenantSwitcher` reloads the page on change (the TOCTOU-safe switch), so the client hook remounts and reconnects with the new selector; there is no mid-connection re-subscribe.
- **Emit points.** `broadcastConversationEvent(tenantId, …)` is the HTTP→WS bridge, called from the Chatwoot webhook processor (canonical, only on an *applied* non-stale mirror change) and from the REST conversation ops (`handoff`/`return`/`setStatus`, optimistic — the webhook reconciles canonically). A reply is not emitted (no mirror metadata change). `broadcastAgentActivity(tenantId, …)` is emitted by the **agent runtime** (`src/graph/`): the `AgentStatusReporter` LangChain callback (`src/graph/status.ts`) fires `step` events as the graph progresses (model start → `thinking`; tool start → `tool`+name), and `runAgentTurn` wraps the invoke with `started()`/`finished()` so the indicator appears before the first token and a `finished` is **guaranteed in a finally** (every exit — posted, empty, taken-over, thrown — clears it). The reporter is a no-op when the conversation has no mirror row id. `broadcastAgentConfigEvent(tenantId, …)` is emitted by `updateAgent` / `replaceAgentToolSelections` (`src/modules/agents/service.ts`), so REST and MCP agent writes both fan out to any open editor.
- **Connection cap.** A dedicated per-user cap (`tryAttachEvents`/`detachEvents`), separate from the presence cap so the two channels do not inflate each other.
- **Frontend.** `useTenantEvents` (`src/client/hooks/useTenantEvents.ts`) wraps `useWebSocket`, follows `user.tenantId ?? getActiveTenantId()`, and stays disabled until a tenant is known. It exposes `onConversation` and `onAgentActivity`. `ConversationsPage` is the reference consumer (merge-in-place on known rows, refetch on an unknown id, plus refetch-on-mount as the disconnect safety net; a per-row "working" dot driven by `onAgentActivity` with a client-side TTL). `ConversationDetailPage` renders a chat-style typing bubble from `onAgentActivity`. The **TTL is load-bearing**: a publish during a socket gap is lost (Bun no-ops an absent subscriber), so a stuck indicator auto-clears after ~30s even if its `finished` never arrives.

## Backend pattern

```ts
new Elysia({ prefix: "/realtime" })
  .use(authPlugin)
  .resolve(async ({ getAuthUser }) => ({ user: await getAuthUser() }))
  .ws("/echo", {
    requireAuth: true,                 // macro from authPlugin gates the upgrade
    idleTimeout: 60,                   // < Bun default of 120s; faster dead-conn detection
    body: ClientMessage,               // TypeBox `t.Object`; validation failure closes 1008
    open(ws) { /* ws.data.user is populated by .resolve(); key state by String(ws.id) */ },
    message(ws, msg) { return { ... }; },
    close(ws, code) { /* cleanup keyed by String(ws.id), NOT the ws wrapper */ },
    error({ error }) { /* logger.warn */ },
  });
```

- **Auth.** `requireAuth: true` reuses the macro from `authPlugin`. `beforeHandle` runs before the upgrade; without a valid `auth_token` cookie the upgrade is aborted with a 401. Pre-upgrade close codes are not customizable, so what the client surfaces depends on the runtime: browsers report `CloseEvent.code: 1006` (abnormal closure), while Bun's WebSocket client has been observed surfacing `1002` (protocol error) for the same path. Any tests or diagnostics that key off the code on rejected upgrades should accept either value.
- **Per-connection user.** `.resolve()` runs after the auth gate and contributes `user` to context. Inside the WS handlers it surfaces as `ws.data.user`. Defensive null check before using it.
- **Close codes.** `WS_CLOSE` constants live in `src/api/lib/realtime.ts`. Use **`WS_CLOSE.NORMAL` (1000)** for clean shutdown, **`WS_CLOSE.UNAUTHORIZED` (4401)** when a previously-valid session is revoked mid-connection, **`WS_CLOSE.SESSION_EXPIRED` (4402)** for explicit expiry, and **`WS_CLOSE.CREDENTIALS_CHANGED` (4409)** when the account's password changed. 4409 is deliberately not an auth-lost code: the client reconnects, which works for the tab holding the re-issued cookie and fails the upgrade for a revoked session. The 4xxx codes only apply after the upgrade has succeeded.
- **Revocation reaches open sockets.** The service tracks every socket of both channels by user (`trackSocket`/`untrackSocket`, Bun's raw socket keyed by `ws.id`), and a password change closes them with `closeUserSockets`. `open` registers a socket for that sweep FIRST and only then re-reads its session (`getAuthUser`, which checks the password fingerprint): a change landing between the upgrade and `open` is caught by one or the other, never neither. On `/echo`, a message that arrives while that re-check runs awaits it instead of being dropped. Process-local, like the rest of this state.
- **No app-level heartbeats.** Bun sends WS ping frames automatically (`sendPings: true`) and the configured `idleTimeout` catches dead connections. The `ping`/`pong` messages in the demo schema are didactic only and can be deleted in projects that don't need them.
- **No `response` TypeBox schema.** Elysia's WS validator (last verified on **1.4.28, 2026-05-11**) rejects every value returned from a `.ws()` `message` handler when a `response` schema is set, with empty `errors: []` arrays. Verified against literal-only, union-of-literal, union-of-object, optional and required forms; all fail. The same failure mode shipped the server closing the socket with 1008 on every successful round-trip, which the client read as a reconnectable disconnect. **`body` validation works correctly** and is kept for input safety. Client-side type safety for incoming server messages comes from the `useWebSocket<TIn, TOut>` generics. No upstream issue tracks this specifically as of the verification date; **re-verify on every Elysia minor version bump** with a `bun dev` round-trip before reintroducing `response`. Related upstream context: 1.4.17 changelog and issue [#1563](https://github.com/elysiajs/elysia/issues/1563) fixed a separate WS validation gap (Zod/standard schema), which is what makes a fresh smoke test mandatory.
- **Key per-socket state by `String(ws.id)`, not the `ws` wrapper.** Elysia 1.4.x wraps the underlying Bun socket in a fresh JS proxy for every lifecycle hook (open/message/close), so `wsFromOpen === wsFromClose` is `false` even for the same connection (upstream issue [elysiajs/elysia#1716](https://github.com/elysiajs/elysia/issues/1716), open). Using `ws` as a `WeakMap` / `WeakSet` key silently breaks every "remember this socket" pattern: close handlers cannot find what open stored, slots are never released, intervals never cleared, presence subscribers accumulate as zombies. `ws.id` (string from the Bun adapter) IS stable across hooks for one connection: the realtime feature uses `String(ws.id)` as the key into `Map`/`Set` everywhere. `ws.data` and `ws.raw` are also stable, but `ws.id` is the canonical handle.
- **Per-user connection cap.** `tryAttachUser()` enforces `realtimeConfig.maxConnectionsPerUser` (default 5). An authenticated user who tries to open the 6th simultaneous socket is closed with `WS_CLOSE.POLICY_VIOLATION` (1008). Combined with the global HTTP rate limiter (which throttles new upgrades per IP), this caps both the burst rate and the steady-state footprint per user.
- **State per process.** `realtime.service.ts` keeps presence in a process-local `Map`, and Bun's pub/sub is also single-process. Single-instance servers are fine; horizontal deploys need (a) a distributed presence store (e.g. Redis with TTL keys) to share the user count, and (b) a Redis pub/sub bridge that mirrors topic publishes across nodes so a publish on one Bun process reaches subscribers on others. The connection cap then needs to be coordinated across nodes too.

## Adding a new topic / pattern

- Add the topic to `TOPICS` in `realtime.service.ts` (or compute it inline for parameterized topics like `chat:<roomId>`). Constants beat free-form strings: typos can't silently route messages into the void.
- Decide where the subscribe lives:
  - **Server-decided topics** (the default for `chat:global` and `user:<id>` in this template): call `ws.subscribe(topic)` in the `open` handler based on `ws.data.user`. The client never asks. This is the safest pattern: the controller is the single source of truth for "who can listen to what".
  - **Client-driven topics with auth gate** (the `admin:broadcasts` demo): expose a `{ type: "join-..." }` message; in the handler, validate that the authenticated user is allowed (role check, membership lookup, ACL query) and only then call `ws.subscribe(...)`. Reply via `ws.send(...)` (NOT a topic publish, because only the asking client cares about the ack).
  - **Client-driven topics without auth gate**: don't. Anyone subscribed receives every publish on the topic. Without a server-side check this leaks data from one user/group to another.
- **Re-check permissions on publish, not just on join.** A client that joined a topic before being demoted should not be able to keep publishing. The template recheck looks cosmetic (the user object is captured at upgrade and never refreshed) but the pattern is load-bearing for any system with auth refresh or revocable permissions.
- For server-side publishes from outside a WS handler (cron job, REST endpoint, background queue, webhook), call the service's exported helpers (`broadcastChatMessage`, `sendToUser`, `broadcastAdminMessage`, etc.); they go through the injected publisher and hit `server.publish(topic, data)`. The `POST /api/realtime/notify-me` route is the reference implementation: it lives in the same controller, takes the authenticated user from `getAuthUser()`, and calls `sendToUser` exactly the way a worker would. **Gate the route at the route level** (who can send what to whom): a self-notify endpoint only needs `requireAuth`, but a "send to any user" endpoint needs `requireAdmin` or an ACL check, because `sendToUser` itself does not validate the caller's right to target the recipient.
- `server.publish(topic, data)` includes the sender; `ws.publish(topic, data)` excludes them. The chat uses `server.publish` so the sender sees their own message in the timeline at the same instant peers do.
- The wire format for published events is JSON. The client-side `useWebSocket<TIn, TOut>` generics carry the type union; topic information is NOT round-tripped on the wire, so use distinct `type` discriminators if multiple topics carry overlapping shapes (e.g. `chat-message` vs `admin-broadcast`, not `message` for both).
- **No explicit `ws.unsubscribe(...)` in the close handler.** Bun cleans up topic subscriptions when the socket closes, so calling it from `close` is redundant and racy. Only call `unsubscribe` if you intentionally want to drop a subscription mid-connection (e.g. user leaves a room without disconnecting).

## Frontend hook

`useWebSocket(subscribe, options?)` in `src/client/hooks/useWebSocket.ts` wraps an Eden Treaty `.subscribe()` factory with React lifecycle, reconnection, and status reporting.

```tsx
const subscribe = useCallback(() => api.api.realtime.echo.subscribe(), []);
const { status, send, lastMessage, reconnect } = useWebSocket<ClientMessage, ServerMessage>(
  subscribe,
  { onMessage: (msg) => { /* ... */ } },
);
```

Contract:

- **Factory must be stable across renders.** Wrap it in `useCallback([])` or define outside the component. The hook does not re-subscribe when the factory identity changes; call `reconnect()` to apply new args.
- **Status states:** `idle` (`enabled: false`), `connecting`, `connected`, `reconnecting`, `disconnected`, `error`.
- **Auto-reconnect** with exponential backoff (1s → 30s cap) and 50–100% jitter. Capped by `maxAttempts` (default 10; pass 0 for unbounded).
- **Terminal close codes** (no reconnect): `1008` (server policy violation, e.g. cap hit or invalid message) and `4401`/`4402` (auth lost). The hook parks at `error` (1008) or `disconnected` (4401/4402) instead of cycling through the retry budget.
- **Handshake-failure cap.** Three consecutive closes before a single successful `open` park the hook at `error`. Failing to even upgrade is almost always permanent within a tab's lifetime (auth lost without 4401, origin blocked, server unreachable), so short-circuiting beats burning ~10 minutes of backoff retries on the same rejection.
- **`pauseWhenHidden`** (default `true`) cancels pending reconnect timers when the tab is hidden; one immediate attempt on becoming visible again. Saves battery and server load on background tabs.
- **Auth integration.** Close codes `4401`/`4402` stop reconnection and dispatch `window.dispatchEvent(new CustomEvent("auth:unauthorized"))`, piggybacking the same channel the HTTP 401 handler in `src/client/lib/api.ts` already uses. The hook also listens for that event and closes the socket cleanly on logout to suppress reconnect storms.
- **Cleanup.** `useEffect` cleanup calls `socket.ws.close(1000, "unmount")`. The 1000 code tells the close handler this was clean: no retry, no `auth:unauthorized` dispatch.

## CSRF / CSP

The WS upgrade is double-gated against CSRF: `SameSite=Lax` on the auth cookie (browser-enforced) plus a server-side `Origin` header check in `realtime.controller.ts`'s `beforeHandle`, which compares against `CORS_ORIGIN` via `isOriginAllowed()` from `src/api/lib/origin.ts`. The server-side check is the load-bearing half: some browsers historically did not honor `SameSite` on WebSocket upgrades.

Same-origin WS (`ws://` in dev, `wss://` in prod) is covered by `'self'` in `connect-src` per CSP3, so no CSP directive changes were needed.

## Removing the feature

If your project does not need realtime:

- Delete `src/api/features/realtime/`, `src/api/lib/realtime.ts`, `src/client/hooks/useWebSocket.ts`, `src/client/components/RealtimeDemoCard.tsx`.
- Remove the `.use(realtimeController)` line from `src/api/index.ts`.
- Remove the `setPublisher` import and the `app.server` wire-up block at the bottom of `src/index.ts`.
- Remove the `<RealtimeDemoCard />` render and its import from `src/client/pages/HomePage.tsx`.
- Drop the `home.realtime.*` keys in `src/client/locales/{en,pt-BR}.json` and re-run `bun i18n:extract`.
- Delete the test files under `tests/api/features/realtime/` and `tests/client/hooks/`.
- Optional: drop the `BunWebSocket` / `BunResponse` lines from `tests/setup.ts` (only relevant for realtime tests).
