import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { CallbackHandler, Langfuse } from "langfuse-langchain";
import { z } from "zod";
import logger from "@/api/lib/logger";
import config from "@/config";
import type { UsageSource } from "@/graph/usage";
import type { ScopedDb } from "@/lib/tenancy";
import { readLangfuseSettings } from "@/modules/tenant-settings/service";
import { tryResolveVaultEntry } from "@/modules/vault/service";

// Per-tenant Langfuse tracing (config from the vault, NOT a global env — a global key would leak
// every tenant's traces). Privacy-by-default: unless the tenant opts into `sendContent`, a mask
// redacts all prompt/completion content before it leaves the process; trace structure, timings,
// and token usage still flow. Langfuse is for trace drill-down only — cost lives in LlmUsage,
// captured at the source. The handler attaches per-invocation; the Langfuse client is cached per
// tenant+config so its flush timer is not re-created every turn.

// The vault secret (kind `langfuse`) holds ONLY the key pair; the rest of the config (baseUrl,
// sendContent, enabled + the credential ref) lives in Tenant.settings.langfuse. environment is
// derived from config.env + the turn source (never per-tenant): real traffic uses the deployment
// tier, playground turns a `<tier>-playground` sibling (see environmentForSource).
export const langfuseKeysSchema = z.object({
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
});

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  // Opt-in to sending raw prompt/completion content. Default redacts it.
  sendContent?: boolean;
  // Debug mode: also attach the FULL tool schemas (the OpenAI tool definitions the model was given)
  // to the trace metadata. Off by default — the tool NAMES always travel; the schemas are heavy and
  // would bloat every trace. See buildToolTraceMetadata.
  debug?: boolean;
  // The tenant's slug, used as the Langfuse trace `userId` (human-readable + filterable in the
  // Langfuse UI). Resolved alongside the keys so the handler doesn't need a second DB read.
  tenantSlug?: string;
}

// Resolves the tenant's Langfuse config from its settings + the referenced key-pair secret
// (returns null when disabled/absent/invalid so tracing is simply off). Call inside the
// already-open scoped tx.
export async function resolveLangfuseConfig(
  db: ScopedDb,
  tenantId: bigint,
): Promise<LangfuseConfig | null> {
  const settings = await readLangfuseSettings(db, tenantId);
  if (!settings.enabled || !settings.credentialRef) return null;
  const entry = await tryResolveVaultEntry(db, settings.credentialRef);
  if (!entry) return null;
  const keys = langfuseKeysSchema.safeParse(entry.secret);
  if (!keys.success) return null;
  // The tenant's own row is readable under RLS (id = app.tenant_id). null-safe: a missing slug
  // just leaves userId unset on the trace.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });
  // NOTE: baseUrl lives on the vault entry; undefined means no URL was stored (legacy entries
  // created before baseUrl became required). The Langfuse SDK falls back to cloud.langfuse.com.
  return {
    publicKey: keys.data.publicKey,
    secretKey: keys.data.secretKey,
    baseUrl: entry.baseUrl ?? undefined,
    sendContent: settings.sendContent,
    debug: settings.debug,
    tenantSlug: tenant?.slug ?? undefined,
  };
}

const REDACTED = "[redacted by fazer.ai PII policy]";

// When content must not leave the process, replace every I/O payload with a marker. The trace
// keeps its shape (spans, timings, usage); only the text is gone.
export function makeMask(sendContent: boolean | undefined) {
  if (sendContent) return undefined;
  return () => REDACTED;
}

interface ClientHolder {
  clients: Map<string, Langfuse>;
}

const CACHE_KEY = Symbol.for("fazerai.langfuse.clients");

function clientCache(): Map<string, Langfuse> {
  const g = globalThis as unknown as Record<symbol, ClientHolder>;
  g[CACHE_KEY] ??= { clients: new Map() };
  return g[CACHE_KEY].clients;
}

// djb2 over the config so a rotated secret/url yields a fresh cache entry (old client is left to
// its flush timer and GC; not awaited). environment is NOT folded in here — it is appended to the
// cache key separately below, since it is a closed, low-cardinality set per tenant (one per source).
function configHash(cfg: LangfuseConfig): string {
  const s = `${cfg.publicKey}|${cfg.secretKey}|${cfg.baseUrl ?? ""}|${cfg.sendContent ? 1 : 0}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// The Langfuse SDK delivers on a background flush and SWALLOWS delivery failures: a failed ingestion
// POST is emitted as a "warning" event that has NO default listener (HTTP errors are at most
// console.error'd), so a broken/misconfigured Langfuse instance is indistinguishable from a healthy
// one on our side — traces simply never appear, with nothing in our logs. Route those events to our
// structured logger so an operator SEES "traces aren't landing" instead of guessing. Deduped per
// client (clients are cached per tenant+config) so a persistently-broken instance logs once per
// distinct message, not once per turn. `log` is injectable for tests.
const loggedDeliveryIssues = new WeakMap<object, Set<string>>();

export function attachLangfuseDeliveryLogging(
  client: { on(event: string, cb: (payload: unknown) => void): unknown },
  ctx: { tenantId: bigint; environment: string; baseUrl?: string },
  log: Pick<typeof logger, "warn"> = logger,
): void {
  const handle = (kind: "error" | "warning") => (payload: unknown) => {
    const message =
      payload instanceof Error ? payload.message : String(payload);
    const seen = loggedDeliveryIssues.get(client) ?? new Set<string>();
    loggedDeliveryIssues.set(client, seen);
    const dedupKey = `${kind}:${message}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    log.warn(
      {
        err: payload instanceof Error ? payload : undefined,
        langfuseEvent: kind,
        detail: message,
        tenantId: String(ctx.tenantId),
        environment: ctx.environment,
        baseUrl: ctx.baseUrl,
      },
      "langfuse trace delivery failed; traces will be missing — check the Langfuse instance (blob storage / credentials)",
    );
  };
  client.on("error", handle("error"));
  client.on("warning", handle("warning"));
}

// environment is pinned at the CLIENT level (constructor), NOT per-trace: with updateRoot:true the
// LangChain handler emits a trace-update that does NOT carry environment, so traceStateless would
// reinject the client default and the server's per-id merge would clobber a per-trace override.
// Pinning it on the client keeps create + update consistent. At most a couple of clients per tenant
// (one environment per UsageSource), so a separate cache entry per environment is cheap.
function getClient(
  tenantId: bigint,
  cfg: LangfuseConfig,
  environment: string,
): Langfuse {
  const cache = clientCache();
  const key = `${tenantId}:${configHash(cfg)}:${environment}`;
  let client = cache.get(key);
  if (!client) {
    client = new Langfuse({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
      mask: makeMask(cfg.sendContent),
      environment,
    });
    attachLangfuseDeliveryLogging(client, {
      tenantId,
      environment,
      baseUrl: cfg.baseUrl,
    });
    cache.set(key, client);
  }
  return client;
}

// The Langfuse environment for a turn: real traffic tracks the deployment tier (config.env); operator
// playground turns go to a sibling `<tier>-playground` environment so the UI's environment selector
// (which filters Traces, Sessions AND Dashboards) cleanly separates test traffic from real, instead
// of relying on the fragile `:playground` sessionId prefix.
export function environmentForSource(source: UsageSource | undefined): string {
  return source === "playground" ? `${config.env}-playground` : config.env;
}

export interface TraceContext {
  tenantId: bigint;
  threadId: string;
  conversationId?: bigint | null;
  agentId?: bigint | null;
  // The Langfuse `userId` (the tenant slug) — filterable in the Langfuse UI.
  userId?: string;
  // The per-turn id (same value as the ExecutionLog turnId), used as the Langfuse trace id so a
  // turn in our Logs page maps 1:1 to a trace in Langfuse.
  turnId?: string;
  // Real traffic ("inbox", default) vs operator playground turns. Maps to the Langfuse environment so
  // the UI can separate the two across traces/sessions/dashboards (see environmentForSource).
  source?: UsageSource;
  // The names of every tool bound to the model this turn (always sent — the LangChain handler only
  // surfaces tools that were CALLED, so without this the operator can't see the available set).
  availableTools?: string[];
  // The full OpenAI tool definitions (name + description + JSON-Schema params) — only set when the
  // tenant turns on Langfuse debug mode, since they are heavy.
  availableToolSchemas?: unknown[];
}

// Shapes the bound toolset for the trace metadata: names always, full schemas only in debug mode.
// `convertToOpenAITool` yields exactly what the model received ({ type, function: { name,
// description, parameters } }); a tool whose schema can't be serialized falls back to name+description
// so one exotic tool never drops the whole list (or breaks the turn).
export function buildToolTraceMetadata(
  tools: StructuredToolInterface[] | undefined,
  debug: boolean | undefined,
): { availableTools?: string[]; availableToolSchemas?: unknown[] } {
  if (!tools || tools.length === 0) return {};
  const availableTools = tools.map((t) => t.name);
  if (!debug) return { availableTools };
  const availableToolSchemas = tools.map((t) => {
    try {
      return convertToOpenAITool(t);
    } catch {
      return {
        type: "function",
        function: { name: t.name, description: t.description },
      };
    }
  });
  return { availableTools, availableToolSchemas };
}

// Builds a per-invocation callback handler bound to a cached client and a trace rooted on the
// conversation. Trace identity: id = turnId (1 trace per turn, correlates with ExecutionLog),
// sessionId = threadId (groups all turns of a conversation in Langfuse's Sessions view), userId =
// tenant slug. Returns null on any failure — tracing must never break a reply.
export function buildLangfuseHandler(
  cfg: LangfuseConfig | null,
  ctx: TraceContext,
): BaseCallbackHandler | null {
  if (!cfg) return null;
  try {
    const client = getClient(
      ctx.tenantId,
      cfg,
      environmentForSource(ctx.source),
    );
    const metadata = {
      tenantId: String(ctx.tenantId),
      conversationId:
        ctx.conversationId != null ? String(ctx.conversationId) : undefined,
      agentId: ctx.agentId != null ? String(ctx.agentId) : undefined,
      turnId: ctx.turnId,
      source: ctx.source,
      availableTools: ctx.availableTools,
      availableToolSchemas: ctx.availableToolSchemas,
    };
    const trace = client.trace({
      id: ctx.turnId,
      sessionId: ctx.threadId,
      userId: ctx.userId,
      metadata,
    });
    // updateRoot: true so the LangChain handler lifts the run's name / input / output onto the ROOT
    // trace (otherwise IO lives only deep in the nested generations and the trace-list top level shows
    // blank name/input/output). The trace was created with id/sessionId/userId/metadata above; the
    // handler's update events omit userId/sessionId (undefined → dropped on serialize), so Langfuse's
    // per-id merge keeps the values we set here. Passing `metadata` keeps our keys through the merge.
    // Content is still gated by the client `mask` (sendContent=false redacts the surfaced IO too).
    return new CallbackHandler({
      root: trace,
      updateRoot: true,
      metadata,
    }) as unknown as BaseCallbackHandler;
  } catch (err) {
    logger.warn(
      { err, threadId: ctx.threadId },
      "langfuse handler build failed",
    );
    return null;
  }
}
