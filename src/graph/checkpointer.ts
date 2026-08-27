import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import config from "@/config";
import { parseDbId } from "@/lib/db-id";

// LangGraph checkpointer: a PostgresSaver in the dedicated `langgraph` schema (created by
// scripts/db-bootstrap.sql, owned by the non-superuser runtime role). The thread_id prefix
// (tenant:instance:conversation) is the tenant fence here; RLS on these tables is hardened in a
// later phase. setup() is memoized on globalThis so `bun --hot` reloads reuse the one pool and
// don't re-run CREATE TABLE concurrently.

const KEY = Symbol.for("fazerai.langgraph.checkpointer");

interface Holder {
  promise?: Promise<PostgresSaver>;
}

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= {};
  return g[KEY];
}

async function init(): Promise<PostgresSaver> {
  // NOTE: build the pool ourselves (mirrors PostgresSaver.fromConnString) so we can set `max` — the
  // checkpointer is touched during every graph.invoke, so it needs the same headroom as the main
  // Prisma pool (config.dbPoolMax) or it becomes the bottleneck under concurrent turns.
  const saver = new PostgresSaver(
    new Pool({
      connectionString: config.langgraphDatabaseUrl ?? "",
      max: config.dbPoolMax,
    }),
    undefined,
    { schema: "langgraph" },
  );
  await saver.setup();
  return saver;
}

export function getCheckpointer(): Promise<PostgresSaver> {
  const h = holder();
  h.promise ??= init();
  return h.promise;
}

// Canonical thread key. conversationId is the Chatwoot display_id (per-account), so the
// tenant+instance prefix is required to keep threads from colliding across tenants/instances.
export function chatwootThreadId(
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
): string {
  return `${tenantId}:${instanceId}:${conversationId}`;
}

// Per-CONTACT-INBOX memory thread (graph checkpointer only): continuity across the conversations a
// contact has ON ONE inbox/channel. Keying by the native Chatwoot ContactInbox id (one contact on one
// channel) keeps a contact's parallel channels (WhatsApp vs Instagram, …) in SEPARATE memories instead
// of mixing their contexts. The literal "ci" segment keeps it from colliding with the 3-segment
// per-conversation key, and the leading tenantId keeps threadBelongsToTenant valid. Debounce,
// watermark, follow-up and flowlog stay on chatwootThreadId (per-conversation) — only the graph
// thread_id uses this.
export function contactInboxThreadId(
  tenantId: bigint,
  instanceId: bigint,
  contactInboxId: number,
): string {
  return `${tenantId}:${instanceId}:ci:${contactInboxId}`;
}

// Resolve the graph memory thread for a conversation: per-contact-inbox when the native ContactInbox
// id is known (the normal case for real traffic — the mirror writes it before any turn), else degrade
// to the per-conversation thread. The fallback is NOT a second key scheme: a null contactInboxId only
// happens on legacy rows / a turn that somehow runs before any mirror, and it simply means "no
// cross-conversation continuity for this turn", never a contact+inbox composite key.
export function resolveGraphThreadId(
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
  contactInboxId: number | null,
): string {
  return contactInboxId != null
    ? contactInboxThreadId(tenantId, instanceId, contactInboxId)
    : chatwootThreadId(tenantId, instanceId, conversationId);
}

// Application-level tenant fence for the checkpointer. The `langgraph` schema tables are NOT under
// RLS: the PostgresSaver pool does not carry `app.tenant_id` (it is not a runScoped tx), so FORCE
// RLS would zero out the checkpointer entirely. The thread_id tenant prefix IS the fence, and any
// REST/UI-triggerable entry point (nudge, a future interrupt-resume) MUST assert the thread belongs
// to the acting tenant BEFORE invoking the graph — the prefix is otherwise forgeable from outside.
export function threadBelongsToTenant(
  threadId: string,
  tenantId: bigint,
): boolean {
  // The same parse `parseThreadId` uses, so the fence and the reader cannot disagree about which
  // tenant a thread belongs to. Failing closed on a segment neither can read is the whole job.
  const prefix = parseDbId(threadId.split(":")[0]);
  return prefix !== null && prefix === tenantId;
}
