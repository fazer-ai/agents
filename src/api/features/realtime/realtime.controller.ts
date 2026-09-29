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

// `ws.id` strings (not `ws` wrappers) that reserved a slot via `tryAttachUser`: Elysia 1.4.x rewraps
// `ws` per lifecycle hook, so the wrapper is not a stable key (see `realtime.service.ts`).
const attached = new Set<string>();

// `ws.id` strings that reserved a slot on the /events channel (its own
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

// No `response` schema on purpose: with one set, Elysia 1.4.x rejects every return value of
// `.ws()`'s `message` handler, whatever the schema's shape. Body validation works and stays; client
// typing of server messages comes from the `useWebSocket<TIn, TOut>` generics. Smoke-test a manual
// round trip before reintroducing a response schema.

// WS upgrades are double-gated for CSRF: the auth cookie is
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
  // HTTP to WS bridge: `sendToUser` from outside a WS handler takes the same `server.publish`
  // path, which is how a background job or webhook reaches a user's open tabs. This one pings the
  // caller; a route that targets other users must gate who can target whom.
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
        // NOTE: targeted push to every open connection of this user (other tabs and devices), not
        // to peers.
        sendToUser(user.id, { type: "private-ping", at: Date.now() });
        return;
      }
      if (msg.type === "join-admin") {
        // NOTE: the server alone decides a subscription. The reply is a per-socket ws.send, not a
        // topic publish, because only the asking client cares about the ack.
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
        // NOTE: recheck the role on every publish, since having joined is not permission now. The
        // role is captured at upgrade, so this only bites once roles can change mid-session.
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
        // NOTE: server.publish, not ws.publish (which excludes the sender), so the sender sees
        // their own message in the same timeline as the peers.
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
      // No explicit `ws.unsubscribe(...)` here. Bun automatically
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
        // NOTE: SUPER_ADMIN with no active tenant selected yet: stay connected but subscribe to
        // nothing. Picking a tenant in the header reloads the page, which reconnects.
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
