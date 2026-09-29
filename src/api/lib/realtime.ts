// Close codes for WebSocket connections. Pre-upgrade failures (e.g. a
// 401 from `requireAuth`) surface in the browser as `CloseEvent.code: 1006`
// regardless and cannot be customized. The custom 4xxx codes apply only when
// the server closes the socket after the upgrade has succeeded.
export const WS_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
  UNAUTHORIZED: 4401,
  SESSION_EXPIRED: 4402,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

// idleTimeoutSec is below Bun's 120s default so a half-open connection is detected sooner; Bun
// pings on its own (`sendPings` defaults to true), so the schema's `ping`/`pong` are didactic.
// `maxConnectionsPerUser` caps sockets per authenticated user, which the per-IP HTTP rate limiter
// on upgrades does not (file descriptors, tick intervals, memory).
export const realtimeConfig = {
  idleTimeoutSec: 60,
  maxPayloadBytes: 16 * 1024,
  tickIntervalMs: 5_000,
  maxConnectionsPerUser: 5,
};
