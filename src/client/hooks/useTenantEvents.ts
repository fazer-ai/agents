import { useCallback } from "react";
import { useAuth } from "@/client/contexts/AuthContext";
import { getActiveTenantId } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { useWebSocket } from "./useWebSocket";

// Per-tenant realtime events channel (conversation metadata changes). The hook
// follows the SAME tenant the REST layer targets: a tenant-bound user streams
// their own tenant; a SUPER_ADMIN streams the active tenant they picked in the
// header switcher (`getActiveTenantId()`), mirrored as the `?tenantId=`
// selector. The server is the authority — it ignores the selector for
// non-super principals and authorizes any target for a SUPER_ADMIN. Because the
// switcher does a full page reload on change, the effective tenant is fixed for
// the lifetime of this hook instance; no mid-connection re-subscribe is needed.

// Mirrors the server `ServerEvent`s delivered on the tenant topic plus the
// per-socket control acks. Kept in sync with `realtime.service.ts`.
export type AgentActivityPhase = "started" | "step" | "finished";
// Mirror of the server type (realtime.service.ts): "debounce" = inbound burst being coalesced.
export type AgentActivityStage = "thinking" | "tool" | "debounce";

export type TenantRealtimeEvent =
  | { type: "subscribed"; tenantId: string }
  | { type: "no-tenant" }
  | {
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
  | {
      type: "agent-activity";
      at: number;
      tenantId: string;
      conversationId: string;
      phase: AgentActivityPhase;
      stage: AgentActivityStage | null;
      tool: string | null;
      runAt?: string | null;
      balloons?: number | null;
    }
  | {
      type: "knowledge-document";
      at: number;
      tenantId: string;
      knowledgeBaseId: string;
      documentId: string;
      status: string;
      chunkCount?: number;
      error?: string;
    }
  | {
      type: "agent-config";
      at: number;
      tenantId: string;
      agentId: string;
      updatedAt: string;
    };

export interface ConversationRealtimeEvent {
  conversationId: string;
  status: string | null;
  assigneeId: number | null;
  assigneeType: string | null;
  lastEventAt: string | null;
  isGroup: boolean;
}

export interface AgentActivityRealtimeEvent {
  conversationId: string;
  phase: AgentActivityPhase;
  stage: AgentActivityStage | null;
  tool: string | null;
  runAt?: string | null;
  balloons?: number | null;
}

export interface KnowledgeDocumentRealtimeEvent {
  knowledgeBaseId: string;
  documentId: string;
  status: string;
  chunkCount?: number;
  error?: string;
}

export interface AgentConfigRealtimeEvent {
  agentId: string;
  updatedAt: string;
}

export interface UseTenantEventsOptions {
  enabled?: boolean;
  // Fired for every `conversation` event on the active tenant's channel.
  onConversation?: (event: ConversationRealtimeEvent) => void;
  // Fired for every `agent-activity` event — the transient "agent is working"
  // indicator. Consumers key on conversationId and clear on phase "finished"
  // (plus a local TTL, since a publish during a socket gap is lost).
  onAgentActivity?: (event: AgentActivityRealtimeEvent) => void;
  // Fired when an async RAG ingest status changes (PENDING → PROCESSING → READY|FAILED).
  onKnowledgeDocument?: (event: KnowledgeDocumentRealtimeEvent) => void;
  // Fired when an agent's config changed (saved via the editor, the REST API, or the MCP server). The
  // open editor compares `updatedAt` against the version it loaded to warn before overwriting.
  onAgentConfig?: (event: AgentConfigRealtimeEvent) => void;
}

export function useTenantEvents(options: UseTenantEventsOptions = {}) {
  const { user } = useAuth();
  // A tenant-bound user uses their own tenant; a SUPER_ADMIN follows the active
  // selection. null → nothing to stream (hook stays disabled).
  const tenantId = user?.tenantId ?? getActiveTenantId();
  const enabled = (options.enabled ?? true) && !!user && !!tenantId;

  const subscribe = useCallback(
    () =>
      api.api.realtime.events.subscribe({
        // `enabled` guards this from ever running without a tenantId.
        query: { tenantId: tenantId ?? "" },
      }),
    [tenantId],
  );

  const onConversation = options.onConversation;
  const onAgentActivity = options.onAgentActivity;
  const onKnowledgeDocument = options.onKnowledgeDocument;
  const onAgentConfig = options.onAgentConfig;
  return useWebSocket<never, TenantRealtimeEvent>(subscribe, {
    enabled,
    onMessage: (msg) => {
      if (msg.type === "conversation") {
        onConversation?.({
          conversationId: msg.conversationId,
          status: msg.status,
          assigneeId: msg.assigneeId,
          assigneeType: msg.assigneeType,
          lastEventAt: msg.lastEventAt,
          isGroup: msg.isGroup,
        });
      } else if (msg.type === "agent-activity") {
        onAgentActivity?.({
          conversationId: msg.conversationId,
          phase: msg.phase,
          stage: msg.stage,
          tool: msg.tool,
          runAt: msg.runAt ?? null,
          balloons: msg.balloons ?? null,
        });
      } else if (msg.type === "knowledge-document") {
        onKnowledgeDocument?.({
          knowledgeBaseId: msg.knowledgeBaseId,
          documentId: msg.documentId,
          status: msg.status,
          chunkCount: msg.chunkCount,
          error: msg.error,
        });
      } else if (msg.type === "agent-config") {
        onAgentConfig?.({ agentId: msg.agentId, updatedAt: msg.updatedAt });
      }
    },
  });
}
