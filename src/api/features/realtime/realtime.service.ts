import type { UserRole } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { realtimeConfig } from "@/api/lib/realtime";
import { authorize, resolveRequestTenantContext } from "@/lib/tenancy";
import { type Membership, resolveMembership } from "@/lib/tenancy/membership";

// Process-local, like Bun's pub/sub: a horizontal deploy needs a shared store and a topic bridge
// (docs/realtime.md, "State per process"). Per-socket state is keyed by `ws.id`, never the `ws`
// wrapper, which Elysia 1.4.x re-creates for every lifecycle hook.
const userConnections = new Map<string, number>();

// Every presence/chat connection subscribes to CHAT_GLOBAL and to its own `user(id)` channel, which
// reaches all of that user's tabs without a global broadcast.
export const TOPICS = {
  CHAT_GLOBAL: "chat:global",
  // Auth-gated: subscribed only on `join-admin`, and publishing re-checks the role, because having
  // joined once is not having permission now (docs/realtime.md).
  ADMIN_BROADCASTS: "admin:broadcasts",
  user: (id: bigint | string) => `user:${id}`,
  // Per-tenant operational events, gated by `resolveEventsTenant`. Payloads carry metadata only,
  // never message body or contact PII, so a subscriber sees no more than the read API exposes.
  tenant: (id: bigint | string) => `tenant:${id}`,
} as const;

export interface PresenceTick {
  type: "tick";
  at: number;
  // Distinct users online, not open sockets; broadcast only when this number moves.
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

// A conversation's mirror metadata changed. Metadata only (no message body, no contact name): the
// client merges it or refetches through REST, which applies the PII gate. `conversationId` is our
// Conversation row id, matching the read API's `conversation.id`.
export interface ConversationEvent {
  type: "conversation";
  at: number;
  tenantId: string;
  conversationId: string;
  status: string | null;
  assigneeId: number | null;
  assigneeType: string | null;
  lastEventAt: string | null;
}

// A transient, unstored signal that the agent is working a conversation now (the operator's typing
// indicator): `phase` is the envelope (started, step*, finished), `stage` the coarse step. Metadata
// only: an enum plus a tool name the operator already configured.
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
  // On the `skip_reply` step: whether the turn had already reached the customer, since mid-turn there
  // is no timeline to consult. Absent means unknown, not "no".
  delivered?: boolean;
}

// Async RAG ingest progress (PENDING, PROCESSING, READY or FAILED), so the UI updates without polling.
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

// An agent's config changed anywhere, so an open editor can warn that its version is stale. Only a
// heads-up: the save's `updatedAt` precondition is the authoritative guard. Metadata only.
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

// Wires the service to the Bun server's `publish`, once at boot; tests inject a mock. Until then
// publishes go nowhere, so importing this module has no side effect.
export function setPublisher(p: Publisher): void {
  publisher = p;
}

function publish(topic: string, event: ServerEvent): void {
  try {
    publisher(topic, JSON.stringify(event));
  } catch (error) {
    // NOTE: never throws, since callers in WS lifecycle hooks must not see a publish failure, but
    // a dropped event is logged.
    logger.warn({ error, topic }, "realtime publish failed");
  }
}

export function broadcastChatMessage(message: ChatMessage): void {
  publish(TOPICS.CHAT_GLOBAL, message);
}

// Routes only: callers MUST have re-validated the sender's role, since the service checks nothing.
export function broadcastAdminMessage(message: AdminBroadcast): void {
  publish(TOPICS.ADMIN_BROADCASTS, message);
}

// Every open connection of one user, through the per-user topic rather than a global broadcast.
export function sendToUser(userId: bigint, event: ServerEvent): void {
  publish(TOPICS.user(userId), event);
}

// Called outside any WS handler, from the Chatwoot webhook processor and the REST conversation ops.
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

// Called from the agent runtime. A publish during a socket disconnect is lost, so the client also
// clears the indicator on a TTL, not only on `finished`.
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

// Called from the document service on each status transition.
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

// Called from the agent service after any successful update, from any transport.
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

// The /events socket's own connection cap, separate from `userConnections` so the two channels do
// not inflate each other's counts.
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

// The WS analogue of the REST X-Tenant-Id rule, on the same resolution and gate so the transports
// cannot diverge. A member picks with `?tenantId=` (outside their memberships is DENIED, never
// swapped); a single-tenant principal is locked and a selector is only an anomaly; a SUPER_ADMIN
// follows the selector, or gets "no-tenant" without one. Pure, so it is unit-tested directly.
export function resolveEventsTenant(
  user: {
    id: bigint;
    tenantId: bigint | null;
    role: UserRole;
    memberships?: readonly Membership[];
  },
  selectorTenantId: string | undefined,
): EventsTenantResolution {
  // NOTE: the upgrade request carries no X-Tenant-Id, so the session holds the default membership
  // and the selector is resolved here against all of them.
  if (user.role !== "SUPER_ADMIN" && user.memberships) {
    const picked = resolveMembership(user.memberships, selectorTenantId);
    if (picked === null || "rejected" in picked) {
      return { status: "denied", anomaly: false };
    }
    user = { ...user, tenantId: picked.tenantId, role: picked.role };
  }
  const { context, anomaly } = resolveRequestTenantContext(
    user,
    selectorTenantId,
  );
  if (!context) return { status: "denied", anomaly };
  if (context.tenantId === null) return { status: "no-tenant", anomaly };
  try {
    // NOTE: redundant with the resolution above, and kept so a drift there fails closed.
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

// One process-wide presence timer rather than one per socket, alive only while a user is attached
// so idle servers and test suites do not leak an interval.
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

// `false` when the user is at the per-user cap, and the caller refuses the connection. Broadcasts
// presence only on the user's first connection, so a second tab is not a phantom new user.
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

// Broadcasts presence only when the user's last connection drops, and stops the ticker with the
// last user.
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

export function currentUserCount(): number {
  return userConnections.size;
}

// The initial tick on open, so a new client does not wait a full interval for the count.
export function presenceSnapshot(): PresenceTick {
  return buildTick();
}
