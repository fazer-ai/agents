/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type EdenLikeSocket, useWebSocket } from "@/client/hooks/useWebSocket";

type Listener = (event: unknown) => void;

interface FakeSocket extends EdenLikeSocket<unknown, unknown> {
  fireOpen(): void;
  fireMessage(data: unknown): void;
  fireError(): void;
  fireClose(code: number, reason?: string): void;
  readyState(): number;
  sentMessages: unknown[];
  closedWith: { code: number; reason: string } | null;
}

let sockets: FakeSocket[] = [];

function makeFake(): FakeSocket {
  const listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  let state: number = WebSocket.CONNECTING;
  const sent: unknown[] = [];
  let closed: { code: number; reason: string } | null = null;

  const ws = {
    get readyState() {
      return state;
    },
    // NOTE: Mirrors the real WebSocket: `close()` flips state to CLOSING
    // synchronously and dispatches the `close` event asynchronously on the
    // next microtask. The async dispatch is what lets the `reconnect()`
    // race regression test reproduce the scenario where the old socket's
    // close handler runs after the new socket has already been wired in.
    close(code?: number, reason?: string) {
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) return;
      state = WebSocket.CLOSING;
      const ev = { code: code ?? 1000, reason: reason ?? "" };
      queueMicrotask(() => {
        state = WebSocket.CLOSED;
        closed = ev;
        for (const l of listeners.close ?? []) l(ev);
      });
    },
  } as unknown as WebSocket;

  const fake: FakeSocket = {
    ws,
    sentMessages: sent,
    get closedWith() {
      return closed;
    },
    send(data) {
      sent.push(data);
      return undefined;
    },
    on(type: string, listener: Listener) {
      const bucket = listeners[type] ?? [];
      bucket.push(listener);
      listeners[type] = bucket;
      return fake;
    },
    close() {
      ws.close();
      return undefined;
    },
    fireOpen() {
      state = WebSocket.OPEN;
      for (const l of listeners.open ?? []) l(new Event("open"));
    },
    fireMessage(data: unknown) {
      for (const l of listeners.message ?? []) l({ data });
    },
    fireError() {
      for (const l of listeners.error ?? []) l(new Event("error"));
    },
    fireClose(code: number, reason = "") {
      if (state === WebSocket.CLOSED) return;
      state = WebSocket.CLOSED;
      const ev = { code, reason };
      closed = ev;
      for (const l of listeners.close ?? []) l(ev);
    },
    readyState() {
      return state;
    },
  } as FakeSocket;

  sockets.push(fake);
  return fake;
}

function makeFactory() {
  return mock(() => makeFake());
}

// Happy-dom does not own `document.hidden` as a regular property, so
// tests that override it via `Object.defineProperty` must restore the
// original descriptor (or delete the override when none existed) to avoid
// leaking visibility state into later tests, which would silently flip
// pauseWhenHidden assertions in unrelated specs.
function withDocumentHidden() {
  const original = Object.getOwnPropertyDescriptor(document, "hidden");
  return {
    set(hidden: boolean) {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hidden,
      });
    },
    restore() {
      if (original) {
        Object.defineProperty(document, "hidden", original);
      } else {
        delete (document as { hidden?: boolean }).hidden;
      }
    },
  };
}

describe("useWebSocket", () => {
  beforeEach(() => {
    sockets = [];
  });

  afterEach(() => {
    cleanup();
  });

  test("starts in 'connecting' and moves to 'connected' on open", async () => {
    const factory = makeFactory();
    const { result } = renderHook(() => useWebSocket(factory));
    expect(result.current.status).toBe("connecting");
    act(() => sockets[0]?.fireOpen());
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
  });

  test("status stays 'idle' and no socket opens when enabled=false", () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, { enabled: false }),
    );
    expect(result.current.status).toBe("idle");
    expect(factory).not.toHaveBeenCalled();
  });

  test("invokes onMessage and updates lastMessage", async () => {
    const onMessage = mock<(data: unknown) => void>();
    const factory = makeFactory();
    const { result } = renderHook(() => useWebSocket(factory, { onMessage }));
    act(() => sockets[0]?.fireOpen());
    act(() => sockets[0]?.fireMessage({ type: "echo", payload: "hi" }));
    await waitFor(() => {
      expect(result.current.lastMessage).toEqual({
        type: "echo",
        payload: "hi",
      });
    });
    expect(onMessage).toHaveBeenCalledWith({ type: "echo", payload: "hi" });
  });

  test("send returns false until OPEN, true after, and queues nothing", () => {
    const factory = makeFactory();
    const { result } = renderHook(() => useWebSocket(factory));
    let sentBeforeOpen = true;
    act(() => {
      sentBeforeOpen = result.current.send({ type: "ping" });
    });
    expect(sentBeforeOpen).toBe(false);
    expect(sockets[0]?.sentMessages).toEqual([]);
    act(() => sockets[0]?.fireOpen());
    let sentAfterOpen = false;
    act(() => {
      sentAfterOpen = result.current.send({ type: "ping" });
    });
    expect(sentAfterOpen).toBe(true);
    expect(sockets[0]?.sentMessages).toEqual([{ type: "ping" }]);
  });

  test("send returns false and calls onError when the underlying send throws", () => {
    const onError = mock<(event: Event) => void>();
    const factory = makeFactory();
    const { result } = renderHook(() => useWebSocket(factory, { onError }));
    act(() => sockets[0]?.fireOpen());
    // Override send to simulate a race where the socket closed between
    // our readyState check and `socket.send()`.
    const socket = sockets[0];
    if (!socket) throw new Error("expected socket");
    socket.send = () => {
      throw new Error("socket closed mid-send");
    };
    let sent = true;
    act(() => {
      sent = result.current.send({ type: "ping" });
    });
    expect(sent).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("reconnect() is a no-op when the hook is disabled", async () => {
    const factory = makeFactory();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWebSocket(factory, { enabled }),
      { initialProps: { enabled: true } },
    );
    act(() => sockets[0]?.fireOpen());
    expect(factory).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await waitFor(() => {
      expect(result.current.status).toBe("idle");
    });
    act(() => result.current.reconnect());
    // `reconnect()` while disabled must not reopen a socket — the caller
    // is in teardown / auth-loss / paused state.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");
  });

  test("unmount closes the socket with code 1000", async () => {
    const factory = makeFactory();
    const { unmount } = renderHook(() => useWebSocket(factory));
    act(() => sockets[0]?.fireOpen());
    unmount();
    await waitFor(() => {
      expect(sockets[0]?.closedWith?.code).toBe(1000);
    });
  });

  test("abnormal close transitions to 'reconnecting' and re-opens", async () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, { baseDelayMs: 1, maxDelayMs: 5 }),
    );
    act(() => sockets[0]?.fireOpen());
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
    act(() => sockets[0]?.fireClose(1006, "network"));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
    });
    expect(sockets[1]).toBeDefined();
    act(() => sockets[1]?.fireOpen());
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
  });

  test("close code 4401 dispatches auth:unauthorized and stops reconnecting", async () => {
    const handler = mock<() => void>();
    window.addEventListener("auth:unauthorized", handler);

    try {
      // `baseDelayMs: 0` forces the backoff to compute a zero delay,
      // so any reconnect that the hook *would* schedule fires on the next
      // macrotask. We flush one macrotask after the close and assert that
      // no additional `factory()` call happened — a structural check that
      // does not depend on real-clock timing.
      const factory = makeFactory();
      const { result } = renderHook(() =>
        useWebSocket(factory, { baseDelayMs: 0, maxDelayMs: 0 }),
      );
      act(() => sockets[0]?.fireOpen());
      act(() => sockets[0]?.fireClose(4401, "unauthorized"));

      await waitFor(() => {
        expect(handler).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe("disconnected");
      });
      // Yield once to let any scheduled `setTimeout(connect, 0)` fire.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      // Always tear down the global listener so a failing assertion above
      // can't leak it into later tests in the suite.
      window.removeEventListener("auth:unauthorized", handler);
    }
  });

  test("reconnect() resets attempts and reopens", async () => {
    const factory = makeFactory();
    const { result } = renderHook(() => useWebSocket(factory));
    act(() => sockets[0]?.fireOpen());
    act(() => result.current.reconnect());
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
      expect(sockets[0]?.closedWith?.code).toBe(1000);
    });
  });

  test("autoReconnect=false leaves status 'disconnected' on close", async () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, { autoReconnect: false }),
    );
    act(() => sockets[0]?.fireOpen());
    act(() => sockets[0]?.fireClose(1006));
    await waitFor(() => {
      expect(result.current.status).toBe("disconnected");
    });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("status moves to 'error' after maxAttempts failed reconnects", async () => {
    // We close *without* opening, so `attemptRef` is never reset.
    // With maxAttempts=2, the 3rd close in sequence trips the limit branch.
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    );
    act(() => sockets[0]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
    });
    act(() => sockets[1]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(3);
    });
    act(() => sockets[2]?.fireClose(1006));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    // No 4th socket — limit gated the reconnect.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledTimes(3);
  });

  test("close code 1008 is terminal: status 'error' with no reconnect", async () => {
    // Server-side policy violation (cap hit, schema reject). Reconnecting
    // would dogpile the same rejection — the hook should park immediately
    // instead of going through the retry budget.
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, {
        maxAttempts: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    );
    act(() => sockets[0]?.fireOpen());
    act(() => sockets[0]?.fireClose(1008, "policy"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    // Flush a macrotask: any reconnect that the hook *would* schedule with
    // baseDelayMs=0 would fire here. Factory must still be 1.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("handshake-failure cap parks at 'error' after 3 close-before-open events", async () => {
    // Independent from `maxAttempts`: even with a large attempt budget,
    // never seeing an "open" three times in a row is treated as a
    // permanent rejection (auth lost without 4401, origin blocked, server
    // unreachable). The cap stops the loop within seconds rather than
    // grinding through full backoff retries.
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, {
        maxAttempts: 50,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    );
    act(() => sockets[0]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
    });
    act(() => sockets[1]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(3);
    });
    act(() => sockets[2]?.fireClose(1006));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledTimes(3);
  });

  test("a successful open resets the handshake-failure counter", async () => {
    // After opening once, the hook should be willing to ride out long
    // bursts of in-flight disconnects without the handshake cap kicking
    // in — that cap is for sessions that never connect at all.
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, {
        maxAttempts: 10,
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
    );
    act(() => sockets[0]?.fireOpen());
    expect(result.current.status).toBe("connected");
    act(() => sockets[0]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
    });
    // Fail twice more without opening — would trip the handshake cap if
    // the counter hadn't been cleared by the prior successful open.
    act(() => sockets[1]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(3);
    });
    act(() => sockets[2]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(4);
    });
    // Still reconnecting, not parked at error.
    expect(result.current.status).toBe("reconnecting");
  });

  test("onError fires when the subscribe factory throws", () => {
    const onError = mock<(event: Event) => void>();
    const factory = mock(() => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useWebSocket(factory, { onError }));
    expect(result.current.status).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("onError fires on socket error events", () => {
    const onError = mock<(event: Event) => void>();
    const factory = makeFactory();
    renderHook(() => useWebSocket(factory, { onError }));
    act(() => sockets[0]?.fireError());
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("toggling enabled false closes the socket and parks status at 'idle'", async () => {
    const factory = makeFactory();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWebSocket(factory, { enabled }),
      { initialProps: { enabled: true } },
    );
    act(() => sockets[0]?.fireOpen());
    expect(result.current.status).toBe("connected");
    rerender({ enabled: false });
    await waitFor(() => {
      expect(sockets[0]?.closedWith?.code).toBe(1000);
      expect(result.current.status).toBe("idle");
    });
  });

  test("reconnect() does not double-schedule when the old socket closes late", async () => {
    // Regression: in production the old socket's `close` event lands one
    // microtask AFTER reconnect() has created and wired up the new socket.
    // Without the `socketRef.current !== socket` guard, the old handler
    // would call `setTimeout(connect, …)` and a third socket would be
    // opened. The fake's `ws.close()` mirrors that async dispatch via
    // `queueMicrotask`, so this test exercises the exact race.
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, { baseDelayMs: 0, maxDelayMs: 0 }),
    );
    act(() => sockets[0]?.fireOpen());
    expect(factory).toHaveBeenCalledTimes(1);

    act(() => result.current.reconnect());
    // At this point: factory called twice (old + new); old socket is
    // CLOSING with its close dispatch queued on the microtask queue.
    expect(factory).toHaveBeenCalledTimes(2);

    // Let the queued microtask (old socket close) and any setTimeout(0)
    // that the buggy code would have scheduled drain.
    await waitFor(() => {
      expect(sockets[0]?.closedWith?.code).toBe(1000);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(sockets.length).toBe(2);
  });

  test("visibility resume does not revive a hook parked by autoReconnect=false", async () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, { autoReconnect: false, pauseWhenHidden: true }),
    );
    act(() => sockets[0]?.fireOpen());
    act(() => sockets[0]?.fireClose(1006));
    await waitFor(() => {
      expect(result.current.status).toBe("disconnected");
    });
    // Simulate hidden : visible cycle. The hook is parked at
    // "disconnected" with autoReconnect=false; visibility must not
    // resurrect it.
    const visibility = withDocumentHidden();
    try {
      visibility.set(true);
      document.dispatchEvent(new Event("visibilitychange"));
      visibility.set(false);
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(factory).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("disconnected");
    } finally {
      visibility.restore();
    }
  });

  test("pagehide closes the socket synchronously", async () => {
    const factory = makeFactory();
    renderHook(() => useWebSocket(factory));
    act(() => sockets[0]?.fireOpen());
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => {
      expect(sockets[0]?.closedWith?.code).toBe(1000);
    });
  });

  test("pageshow with persisted=true reopens after pagehide", async () => {
    const factory = makeFactory();
    renderHook(() => useWebSocket(factory));
    act(() => sockets[0]?.fireOpen());
    expect(factory).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => {
      expect(sockets[0]?.closedWith?.code).toBe(1000);
    });

    // bfcache restore: page comes back without a full reload.
    act(() => {
      const event = new Event("pageshow") as Event & { persisted: boolean };
      Object.defineProperty(event, "persisted", {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(event);
    });
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
    });
  });

  test("pageshow without persisted does not reopen", async () => {
    const factory = makeFactory();
    renderHook(() => useWebSocket(factory));
    act(() => sockets[0]?.fireOpen());
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => {
      expect(sockets[0]?.closedWith?.code).toBe(1000);
    });
    // Regular pageshow after a real reload would have persisted=false; in
    // that case the bfcache restoration path should NOT fire.
    act(() => {
      const event = new Event("pageshow") as Event & { persisted: boolean };
      Object.defineProperty(event, "persisted", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(event);
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("visibility resume does not revive a hook parked at maxAttempts", async () => {
    const factory = makeFactory();
    const { result } = renderHook(() =>
      useWebSocket(factory, {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        pauseWhenHidden: true,
      }),
    );
    // First close drives attemptRef from 0 to 1 (== limit), scheduling
    // one reconnect attempt; second close hits the cap and parks "error".
    act(() => sockets[0]?.fireClose(1006));
    await waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2);
    });
    act(() => sockets[1]?.fireClose(1006));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    const visibility = withDocumentHidden();
    try {
      visibility.set(true);
      document.dispatchEvent(new Event("visibilitychange"));
      visibility.set(false);
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(factory).toHaveBeenCalledTimes(2);
      expect(result.current.status).toBe("error");
    } finally {
      visibility.restore();
    }
  });
});
