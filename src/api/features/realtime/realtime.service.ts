import type { UserRole } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { realtimeConfig } from "@/api/lib/realtime";
import { authorize, resolveRequestTenantContext } from "@/lib/tenancy";

// NOTE: In-process state. Single-instance servers (the template default)
// are fine. If this template ever scales horizontally (multiple Bun
// processes behind a load balancer), bridge `userConnections` through a
// distributed store (e.g. Redis with TTL keys) so every node sees the
// same global count and enforces the per-user cap consistently. Topic
// fan-out itself is delegated to Bun's native WebSocket adapter
// (ws.subscribe / server.publish), which is also single-process; the
// distributed answer is mirroring topics over Redis pub/sub so a
// publish on one node reaches subscribers on the others.
//
// NOTE: All per-socket state is keyed by `ws.id` (string), NOT the `ws`
// wrapper object. Elysia 1.4.x wraps the underlying Bun socket in a fresh
// JS proxy for every lifecycle hook (open/message/close), so the wrapper's
// identity differs across hooks even though it represents the same
// connection (upstream issue elysiajs/elysia#1716, still open). `ws.id`
// is provided by the Bun adapter and is stable across hooks.
const userConnections = new Map<string, number>();

// NOTE: Topic naming convention. Every connection in the demo subscribes
// to CHAT_GLOBAL (where the chat and presence ticks fan out) and to its
// own user(id) channel (where sendToUser delivers to all of that user's
// tabs/devices without a global broadcast). For app-specific features,
// define new topics here and have the relevant controller
// `ws.subscribe()` them in `open`. Rooms typically follow chat:<roomId>
// or doc:<docId>; resource-scoped event streams follow entity:<id>:events.
export const TOPICS = {
  CHAT_GLOBAL: "chat:global",
  // NOTE: ADMIN_BROADCASTS is an auth-gated topic: subscribing is NOT
  // automatic in `open`; the client must send `join-admin` and the
  // controller validates `user.role === "ADMIN"` before calling
  // `ws.subscribe(...)`. Publishing into this topic is also recheck-gated
  // in the controller, because "the user joined once" is not the same as
  // "the user has permission right now". This is the canonical pattern
  // for any role-gated or membership-gated topic (rooms, per-doc
  // permissions, organizational scopes).
  ADMIN_BROADCASTS: "admin:broadcasts",
  user: (id: bigint | string) => `user:${id}`,
  // NOTE: per-tenant fan-out for operational events (conversation metadata
  // changes). A tenant-bound user is auto-subscribed to their own tenant in
  // `open`; a SUPER_ADMIN follows the active tenant they selected (the
  // cross-tenant gate is `resolveEventsTenant` below, the WS analogue of the
  // REST X-Tenant-Id rule). Payloads carry METADATA only — never message body
  // or contact PII — so a subscriber sees no more than the read API exposes.
  tenant: (id: bigint | string) => `tenant:${id}`,
} as const;

export interface PresenceTick {
  type: "tick";
  at: number;
  // NOTE: Distinct users online, not total open sockets. One user with
  // three tabs counts as one. Broadcasts only fire on the transitions
  // that actually move this number (0→1 attach, 1→0 detach), so opening
  // a second tab as the same user is silent for peers, and closing a
  // non-last tab is silent too.
  userCount: number;
}

export interface ChatMessage {
  type: "message";
  at: number;
  from: { userId: string; displayName: string };
  payload: string;
}

export interface PrivatePing {
  type: "private-ping";
  at: number;
}

export interface AdminBroadcast {
  type: "admin-broadcast";
  at: number;
  from: { userId: string; displayName: string };
  payload: string;
}

// NOTE: A conversation's mirror metadata changed (status/assignee/recency).
// Fan-out on the per-tenant topic so every operator tab watching that tenant
// updates live. METADATA ONLY by construction (no message body, no contact
// name) — the client merges these fields into its list row or refetches the
// detail via REST (which applies the server-side PII gate). The id is our
// internal Conversation row id (a string-serialized bigint), matching the
// read API's `conversation.id`.
export interface ConversationEvent {
  type: "conversation";
  at: number;
  tenantId: string;
  conversationId: string;
  status: string | null;
  assigneeId: number | null;
  assigneeType: string | null;
  lastEventAt: string | null;
  isGroup: boolean;
}

// NOTE: A TRANSIENT, ephemeral signal that the agent is actively working a
// conversation right now — the operator's "typing indicator". Unlike
// ConversationEvent (a persisted mirror change), this is NOT stored and reflects
// only live graph progress: `phase` is the envelope (started → step* → finished)
// and `stage` the coarse step (the model generating = "thinking"; a tool
// executing = "tool", with its name in `tool` so the UI can show a specific
// label). Metadata only by construction — an enum plus a tool name (operator
// config the operator already sees), never message content or contact PII. The
// id is our internal Conversation row id (string-serialized bigint), matching
// the read API's `conversation.id`. Fans out on the per-tenant topic.
export type AgentActivityPhase = "started" | "step" | "finished";
// "debounce" = inbound burst is being coalesced (the operator sees "receiving messages…") before any
// turn runs; "thinking"/"tool" are the turn's live steps.
export type AgentActivityStage = "thinking" | "tool" | "debounce";

export interface AgentActivityEvent {
  type: "agent-activity";
  at: number;
  tenantId: string;
  conversationId: string;
  phase: AgentActivityPhase;
  stage: AgentActivityStage | null;
  tool: string | null;
  // For stage "debounce": the ISO time the coalescing window is expected to flush, so the UI can run
  // a live countdown ("waiting for more messages · ~12s"). Absent on other stages.
  runAt?: string | null;
  // On phase "finished": how many balloons a split reply produced. >1 lets the UI hold a "delivering"
  // indicator until the balloons arrive over the webhook→mirror roundtrip (which lags the finish).
  balloons?: number | null;
}

// NOTE: Async RAG ingest progress (PENDING → PROCESSING → READY|FAILED). Fans out on the
// per-tenant topic so the operator UI can update document status without polling.
export interface KnowledgeDocumentEvent {
  type: "knowledge-document";
  at: number;
  tenantId: string;
  knowledgeBaseId: string;
  documentId: string;
  status: string;
  chunkCount?: number;
  error?: string;
}

// NOTE: An agent's CONFIG changed (saved via the editor, the REST API, or the MCP server). Fans out
// on the per-tenant topic so any operator tab with that agent's editor open is warned that the version
// it loaded is stale — protecting against silently overwriting a change made elsewhere (the save still
// carries the updatedAt precondition as the authoritative guard; this is the proactive heads-up). The
// id is our internal Agent row id (string-serialized bigint); `updatedAt` is the new version token
// (ISO), compared client-side against the loaded one. Metadata only — no prompt/settings content.
export interface AgentConfigEvent {
  type: "agent-config";
  at: number;
  tenantId: string;
  agentId: string;
  updatedAt: string;
}

export type ServerEvent =
  | PresenceTick
  | ChatMessage
  | PrivatePing
  | AdminBroadcast
  | ConversationEvent
  | AgentActivityEvent
  | KnowledgeDocumentEvent
  | AgentConfigEvent;

type Publisher = (topic: string, data: string) => unknown;
let publisher: Publisher = () => {};

// NOTE: Wires the service to the Bun server's `publish(topic, data)`.
// Called once at boot from `src/index.ts` after `app.listen()`. Tests
// inject a mock here to assert published topics and payloads. Before
// this is called the service is a no-op publisher: publishes happen
// but go nowhere, which is the safe default for ad-hoc imports.
export function setPublisher(p: Publisher): void {
  publisher = p;
}

function publish(topic: string, event: ServerEvent): void {
  // NOTE: Bun's `server.publish` swallows the case of zero subscribers
  // and silently no-ops when the topic has no listeners, exactly the
  // behavior we want. The try/catch is defense-in-depth for future
  // runtime changes; the dead-subscriber pruning lives in Bun itself.
  try {
    publisher(topic, JSON.stringify(event));
  } catch (error) {
    // NOTE: Non-throwing contract preserved (callers in WS lifecycle
    // hooks must not see exceptions from a publish), but we surface the
    // failure so dropped realtime events are diagnosable in production.
    // Bad subscribers themselves are dropped by Bun's close handler;
    // this catch covers serializer failures and publisher misconfig.
    logger.warn({ error, topic }, "realtime publish failed");
  }
}

export function broadcastChatMessage(message: ChatMessage): void {
  publish(TOPICS.CHAT_GLOBAL, message);
}

// NOTE: Publishes to the admin-only topic. Callers MUST have
// re-validated the sender's role at the call site; the service does
// not check permissions, it only routes. Auth gating lives in the
// controller because the auth model is app-specific (role check today,
// membership lookup or ACL query in real apps).
export function broadcastAdminMessage(message: AdminBroadcast): void {
  publish(TOPICS.ADMIN_BROADCASTS, message);
}

// NOTE: Pushes an event to every open connection of the given user
// across all their tabs/devices. Uses the per-user topic, so the cost
// is O(N) in that user's connection count (1 in the common case), not
// O(connected users). Useful for notifications, balance updates,
// per-user resource-change events, etc.
export function sendToUser(userId: bigint, event: ServerEvent): void {
  publish(TOPICS.user(userId), event);
}

// NOTE: Server-side HTTP→WS bridge for conversation metadata changes. Called
// from the Chatwoot webhook processor (canonical source) and the REST
// conversation ops (optimistic feedback) — both outside any WS handler, the
// same pattern the realtime doc blesses for background/webhook publishes. The
// publisher is a no-op until `setPublisher` runs at boot, so importing this
// from a service is side-effect-free in tests.
export function broadcastConversationEvent(
  tenantId: bigint,
  data: Omit<ConversationEvent, "type" | "at" | "tenantId">,
): void {
  publish(TOPICS.tenant(tenantId), {
    type: "conversation",
    at: Date.now(),
    tenantId: tenantId.toString(),
    ...data,
  });
}

// NOTE: Live "the agent is working" indicator. Called from the agent runtime
// (the LangGraph callback `AgentStatusReporter` + the started/finished envelope
// around the invoke) — outside any WS handler, same background-publish pattern
// the realtime doc blesses. Transient and metadata-only (see AgentActivityEvent):
// the client shows a typing indicator keyed on `conversationId` and clears it on
// `finished` (with a client-side TTL as the safety net, since a publish during a
// socket disconnect is lost — Bun no-ops an absent subscriber).
export function broadcastAgentActivity(
  tenantId: bigint,
  data: Omit<AgentActivityEvent, "type" | "at" | "tenantId">,
): void {
  publish(TOPICS.tenant(tenantId), {
    type: "agent-activity",
    at: Date.now(),
    tenantId: tenantId.toString(),
    ...data,
  });
}

// NOTE: RAG ingest progress indicator. Called from the document service when a document's
// status transitions (PENDING → PROCESSING → READY|FAILED). Transient metadata — no document
// content or contact PII. Fans out on the per-tenant topic; the client can update document
// list rows without polling.
export function broadcastDocumentEvent(
  tenantId: bigint,
  data: Omit<KnowledgeDocumentEvent, "type" | "at" | "tenantId">,
): void {
  publish(TOPICS.tenant(tenantId), {
    type: "knowledge-document",
    at: Date.now(),
    tenantId: tenantId.toString(),
    ...data,
  });
}

// NOTE: Agent config-change indicator. Called from the agent service after any successful
// updateAgent / replaceAgentToolSelections (REST or MCP) — outside any WS handler, the same
// background-publish pattern the realtime doc blesses. Metadata only (agent id + new updatedAt). The
// editor compares `updatedAt` against the version it loaded and shows a "changed elsewhere" banner.
export function broadcastAgentConfigEvent(
  tenantId: bigint,
  data: Omit<AgentConfigEvent, "type" | "at" | "tenantId">,
): void {
  publish(TOPICS.tenant(tenantId), {
    type: "agent-config",
    at: Date.now(),
    tenantId: tenantId.toString(),
    ...data,
  });
}

// ── per-tenant events channel: connection cap + cross-tenant subscribe gate ──
//
// NOTE: A connection cap dedicated to the /events socket, kept separate from
// the presence/chat cap (`userConnections`) so the two channels do not inflate
// each other's counts. Same per-user ceiling; presence is irrelevant here so
// there is no ticker, just the bound.
const eventsConnections = new Map<string, number>();

export function tryAttachEvents(id: bigint): boolean {
  const key = id.toString();
  const count = eventsConnections.get(key) ?? 0;
  if (count >= realtimeConfig.maxConnectionsPerUser) return false;
  eventsConnections.set(key, count + 1);
  return true;
}

export function detachEvents(id: bigint): void {
  const key = id.toString();
  const count = eventsConnections.get(key) ?? 0;
  if (count === 0) return;
  if (count === 1) eventsConnections.delete(key);
  else eventsConnections.set(key, count - 1);
}

export type EventsTenantResolution =
  | { status: "subscribe"; tenantId: bigint; anomaly: boolean }
  | { status: "no-tenant"; anomaly: boolean }
  | { status: "denied"; anomaly: boolean };

// NOTE: The WS analogue of the REST X-Tenant-Id rule, reusing the exact same
// resolution + cross-tenant gate so the two transports cannot diverge:
//   • a tenant-bound user (TENANT_ADMIN/AGENT) is LOCKED to their own tenant —
//     any selector they pass is ignored and flagged as an anomaly (no leak);
//   • a SUPER_ADMIN FOLLOWS the active tenant passed as `?tenantId=` (the same
//     selector the header switcher persists), authorized for any target;
//   • a SUPER_ADMIN with no/invalid selector resolves to "no-tenant" — there is
//     simply nothing to stream yet, not an error.
// Pure (no Elysia, no I/O) so the security-critical decision is unit-tested
// directly, mirroring resolveRequestTenantContext.
export function resolveEventsTenant(
  user: { id: bigint; tenantId: bigint | null; role: UserRole },
  selectorTenantId: string | undefined,
): EventsTenantResolution {
  const { context, anomaly } = resolveRequestTenantContext(
    user,
    selectorTenantId,
  );
  if (!context) return { status: "denied", anomaly };
  if (context.tenantId === null) return { status: "no-tenant", anomaly };
  try {
    // Defense in depth: re-assert the cross-tenant gate on the resolved target
    // (super → any; everyone else → own). Tautological given the resolution
    // above, but it makes the invariant explicit and fails closed if the
    // resolution ever drifts.
    authorize(context, context.tenantId);
  } catch {
    return { status: "denied", anomaly };
  }
  return { status: "subscribe", tenantId: context.tenantId, anomaly };
}

function buildTick(): PresenceTick {
  return {
    type: "tick",
    at: Date.now(),
    userCount: userConnections.size,
  };
}

function broadcastPresence(): void {
  publish(TOPICS.CHAT_GLOBAL, buildTick());
}

// NOTE: One module-level timer publishes the periodic presence tick to
// CHAT_GLOBAL. Bun fans out to every subscribed socket, so the cost is
// O(1) regardless of how many connections are open, instead of the
// per-socket setInterval + duplicate snapshot build the controller used
// to do. The timer is only kept alive while at least one user is
// attached so test suites (and idle servers) do not leak a running
// interval; lifecycle is gated by the 0→1 / 1→0 transitions in
// tryAttachUser / detachUser.
let presenceTickInterval: ReturnType<typeof setInterval> | null = null;

function startPresenceTicker(): void {
  if (presenceTickInterval !== null) return;
  presenceTickInterval = setInterval(
    broadcastPresence,
    realtimeConfig.tickIntervalMs,
  );
}

function stopPresenceTicker(): void {
  if (presenceTickInterval === null) return;
  clearInterval(presenceTickInterval);
  presenceTickInterval = null;
}

// NOTE: Tries to register a new connection for the user, respecting
// the per-user cap. Returns `false` when the user is already at the
// cap; the caller should refuse the connection. Triggers a presence
// broadcast only when the distinct user count actually changes (this
// is the user's first open connection), so the second tab of the same
// user does not appear as a phantom new user on peers. The first
// attach across the whole process also starts the periodic presence
// ticker so peers see liveness without the controller scheduling its
// own timer per socket.
export function tryAttachUser(id: bigint): boolean {
  const key = id.toString();
  const count = userConnections.get(key) ?? 0;
  if (count >= realtimeConfig.maxConnectionsPerUser) return false;
  const wasOffline = count === 0;
  userConnections.set(key, count + 1);
  if (wasOffline) {
    if (userConnections.size === 1) startPresenceTicker();
    broadcastPresence();
  }
  return true;
}

// NOTE: Releases one of the user's connections. No-op for unknown ids.
// Triggers a presence broadcast only when the user's last connection
// drops (distinct user count goes to N-1), matching the semantics of
// tryAttachUser: closing a non-last tab is invisible to peers. Stops
// the periodic ticker when the process has no remaining users, so an
// idle server keeps no live interval and the test suite does not leak
// timers across files.
export function detachUser(id: bigint): void {
  const key = id.toString();
  const count = userConnections.get(key) ?? 0;
  if (count === 0) return;
  if (count === 1) {
    userConnections.delete(key);
    broadcastPresence();
    if (userConnections.size === 0) stopPresenceTicker();
    return;
  }
  userConnections.set(key, count - 1);
}

// NOTE: Distinct users currently holding at least one open connection.
export function currentUserCount(): number {
  return userConnections.size;
}

// NOTE: Snapshot used by the controller to send the initial tick on
// open. Synchronous so a new client sees the right count immediately
// without waiting up to a full tickIntervalMs for the periodic tick.
export function presenceSnapshot(): PresenceTick {
  return buildTick();
}
