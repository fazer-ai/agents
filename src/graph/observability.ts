import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { CallbackHandler } from "@langfuse/langchain";
import {
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  startObservation,
} from "@langfuse/tracing";
import type { Span } from "@opentelemetry/api";
import { z } from "zod";
import logger from "@/api/lib/logger";
import config from "@/config";
import {
  drainLangfuseTracing,
  registerTurnTrace,
  startInTurnRoute,
  startInTurnTrace,
  type TurnTrace,
  traceIdForTurn,
} from "@/graph/langfuse-otel";
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

export {
  LANGFUSE_DELIVERY_RETRY,
  setLangfuseDeliveryRetryForTest,
} from "@/graph/langfuse-otel";

/**
 * Delivers every queued span of every tenant and forgets the destinations, so nothing is still owed
 * delivery afterwards. Delivery runs on a background batch timer through `globalThis.fetch`, so a
 * caller that builds handlers and then ends (a test file, a worker shutting down) has to settle them
 * rather than leave them to a timer that would POST through whatever `fetch` is installed by then.
 * Settled, never rejected: an unreachable Langfuse is a normal case and must not fail the caller.
 */
export async function shutdownLangfuseClients(): Promise<void> {
  await drainLangfuseTracing();
}

// djb2 over the config so a rotated secret or URL gets a fresh destination.
function configHash(cfg: LangfuseConfig): string {
  const s = `${cfg.publicKey}|${cfg.secretKey}|${cfg.baseUrl ?? ""}|${cfg.sendContent ? 1 : 0}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function turnTraceFor(
  cfg: LangfuseConfig,
  tenantId: bigint,
  turnId: string | undefined,
): TurnTrace {
  return registerTurnTrace(
    traceIdForTurn(turnId ?? crypto.randomUUID()),
    `${tenantId}:${configHash(cfg)}`,
    {
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
      sendContent: cfg.sendContent,
      tenantId,
    },
  );
}

/** Trace metadata carried on every span: identifiers only, each a short string. */
function traceIdMetadata(ctx: {
  tenantId: bigint;
  conversationId?: bigint | null;
  agentId?: bigint | null;
  turnId?: string;
  source?: UsageSource;
}): Record<string, string> {
  const out: Record<string, string> = { tenantId: String(ctx.tenantId) };
  if (ctx.conversationId != null)
    out.conversationId = String(ctx.conversationId);
  if (ctx.agentId != null) out.agentId = String(ctx.agentId);
  if (ctx.turnId) out.turnId = ctx.turnId;
  if (ctx.source) out.source = ctx.source;
  return out;
}

// The Langfuse environment for a turn: inbox traffic tracks the deployment tier (config.env); the
// playground and the client channel go to sibling `<tier>-playground` and `<tier>-client`
// environments, so the UI's environment selector (which filters Traces, Sessions AND Dashboards)
// separates them instead of relying on a sessionId prefix.
export function environmentForSource(source: UsageSource | undefined): string {
  return source === undefined || source === "inbox"
    ? config.env
    : `${config.env}-${source}`;
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
  // Lift this run's name/input/output onto the ROOT trace (default true; see buildLangfuseHandler).
  // A SECONDARY model call that shares the turn's trace id must pass false: with true it would
  // overwrite the root's IO with its own, so the trace list would show the speech normalizer's
  // rewrite where the turn's actual question and answer belong.
  updateRoot?: boolean;
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

// The handler's own span bookkeeping, which the turn wiring below hooks into. These members are not
// part of the SDK's typed surface, so the version is pinned in package.json and the tests in
// tests/graph/langfuse-otel-export.test.ts exercise every hook through a real run.
interface HandlerInternals {
  startAndRegisterOtelSpan(params: {
    runId: string;
    parentRunId?: string;
    runName: string;
    attributes?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): { id: string; otelSpan: Span };
  handleOtelSpanEnd(params: {
    runId: string;
    attributes?: Record<string, unknown>;
  }): void;
  traceAttributesMap: Map<string, unknown>;
  runMap: Map<string, { otelSpan: Span }>;
}

const TRACE_METADATA_PREFIX = `${LangfuseOtelSpanAttributes.TRACE_METADATA}.`;
const HANDLER_METADATA_KEYS = new Set([
  "langfusePrompt",
  "langfuseUserId",
  "langfuseSessionId",
]);

/** A run's LangChain metadata (provider, model type, graph node) lifted onto the trace's metadata. */
function liftRunMetadata(
  span: Span,
  metadata: Record<string, unknown> | undefined,
): void {
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (HANDLER_METADATA_KEYS.has(key) || value === undefined) continue;
    span.setAttribute(`${TRACE_METADATA_PREFIX}${key}`, JSON.stringify(value));
  }
}

/**
 * A per-invocation callback handler whose runs land in the turn's trace (identity rules in
 * docs/graph.md, Langfuse tracing). With `updateRoot` (the default) the top-level run is the trace's
 * root and carries its name and input/output; a secondary call (`updateRoot: false`) joins under that
 * root without touching them. Returns null on any failure, since tracing must never break a reply.
 */
export function buildLangfuseHandler(
  cfg: LangfuseConfig | null,
  ctx: TraceContext,
): BaseCallbackHandler | null {
  if (!cfg) return null;
  try {
    const turn = turnTraceFor(cfg, ctx.tenantId, ctx.turnId);
    const updateRoot = ctx.updateRoot ?? true;
    const rootAttributes = {
      userId: ctx.userId,
      sessionId: ctx.threadId || undefined,
      metadata: traceIdMetadata(ctx),
      environment: environmentForSource(ctx.source),
    };
    const handler = new CallbackHandler({
      userId: ctx.userId,
      sessionId: ctx.threadId || undefined,
    });
    const internals = handler as unknown as HandlerInternals;
    const start = internals.startAndRegisterOtelSpan.bind(handler);
    const end = internals.handleOtelSpanEnd.bind(handler);
    const rootRuns = new Set<string>();
    internals.startAndRegisterOtelSpan = (params) => {
      if (params.parentRunId) {
        const child = startInTurnRoute(turn, () => start(params));
        if (updateRoot) liftRunMetadata(child.otelSpan, params.metadata);
        return child;
      }
      internals.traceAttributesMap.set(params.runId, rootAttributes);
      const observation = startInTurnTrace(turn, updateRoot, () =>
        start(params),
      );
      if (updateRoot) {
        rootRuns.add(params.runId);
        const span = observation.otelSpan;
        liftRunMetadata(span, params.metadata);
        span.setAttribute(
          LangfuseOtelSpanAttributes.TRACE_NAME,
          params.runName,
        );
        const input = params.attributes?.input;
        if (input !== undefined) {
          span.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_INPUT,
            JSON.stringify(input),
          );
        }
        if (ctx.availableTools) {
          span.setAttribute(
            `${TRACE_METADATA_PREFIX}availableTools`,
            JSON.stringify(ctx.availableTools),
          );
        }
        if (ctx.availableToolSchemas) {
          span.setAttribute(
            `${TRACE_METADATA_PREFIX}availableToolSchemas`,
            JSON.stringify(ctx.availableToolSchemas),
          );
        }
      }
      return observation;
    };
    internals.handleOtelSpanEnd = (params) => {
      if (rootRuns.delete(params.runId)) {
        const output = params.attributes?.output;
        const span = internals.runMap.get(params.runId)?.otelSpan;
        if (span && output !== undefined) {
          span.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_OUTPUT,
            JSON.stringify(output),
          );
        }
      }
      end(params);
    };
    return handler as unknown as BaseCallbackHandler;
  } catch (err) {
    logger.warn(
      { err, threadId: ctx.threadId },
      "langfuse handler build failed",
    );
    return null;
  }
}

export interface DirectGenerationContext {
  tenantId: bigint;
  turnId: string;
  threadId?: string | null;
  conversationId?: bigint | null;
  agentId?: bigint | null;
  source?: UsageSource;
}

export interface DirectGeneration {
  // The ledger `node`, which is also the generation's name.
  name: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  // Discounted SUBSETS of promptTokens, never additive (same contract as `TokenUsage`).
  cachedReadTokens?: number;
  cacheCreationTokens?: number;
  at?: Date;
}

// A billed call no callback saw, written to Langfuse by hand: vision reaches its provider by raw
// fetch, so without this the turn's trace would miss the call. It joins the turn's trace like a
// secondary call, and `usageDetails` uses the LangChain handler's keys so one model definition prices
// both paths. Best-effort: never throws, and returns whether it queued anything so the caller can log
// a miss.
export function recordDirectGeneration(
  cfg: LangfuseConfig | null,
  ctx: DirectGenerationContext,
  gen: DirectGeneration,
): boolean {
  if (!cfg) return false;
  try {
    const turn = turnTraceFor(cfg, ctx.tenantId, ctx.turnId);
    const cachedRead = gen.cachedReadTokens ?? 0;
    const cacheCreation = gen.cacheCreationTokens ?? 0;
    const usageDetails: Record<string, number> = {
      input: Math.max(0, gen.promptTokens - cachedRead - cacheCreation),
      output: gen.completionTokens,
      total: gen.promptTokens + gen.completionTokens,
    };
    if (cachedRead > 0) usageDetails.input_cache_read = cachedRead;
    if (cacheCreation > 0) usageDetails.input_cache_creation = cacheCreation;
    const at = gen.at ?? new Date();
    propagateAttributes(
      {
        userId: cfg.tenantSlug,
        sessionId: ctx.threadId ?? undefined,
        metadata: traceIdMetadata(ctx),
        environment: environmentForSource(ctx.source),
      },
      () =>
        startInTurnTrace(turn, false, () =>
          startObservation(
            gen.name,
            {
              model: gen.model,
              usageDetails,
              metadata: { node: gen.name },
            },
            { asType: "generation", startTime: at },
          ),
        ).end(at),
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, turnId: ctx.turnId, node: gen.name },
      "langfuse direct generation failed",
    );
    return false;
  }
}
