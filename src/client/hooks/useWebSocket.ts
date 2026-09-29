import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "error";

// Duck-typed shape that matches `EdenWS<Schema>` from
// `@elysiajs/eden`. We do not import `EdenWS` directly because it isn't part
// of the top-level package export; relying on the public surface (send, on,
// close, ws) keeps us robust against internal restructuring of the eden
// package while preserving end-to-end inference at the call site (the
// consumer's factory closes over `api.<route>.subscribe`).
export interface EdenLikeSocket<TIn, TOut> {
  ws: WebSocket;
  send(data: TIn): unknown;
  on(type: "open", listener: (event: Event) => void): unknown;
  on(type: "close", listener: (event: CloseEvent) => void): unknown;
  on(type: "error", listener: (event: Event) => void): unknown;
  on(type: "message", listener: (event: { data: TOut }) => void): unknown;
  close(): unknown;
}

export interface UseWebSocketOptions<TOut> {
  enabled?: boolean;
  autoReconnect?: boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  pauseWhenHidden?: boolean;
  onOpen?: () => void;
  onMessage?: (data: TOut) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (event: Event) => void;
}

export interface UseWebSocketResult<TIn, TOut> {
  status: ConnectionStatus;
  lastMessage: TOut | null;
  // NOTE: `send` returns `true` on success, `false` when the socket is
  // not open or the underlying `.send()` throws. Callers that need
  // delivery guarantees should buffer when `false` is returned and
  // retry on the next `connected` transition.
  send: (data: TIn) => boolean;
  close: (code?: number, reason?: string) => void;
  reconnect: () => void;
}

const AUTH_LOST_CLOSE_CODES = new Set([4401, 4402]);
// Codes the server uses to signal "do not retry": 1008 is sent on
// policy violations (per-user connection cap, invalid message). Reconnecting
// from these would dogpile the same rejection the server just made — surface
// it as an error instead and let the user act (refresh, log out, reduce
// tabs) rather than burning the retry budget on a permanent reject.
const TERMINAL_CLOSE_CODES = new Set([1008]);
// Cap on close-before-open events for a single hook instance.
// Failing to even complete the WS handshake is almost always permanent
// in the lifetime of a tab (auth lost, server unreachable, origin
// blocked); short-circuit after a few attempts instead of running
// through `maxAttempts` with full backoff, so the UI shows "error"
// within seconds instead of minutes.
const MAX_HANDSHAKE_FAILURES = 3;

const DEFAULTS = {
  enabled: true,
  autoReconnect: true,
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  pauseWhenHidden: true,
};

function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  // NOTE: 50–100% jitter window avoids the thundering-herd when many
  // clients reconnect at once (e.g. after a server restart).
  return exponential * (0.5 + Math.random() * 0.5);
}

// React hook around Eden Treaty's `subscribe()` factory with reconnection, status reporting and
// Page Visibility-aware backoff. `subscribe` returns a fresh socket per call and must be stable
// across renders (module scope or `useCallback`): the hook does not re-subscribe when its identity
// changes, and `reconnect()` applies new args. Typical usage:
//   const subscribe = useCallback(() => api.api.realtime.echo.subscribe(), []);
//   const { status, lastMessage, send } = useWebSocket<TIn, TOut>(subscribe);
export function useWebSocket<TIn, TOut>(
  subscribe: () => EdenLikeSocket<TIn, TOut>,
  options: UseWebSocketOptions<TOut> = {},
): UseWebSocketResult<TIn, TOut> {
  const opts = { ...DEFAULTS, ...options };
  // Only the two flags that gate effect setup are destructured here;
  // the rest are read through `optsRef.current` inside the close handler so
  // they stay live across re-renders without re-running the effect.
  const { enabled, pauseWhenHidden } = opts;

  const [status, setStatus] = useState<ConnectionStatus>(
    enabled ? "connecting" : "idle",
  );
  const [lastMessage, setLastMessage] = useState<TOut | null>(null);

  const socketRef = useRef<EdenLikeSocket<TIn, TOut> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const handshakeFailuresRef = useRef(0);
  const intentionallyClosedRef = useRef(false);
  const pageHiddenRef = useRef(false);
  const subscribeRef = useRef(subscribe);
  const enabledRef = useRef(enabled);
  // Keep latest callbacks in refs so we don't re-open the socket
  // on each render that produces fresh function identities.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  subscribeRef.current = subscribe;
  enabledRef.current = enabled;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    intentionallyClosedRef.current = false;
    setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

    let socket: EdenLikeSocket<TIn, TOut>;
    try {
      socket = subscribeRef.current();
    } catch (err) {
      setStatus("error");
      optsRef.current.onError?.(new ErrorEvent("error", { error: err }));
      return;
    }
    socketRef.current = socket;
    // Closure-captured per-socket flag: lets the close handler
    // tell apart "we never finished the handshake" (auth/network/origin
    // /etc.) from "we were connected and then dropped" (server restart,
    // idle timeout, user navigated). The two paths cap retries
    // differently.
    let opened = false;

    // Each socket's listeners guard against `socketRef.current` pointing at a *different* socket.
    // During `reconnect()` the old socket's close handler runs a tick later, when the ref already holds
    // the new one, and would otherwise schedule a duplicate reconnect and open a third socket. With the
    // ref null (manual close, unmount) the handler proceeds: the `intentionallyClosedRef` branch below
    // drives the final status.
    const isCurrent = () =>
      socketRef.current === null || socketRef.current === socket;

    socket.on("open", () => {
      if (!isCurrent()) return;
      opened = true;
      attemptRef.current = 0;
      handshakeFailuresRef.current = 0;
      setStatus("connected");
      optsRef.current.onOpen?.();
    });

    socket.on("message", (event) => {
      if (!isCurrent()) return;
      setLastMessage(event.data);
      optsRef.current.onMessage?.(event.data);
    });

    socket.on("error", (event) => {
      if (!isCurrent()) return;
      optsRef.current.onError?.(event);
    });

    socket.on("close", (event) => {
      if (!isCurrent()) return;
      optsRef.current.onClose?.(event.code, event.reason);

      if (AUTH_LOST_CLOSE_CODES.has(event.code)) {
        // NOTE: Server signaled the session is no longer valid; mirror
        // the HTTP 401 channel so AuthContext clears the user and the
        // app navigates to the login screen.
        intentionallyClosedRef.current = true;
        setStatus("disconnected");
        window.dispatchEvent(new CustomEvent("auth:unauthorized"));
        return;
      }

      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        // NOTE: Server explicitly rejected this session (cap hit,
        // invalid message, etc.). Reconnecting would just trigger the
        // same rejection: park at "error" so the user notices and the
        // loop stops instead of grinding through the full retry budget.
        intentionallyClosedRef.current = true;
        setStatus("error");
        return;
      }

      if (intentionallyClosedRef.current) {
        // NOTE: When the close is intentional, the resulting status
        // depends on *why* it happened: `enabled` flipping false parks
        // at "idle"; explicit close() / unmount / auth-lost parks at
        // "disconnected". We read `enabledRef` because the close event
        // dispatches one microtask after the parent effect already
        // wrote its own status.
        setStatus(enabledRef.current ? "disconnected" : "idle");
        return;
      }

      if (!optsRef.current.autoReconnect) {
        setStatus("disconnected");
        return;
      }

      // NOTE: A close that fires before the socket ever opened means
      // the upgrade itself failed. Browsers surface this as 1006 (or
      // 1002 on some) regardless of the underlying HTTP status. We
      // can't tell auth-lost from server-down from origin-blocked at
      // the protocol level, so we just cap how many of these in a row
      // we tolerate before parking at "error". Once an open succeeds,
      // the counter is reset and full reconnect budget is back in play.
      if (!opened) {
        handshakeFailuresRef.current += 1;
        if (handshakeFailuresRef.current >= MAX_HANDSHAKE_FAILURES) {
          setStatus("error");
          return;
        }
      }

      const limit = optsRef.current.maxAttempts;
      if (limit !== 0 && attemptRef.current >= limit) {
        setStatus("error");
        return;
      }

      // NOTE: Page Visibility: defer the next attempt until the tab is
      // visible again. The visibilitychange listener installed below
      // will trigger an immediate reconnect when the tab regains focus.
      if (optsRef.current.pauseWhenHidden && document.hidden) {
        setStatus("reconnecting");
        return;
      }

      const delay = backoffDelay(
        attemptRef.current,
        optsRef.current.baseDelayMs,
        optsRef.current.maxDelayMs,
      );
      attemptRef.current += 1;
      setStatus("reconnecting");
      reconnectTimerRef.current = setTimeout(connect, delay);
    });
  }, []);

  const closeSocket = useCallback(
    (code: number = 1000, reason: string = "client-close") => {
      intentionallyClosedRef.current = true;
      clearReconnectTimer();
      const socket = socketRef.current;
      if (socket && socket.ws.readyState <= WebSocket.OPEN) {
        // NOTE: Eden's `.close()` accepts no args; the raw `.ws.close()` does.
        socket.ws.close(code, reason);
      }
      socketRef.current = null;
    },
    [clearReconnectTimer],
  );

  const reconnect = useCallback(() => {
    closeSocket(1000, "manual-reconnect");
    attemptRef.current = 0;
    handshakeFailuresRef.current = 0;
    // NOTE: Respect `enabled`. Calling `reconnect()` while the hook is
    // disabled (teardown, auth-loss, deliberate pause) would otherwise
    // reopen a socket the caller does not want, fighting the disclosure
    // contract of the `enabled` flag.
    if (enabledRef.current) connect();
  }, [closeSocket, connect]);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    attemptRef.current = 0;
    handshakeFailuresRef.current = 0;
    connect();
    return () => {
      closeSocket(1000, "unmount");
    };
  }, [enabled, connect, closeSocket]);

  // NOTE: Page Visibility: pause reconnection timers in background
  // tabs; on becoming visible again, try once immediately without
  // waiting for the already-scheduled backoff. Respect the same gates
  // the close handler does so the visibility path cannot revive a hook
  // that is parked at `disconnected` (autoReconnect=false) or `error`
  // (maxAttempts hit).
  useEffect(() => {
    if (!enabled || !pauseWhenHidden) return;
    const onVisibility = () => {
      if (document.hidden) {
        clearReconnectTimer();
        return;
      }
      const socket = socketRef.current;
      const isClosed =
        !socket ||
        socket.ws.readyState === WebSocket.CLOSED ||
        socket.ws.readyState === WebSocket.CLOSING;
      if (!isClosed || intentionallyClosedRef.current) return;
      const limit = optsRef.current.maxAttempts;
      const canReconnect =
        optsRef.current.autoReconnect &&
        (limit === 0 || attemptRef.current < limit);
      if (!canReconnect) return;
      clearReconnectTimer();
      connect();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, pauseWhenHidden, connect, clearReconnectTimer]);

  // NOTE: Listen for the app-wide `auth:unauthorized` event (also
  // dispatched by any HTTP 401 from `src/client/lib/api.ts`). Treat it
  // like an in-band 4401: stop reconnecting and let the auth context
  // handle the logout.
  useEffect(() => {
    if (!enabled) return;
    const onUnauthorized = () => {
      closeSocket(1000, "auth-lost");
      setStatus("disconnected");
    };
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, [enabled, closeSocket]);

  // NOTE: Page lifecycle: close the socket synchronously on `pagehide`
  // so the server's close handler fires immediately (frees the
  // connection slot and broadcasts presence to peers) instead of
  // waiting on TCP/idle timeouts. On `pageshow` from bfcache, reopen so
  // the user resumes seamlessly when they navigate back.
  useEffect(() => {
    if (!enabled) return;
    const onPageHide = () => {
      pageHiddenRef.current = true;
      closeSocket(1000, "page-hide");
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !pageHiddenRef.current) return;
      if (!enabledRef.current) return;
      pageHiddenRef.current = false;
      attemptRef.current = 0;
      handshakeFailuresRef.current = 0;
      connect();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, closeSocket, connect]);

  const send = useCallback((data: TIn): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.ws.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(data);
      return true;
    } catch (err) {
      // NOTE: The socket could have closed between the readyState
      // check and the send call (race with the close event). Surface
      // this to the caller so they can buffer or display feedback
      // rather than dropping data.
      optsRef.current.onError?.(new ErrorEvent("error", { error: err }));
      return false;
    }
  }, []);

  return {
    status,
    lastMessage,
    send,
    close: closeSocket,
    reconnect,
  };
}
