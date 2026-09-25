import { Elysia, t } from "elysia";
import {
  broadcastAdminMessage,
  broadcastChatMessage,
  detachEvents,
  detachUser,
  presenceSnapshot,
  resolveEventsTenant,
  sendToUser,
  TOPICS,
  tryAttachEvents,
  tryAttachUser,
} from "@/api/features/realtime/realtime.service";
import { authPlugin } from "@/api/lib/auth";
import logger from "@/api/lib/logger";
import { doc, errors } from "@/api/lib/openapi";
import { originPlugin } from "@/api/lib/origin";
import { realtimeConfig, WS_CLOSE } from "@/api/lib/realtime";
import { roleAtLeast } from "@/lib/tenancy";

// NOTE: Set of `ws.id` strings (NOT `ws` wrappers) that successfully
// reserved a slot via `tryAttachUser`. See `realtime.service.ts` for why
// the wrapper itself cannot be used as a key (Elysia 1.4.x rewraps `ws`
// per lifecycle hook — upstream issue elysiajs/elysia#1716).
const attached = new Set<string>();

// NOTE: `ws.id` strings that reserved a slot on the /events channel (its own
// cap, separate from `attached` above). Same rewrap caveat: key by id, not the
// wrapper.
const eventsAttached = new Set<string>();

const ClientMessage = t.Object({
  type: t.Union([
    t.Literal("message"),
    t.Literal("ping"),
    t.Literal("ping-self"),
    t.Literal("join-admin"),
    t.Literal("admin-broadcast"),
  ]),
  payload: t.Optional(t.String({ maxLength: 1024 })),
});

// NOTE: We deliberately do NOT pass a `response` schema. Elysia 1.4.x
// rejects every return value from `.ws()`'s `message` handler when a
// `response` schema is set, regardless of the schema's shape (verified
// with literal-only, union-of-literal, union-of-object, optional and
// required forms — all fail with `errors: []` and `expected` showing
// only the discriminator). Body validation works correctly, so we keep
// that for input safety and surface clear errors on malformed messages.
// Client-side type safety for incoming server messages comes from the
// `useWebSocket<TIn, TOut>` generics. If upstream fixes response
// validation, the schema can be reintroduced; smoke-test end-to-end
// before trusting it (`bun run dev` + manual round-trip).

// NOTE: WS upgrades are double-gated for CSRF: the auth cookie is
// `SameSite=Lax` (browser-enforced), and the upgrade itself is also
// rejected here when the `Origin` header doesn't match `CORS_ORIGIN`
// in production. Some browsers historically did not honor SameSite for
// WebSocket upgrades, so this server-side check is the load-bearing
// half of the pair.
export const realtimeController = new Elysia({
  prefix: "/realtime",
  tags: ["System"],
})
  .use(authPlugin)
  .use(originPlugin)
  .resolve(async ({ getAuthUser }) => ({ user: await getAuthUser() }))
  // NOTE: HTTP → WS bridge demo. Calling `sendToUser` from outside a WS
  // handler is the same code path as calling it from one: the publisher
  // hits `server.publish(topic, data)` either way. This is the pattern
  // for background jobs ("your export finished"), webhooks ("Stripe
  // payment landed"), cron tasks ("daily digest is ready"), or admin
  // moderation actions ("your post was removed"): the trigger has no WS
  // connection of its own, it just calls the service helper and the
  // user's open tabs receive the event. The endpoint here pings the
  // caller; real apps would target arbitrary users by id (and would
  // gate WHO can target WHOM at the route level).
  .post(
    "/notify-me",
    ({ user }) => {
      if (!user) return { ok: false as const };
      const at = Date.now();
      sendToUser(user.id, { type: "private-ping", at });
      return { ok: true as const, at };
    },
    {
      requireAuth: true,
      detail: doc(
        "Notify me",
        "Push a ping to the caller's open WebSocket connections.",
      ),
      response: errors(401),
    },
  )
  .ws("/echo", {
    detail: doc(
      "Realtime echo socket",
      "WebSocket for chat, presence, and admin broadcasts.",
    ),
    requireAuth: true,
    requireAllowedOrigin: true,
    idleTimeout: realtimeConfig.idleTimeoutSec,
    maxPayloadLength: realtimeConfig.maxPayloadBytes,
    body: ClientMessage,
    open(ws) {
      const { user } = ws.data;
      if (!user) {
        ws.close(WS_CLOSE.UNAUTHORIZED, "unauthorized");
        return;
      }
      if (!tryAttachUser(user.id)) {
        ws.close(WS_CLOSE.POLICY_VIOLATION, "too many connections");
        return;
      }
      const id = String(ws.id);
      attached.add(id);
      // NOTE: Bun's native pub/sub. `ws.subscribe(topic)` registers this
      // socket as a listener; `server.publish(topic, data)` (called by
      // the service) fans out without us iterating subscribers manually.
      // CHAT_GLOBAL carries chat messages and presence ticks; the
      // per-user topic delivers events targeted at this user across all
      // their tabs/devices.
      ws.subscribe(TOPICS.CHAT_GLOBAL);
      ws.subscribe(TOPICS.user(user.id));
      // NOTE: Send the current snapshot synchronously so the new client
      // renders the right count immediately, without waiting up to a
      // full tick interval for the next periodic tick (the service
      // owns a single process-wide ticker that publishes to
      // CHAT_GLOBAL, so this socket will start receiving them via the
      // subscription it just registered).
      ws.send(presenceSnapshot());
    },
    message(ws, msg) {
      if (msg.type === "ping") {
        return { type: "pong" as const };
      }
      const { user } = ws.data;
      if (!user) return;
      if (msg.type === "ping-self") {
        // Demo of targeted push: deliver to every open connection of
        // THIS user (other tabs/devices), not to peers. The publish
        // path is the same as any cross-cutting server-pushed event
        // (notifications, balance updates, "your job is done", etc).
        sendToUser(user.id, { type: "private-ping", at: Date.now() });
        return;
      }
      if (msg.type === "join-admin") {
        // Demo of auth-gated subscribe: the client asks to subscribe;
        // the server is the only authority that decides. For role-gated
        // topics check the role; for membership-gated topics (rooms,
        // doc:<id>, org:<id>) query the relation. The reply is a
        // per-socket ws.send (NOT a topic publish): only the asking
        // client cares about the ack.
        if (!roleAtLeast(user.role, "TENANT_ADMIN")) {
          ws.send({
            type: "join-denied" as const,
            topic: TOPICS.ADMIN_BROADCASTS,
            reason: "forbidden",
          });
          return;
        }
        ws.subscribe(TOPICS.ADMIN_BROADCASTS);
        ws.send({
          type: "joined" as const,
          topic: TOPICS.ADMIN_BROADCASTS,
        });
        return;
      }
      if (msg.type === "admin-broadcast") {
        // Recheck role on every publish: "the user joined once" is not
        // the same as "the user has permission right now". A real app
        // with auth-token refresh or mid-session role changes would
        // diverge between subscribe time and publish time. For the
        // template the role is captured at upgrade and never updates,
        // so the recheck is effectively a no-op, but the pattern is
        // the load-bearing teaching, not the runtime cost.
        if (!roleAtLeast(user.role, "TENANT_ADMIN")) {
          ws.send({
            type: "publish-denied" as const,
            topic: TOPICS.ADMIN_BROADCASTS,
            reason: "forbidden",
          });
          return;
        }
        const payload = (msg.payload ?? "").trim();
        if (!payload) return;
        broadcastAdminMessage({
          type: "admin-broadcast",
          at: Date.now(),
          from: {
            userId: user.id.toString(),
            displayName: user.name ?? user.email,
          },
          payload,
        });
        return;
      }
      if (msg.type === "message") {
        const payload = (msg.payload ?? "").trim();
        if (!payload) return;
        // Broadcast to every subscriber of CHAT_GLOBAL (including the
        // sender) so the sender sees their own message land in the same
        // timeline as the peers'. Using server.publish (vs ws.publish)
        // is what includes the sender; ws.publish would exclude them.
        broadcastChatMessage({
          type: "message",
          at: Date.now(),
          from: {
            userId: user.id.toString(),
            displayName: user.name ?? user.email,
          },
          payload,
        });
      }
    },
    close(ws, code) {
      const id = String(ws.id);
      // NOTE: No explicit `ws.unsubscribe(...)` here. Bun automatically
      // cleans up topic subscriptions when the socket closes, so calling
      // unsubscribe is redundant and risks racing the close handler.
      // The periodic presence ticker is shared at the service level and
      // stops itself when the last user detaches, so there is no
      // per-socket timer to cancel either.
      const { user } = ws.data;
      if (user && attached.has(id)) {
        detachUser(user.id);
        attached.delete(id);
      }
      logger.debug(
        { code, userId: user?.id?.toString() },
        "realtime ws closed",
      );
    },
    error({ error }) {
      logger.warn({ error }, "realtime ws error");
    },
  })
  // NOTE: Per-tenant operational events channel (conversation metadata). The
  // subscription topic is decided ENTIRELY server-side in `open` from the
  // authenticated user + the `?tenantId=` selector, never from a client
  // message — `resolveEventsTenant` is the cross-tenant gate (super follows the
  // active tenant; everyone else is locked to their own, selector ignored). No
  // `message` handler: this socket is server-push only. On a SUPER_ADMIN tenant
  // switch the header does a full reload, so the hook remounts and reconnects
  // with the new selector — no mid-connection re-subscribe needed.
  .ws("/events", {
    detail: doc(
      "Realtime events socket",
      "Server-push WebSocket for per-tenant operational events.",
    ),
    requireAuth: true,
    requireAllowedOrigin: true,
    idleTimeout: realtimeConfig.idleTimeoutSec,
    query: t.Object({
      tenantId: t.Optional(
        t.String({
          description:
            "Tenant id (BigInt string) selector: any tenant for a SUPER_ADMIN, one of the person's memberships otherwise (refused outside them); ignored for an API key.",
        }),
      ),
    }),
    open(ws) {
      const { user } = ws.data;
      if (!user) {
        ws.close(WS_CLOSE.UNAUTHORIZED, "unauthorized");
        return;
      }
      const resolution = resolveEventsTenant(user, ws.data.query.tenantId);
      if (resolution.anomaly) {
        logger.warn(
          { userId: String(user.id) },
          "realtime/events: ignoring tenant selector from a non-super principal",
        );
      }
      if (resolution.status === "denied") {
        ws.close(WS_CLOSE.POLICY_VIOLATION, "forbidden tenant");
        return;
      }
      if (resolution.status === "no-tenant") {
        // SUPER_ADMIN with no active tenant selected yet: stay connected but
        // subscribe to nothing. The client resubscribes (full reload) once a
        // tenant is picked in the header switcher.
        ws.send({ type: "no-tenant" as const });
        return;
      }
      if (!tryAttachEvents(user.id)) {
        ws.close(WS_CLOSE.POLICY_VIOLATION, "too many connections");
        return;
      }
      eventsAttached.add(String(ws.id));
      ws.subscribe(TOPICS.tenant(resolution.tenantId));
      ws.send({
        type: "subscribed" as const,
        tenantId: String(resolution.tenantId),
      });
    },
    close(ws) {
      const id = String(ws.id);
      const { user } = ws.data;
      if (user && eventsAttached.has(id)) {
        detachEvents(user.id);
        eventsAttached.delete(id);
      }
    },
    error({ error }) {
      logger.warn({ error }, "realtime/events ws error");
    },
  });
