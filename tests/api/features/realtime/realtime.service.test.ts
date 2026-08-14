import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type AdminBroadcast,
  broadcastAdminMessage,
  broadcastAgentActivity,
  broadcastChatMessage,
  broadcastConversationEvent,
  type ChatMessage,
  currentUserCount,
  detachEvents,
  detachUser,
  presenceSnapshot,
  resolveEventsTenant,
  sendToUser,
  setPublisher,
  TOPICS,
  tryAttachEvents,
  tryAttachUser,
} from "@/api/features/realtime/realtime.service";
import { realtimeConfig } from "@/api/lib/realtime";

interface PublishCall {
  topic: string;
  data: string;
}

function newRecorder() {
  const calls: PublishCall[] = [];
  const fn = mock((topic: string, data: string) => {
    calls.push({ topic, data });
  });
  return { fn, calls };
}

describe("realtime.service", () => {
  let recorder: ReturnType<typeof newRecorder>;

  beforeEach(() => {
    recorder = newRecorder();
    setPublisher(recorder.fn);
  });

  afterEach(() => {
    // Reset publisher so cross-test side effects can't leak through it.
    setPublisher(() => undefined);
  });

  describe("connection tracking", () => {
    afterEach(() => {
      // Drain any leftover connections so tests stay independent.
      for (let id = 1; id <= 10; id++) {
        for (let i = 0; i < realtimeConfig.maxConnectionsPerUser; i++) {
          detachUser(BigInt(id));
        }
      }
    });

    test("currentUserCount counts distinct users, not sockets", () => {
      // Same user with multiple connections counts as one — the metric is
      // "people online", not "tabs open".
      tryAttachUser(BigInt(1));
      tryAttachUser(BigInt(1));
      tryAttachUser(BigInt(2));
      expect(currentUserCount()).toBe(2);
    });

    test("detachUser is a no-op for unknown ids", () => {
      tryAttachUser(BigInt(1));
      detachUser(BigInt(999));
      expect(currentUserCount()).toBe(1);
    });

    test("detachUser only changes the user count when the last tab drops", () => {
      tryAttachUser(BigInt(1));
      tryAttachUser(BigInt(1));
      detachUser(BigInt(1));
      // User still has one tab open → distinct count unchanged.
      expect(currentUserCount()).toBe(1);
      detachUser(BigInt(1));
      // Last tab dropped → user goes offline.
      expect(currentUserCount()).toBe(0);
    });

    test("tryAttachUser refuses past the per-user cap", () => {
      const cap = realtimeConfig.maxConnectionsPerUser;
      for (let i = 0; i < cap; i++) {
        expect(tryAttachUser(BigInt(1))).toBe(true);
      }
      expect(tryAttachUser(BigInt(1))).toBe(false);
      // Other users are unaffected by another user hitting the cap.
      expect(tryAttachUser(BigInt(2))).toBe(true);
    });

    test("freeing a slot lets the user reconnect", () => {
      const cap = realtimeConfig.maxConnectionsPerUser;
      for (let i = 0; i < cap; i++) tryAttachUser(BigInt(1));
      expect(tryAttachUser(BigInt(1))).toBe(false);
      detachUser(BigInt(1));
      expect(tryAttachUser(BigInt(1))).toBe(true);
    });
  });

  describe("presence ticker (shared)", () => {
    // NOTE: The service owns ONE process-wide setInterval that publishes
    // a presence tick to CHAT_GLOBAL. It is started on the 0→1 user
    // transition and stopped on the 1→0 transition so an idle server
    // keeps no live timer and the test suite does not leak intervals
    // across files. This block stubs setInterval/clearInterval to assert
    // that lifecycle without waiting on real wall-clock time.
    let originalSetInterval: typeof setInterval;
    let originalClearInterval: typeof clearInterval;
    let intervalIds: ReturnType<typeof setInterval>[];
    let intervalFns: (() => void)[];
    let intervalDelays: number[];
    let clearedIds: ReturnType<typeof setInterval>[];

    beforeEach(() => {
      originalSetInterval = globalThis.setInterval;
      originalClearInterval = globalThis.clearInterval;
      intervalIds = [];
      intervalFns = [];
      intervalDelays = [];
      clearedIds = [];

      let nextId = 1;
      globalThis.setInterval = ((fn: () => void, delay: number) => {
        const id = nextId++ as unknown as ReturnType<typeof setInterval>;
        intervalIds.push(id);
        intervalFns.push(fn);
        intervalDelays.push(delay);
        return id;
      }) as typeof setInterval;
      globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
        clearedIds.push(id);
      }) as typeof clearInterval;
    });

    afterEach(() => {
      // Drain users so the ticker stops via the real production path
      // before we restore the globals. Otherwise the next test inherits
      // a "running" interval handle that points at our stub.
      for (let id = 1; id <= 10; id++) {
        for (let i = 0; i < realtimeConfig.maxConnectionsPerUser; i++) {
          detachUser(BigInt(id));
        }
      }
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    });

    test("starts a single shared interval on the first user attach", () => {
      tryAttachUser(BigInt(1));
      expect(intervalDelays).toEqual([realtimeConfig.tickIntervalMs]);
      // Second user must NOT spawn another interval; the ticker is
      // shared at the process level.
      tryAttachUser(BigInt(2));
      expect(intervalIds).toHaveLength(1);
      // Same user opening a second tab is also a no-op for the ticker.
      tryAttachUser(BigInt(2));
      expect(intervalIds).toHaveLength(1);
    });

    test("each tick publishes a fresh snapshot to CHAT_GLOBAL", () => {
      tryAttachUser(BigInt(1));
      // Reset publisher recorder to isolate the periodic-tick publishes
      // from the attach-time broadcast.
      recorder.calls.length = 0;

      // Fire two ticks; both should publish to CHAT_GLOBAL with the
      // current user count.
      intervalFns[0]?.();
      intervalFns[0]?.();

      expect(recorder.calls).toHaveLength(2);
      expect(recorder.calls.map((c) => c.topic)).toEqual([
        TOPICS.CHAT_GLOBAL,
        TOPICS.CHAT_GLOBAL,
      ]);
      for (const call of recorder.calls) {
        expect(JSON.parse(call.data)).toMatchObject({
          type: "tick",
          userCount: 1,
        });
      }
    });

    test("stops the shared interval when the last user detaches", () => {
      tryAttachUser(BigInt(1));
      tryAttachUser(BigInt(2));
      const startedId = intervalIds[0];
      if (!startedId) throw new Error("expected the ticker to be running");

      // Detaching one user when another is still attached must NOT
      // clear the shared interval.
      detachUser(BigInt(1));
      expect(clearedIds).toEqual([]);

      // Detaching the last user clears it.
      detachUser(BigInt(2));
      expect(clearedIds).toEqual([startedId]);
    });

    test("restarts the ticker after a 1→0→1 transition", () => {
      tryAttachUser(BigInt(1));
      detachUser(BigInt(1));
      tryAttachUser(BigInt(1));
      // Two distinct intervals across the lifecycle, the first cleared
      // before the second was installed.
      expect(intervalIds).toHaveLength(2);
      expect(clearedIds).toHaveLength(1);
    });
  });

  describe("presence broadcasts", () => {
    afterEach(() => {
      for (let id = 1; id <= 10; id++) {
        for (let i = 0; i < realtimeConfig.maxConnectionsPerUser; i++) {
          detachUser(BigInt(id));
        }
      }
    });

    test("publishes a tick to CHAT_GLOBAL on a user's first connection", () => {
      tryAttachUser(BigInt(1));
      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe(TOPICS.CHAT_GLOBAL);
      const decoded = JSON.parse(call?.data ?? "{}");
      expect(decoded).toEqual({
        type: "tick",
        at: expect.any(Number),
        userCount: 1,
      });
    });

    test("does NOT publish when the same user opens a second connection", () => {
      tryAttachUser(BigInt(1));
      // Discard the first-attach publish to isolate the second-attach assertion.
      recorder.calls.length = 0;
      tryAttachUser(BigInt(1));
      // Distinct user count did not change → no broadcast.
      expect(recorder.calls).toHaveLength(0);
    });

    test("publishes only when the user's last tab drops, not earlier", () => {
      tryAttachUser(BigInt(1));
      tryAttachUser(BigInt(1));
      recorder.calls.length = 0;

      // First detach: user still has another tab open → no change.
      detachUser(BigInt(1));
      expect(recorder.calls).toHaveLength(0);

      // Second detach: user is fully offline now → broadcast fires with
      // the new (decremented) count.
      detachUser(BigInt(1));
      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe(TOPICS.CHAT_GLOBAL);
      expect(JSON.parse(call?.data ?? "{}")).toMatchObject({
        type: "tick",
        userCount: 0,
      });
    });

    test("does not publish when tryAttachUser is refused (cap hit)", () => {
      const cap = realtimeConfig.maxConnectionsPerUser;
      for (let i = 0; i < cap; i++) tryAttachUser(BigInt(1));
      recorder.calls.length = 0;
      expect(tryAttachUser(BigInt(1))).toBe(false);
      expect(recorder.calls).toHaveLength(0);
    });

    test("does not publish when detachUser is called for an unknown id", () => {
      detachUser(BigInt(999));
      expect(recorder.calls).toHaveLength(0);
    });

    test("presenceSnapshot reflects the current count without publishing", () => {
      tryAttachUser(BigInt(1));
      tryAttachUser(BigInt(2));
      recorder.calls.length = 0;

      const snap = presenceSnapshot();
      expect(snap.type).toBe("tick");
      expect(snap.userCount).toBe(2);
      expect(recorder.calls).toHaveLength(0);
    });
  });

  describe("topic-targeted publishes", () => {
    test("broadcastChatMessage publishes to CHAT_GLOBAL with the serialized message", () => {
      const msg: ChatMessage = {
        type: "message",
        at: 1,
        from: { userId: "42", displayName: "alice" },
        payload: "hello",
      };
      broadcastChatMessage(msg);

      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe(TOPICS.CHAT_GLOBAL);
      expect(JSON.parse(call?.data ?? "{}")).toEqual(msg);
    });

    test("sendToUser publishes to the user-scoped topic, not the global one", () => {
      sendToUser(BigInt(42), { type: "private-ping", at: 7 });

      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe("user:42");
      expect(call?.topic).not.toBe(TOPICS.CHAT_GLOBAL);
      expect(JSON.parse(call?.data ?? "{}")).toEqual({
        type: "private-ping",
        at: 7,
      });
    });

    test("broadcastAdminMessage publishes to ADMIN_BROADCASTS, not CHAT_GLOBAL", () => {
      // The service is permission-agnostic: it routes by topic. Auth
      // gating is the controller's job (role check before this is
      // called). What we assert here is the routing: an admin message
      // must NOT leak into chat:global, and must land on the
      // auth-gated topic where only joined admin sockets listen.
      const msg: AdminBroadcast = {
        type: "admin-broadcast",
        at: 1,
        from: { userId: "1", displayName: "root" },
        payload: "deploy in 5",
      };
      broadcastAdminMessage(msg);

      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe(TOPICS.ADMIN_BROADCASTS);
      expect(call?.topic).not.toBe(TOPICS.CHAT_GLOBAL);
      expect(JSON.parse(call?.data ?? "{}")).toEqual(msg);
    });

    test("a throwing publisher does not propagate the error to callers", () => {
      // If the underlying server.publish ever throws (future runtime change,
      // partially-bound server, etc.), an in-flight chat broadcast or
      // attach/detach must not propagate the error. The service swallows
      // and relies on Bun to clean up dead subscribers.
      setPublisher(() => {
        throw new Error("publish blew up");
      });

      expect(() => {
        broadcastChatMessage({
          type: "message",
          at: 1,
          from: { userId: "1", displayName: "x" },
          payload: "hi",
        });
      }).not.toThrow();
      expect(() =>
        sendToUser(BigInt(1), { type: "private-ping", at: 2 }),
      ).not.toThrow();
      expect(() => tryAttachUser(BigInt(99))).not.toThrow();
      detachUser(BigInt(99));
    });
  });

  describe("tenant events channel", () => {
    afterEach(() => {
      // Drain any leftover events-channel connections so tests stay independent.
      for (let id = 1; id <= 10; id++) {
        for (let i = 0; i < realtimeConfig.maxConnectionsPerUser; i++) {
          detachEvents(BigInt(id));
        }
      }
    });

    test("broadcastConversationEvent publishes a metadata-only event to the tenant topic", () => {
      broadcastConversationEvent(BigInt(7), {
        conversationId: "42",
        status: "open",
        assigneeId: 5,
        assigneeType: "User",
        lastEventAt: "2026-06-02T10:00:00.000Z",
        isGroup: false,
      });

      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe(TOPICS.tenant(BigInt(7)));
      expect(call?.topic).toBe("tenant:7");
      expect(call?.topic).not.toBe(TOPICS.CHAT_GLOBAL);
      const decoded = JSON.parse(call?.data ?? "{}");
      expect(decoded).toEqual({
        type: "conversation",
        at: expect.any(Number),
        tenantId: "7",
        conversationId: "42",
        status: "open",
        assigneeId: 5,
        assigneeType: "User",
        lastEventAt: "2026-06-02T10:00:00.000Z",
        isGroup: false,
      });
    });

    test("broadcastAgentActivity publishes a transient metadata-only event to the tenant topic", () => {
      broadcastAgentActivity(BigInt(7), {
        conversationId: "42",
        phase: "step",
        stage: "tool",
        tool: "search_knowledge",
      });

      expect(recorder.calls).toHaveLength(1);
      const [call] = recorder.calls;
      expect(call?.topic).toBe(TOPICS.tenant(BigInt(7)));
      expect(call?.topic).toBe("tenant:7");
      expect(call?.topic).not.toBe(TOPICS.CHAT_GLOBAL);
      const decoded = JSON.parse(call?.data ?? "{}");
      expect(decoded).toEqual({
        type: "agent-activity",
        at: expect.any(Number),
        tenantId: "7",
        conversationId: "42",
        phase: "step",
        stage: "tool",
        tool: "search_knowledge",
      });
    });

    test("agent-activity rides the SAME per-tenant topic as conversation events", () => {
      // Both metadata-only event kinds fan out on the tenant channel, so a single
      // subscription drives the list merge AND the working indicator.
      broadcastConversationEvent(BigInt(3), {
        conversationId: "1",
        status: "pending",
        assigneeId: null,
        assigneeType: null,
        lastEventAt: null,
        isGroup: false,
      });
      broadcastAgentActivity(BigInt(3), {
        conversationId: "1",
        phase: "finished",
        stage: null,
        tool: null,
      });
      expect(recorder.calls.map((c) => c.topic)).toEqual([
        TOPICS.tenant(BigInt(3)),
        TOPICS.tenant(BigInt(3)),
      ]);
    });

    test("events-channel cap is independent from the presence cap", () => {
      const cap = realtimeConfig.maxConnectionsPerUser;
      for (let i = 0; i < cap; i++) {
        expect(tryAttachEvents(BigInt(1))).toBe(true);
      }
      expect(tryAttachEvents(BigInt(1))).toBe(false);
      // Attaching on the events channel must NOT inflate the presence user count.
      expect(currentUserCount()).toBe(0);
      // Freeing a slot lets the user reconnect.
      detachEvents(BigInt(1));
      expect(tryAttachEvents(BigInt(1))).toBe(true);
      // Another user is unaffected by the first hitting the cap.
      expect(tryAttachEvents(BigInt(2))).toBe(true);
    });

    test("detachEvents is a no-op for unknown ids", () => {
      expect(() => detachEvents(BigInt(999))).not.toThrow();
    });
  });

  describe("resolveEventsTenant (cross-tenant subscribe gate)", () => {
    const superAdmin = {
      id: BigInt(1),
      tenantId: null,
      role: "SUPER_ADMIN" as const,
    };
    const tenantUser = {
      id: BigInt(2),
      tenantId: BigInt(7),
      role: "AGENT" as const,
    };

    test("SUPER_ADMIN follows the selected active tenant", () => {
      const r = resolveEventsTenant(superAdmin, "9");
      expect(r).toEqual({
        status: "subscribe",
        tenantId: BigInt(9),
        anomaly: false,
      });
    });

    test("SUPER_ADMIN without a selector resolves to no-tenant (nothing to stream)", () => {
      expect(resolveEventsTenant(superAdmin, undefined)).toEqual({
        status: "no-tenant",
        anomaly: false,
      });
    });

    test("SUPER_ADMIN with a malformed selector resolves to no-tenant, not an error", () => {
      expect(resolveEventsTenant(superAdmin, "not-a-bigint")).toEqual({
        status: "no-tenant",
        anomaly: false,
      });
    });

    test("a tenant-bound user is locked to their own tenant (no selector)", () => {
      expect(resolveEventsTenant(tenantUser, undefined)).toEqual({
        status: "subscribe",
        tenantId: BigInt(7),
        anomaly: false,
      });
    });

    test("a tenant-bound user passing their own tenant is not an anomaly", () => {
      expect(resolveEventsTenant(tenantUser, "7")).toEqual({
        status: "subscribe",
        tenantId: BigInt(7),
        anomaly: false,
      });
    });

    test("a tenant-bound user's FOREIGN selector is ignored (locked to own) and flagged", () => {
      // The load-bearing isolation check: a non-super cannot follow another
      // tenant's channel by passing ?tenantId=. The selector is dropped, they
      // stay on their own tenant, and the mismatch is flagged as an anomaly.
      const r = resolveEventsTenant(tenantUser, "9");
      expect(r).toEqual({
        status: "subscribe",
        tenantId: BigInt(7),
        anomaly: true,
      });
    });
  });
});
