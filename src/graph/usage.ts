import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { FlowContext } from "@/modules/flowlog/service";
import { emitOutbound } from "@/modules/webhooks/outbound/service";

// LLM usage capture AT THE SOURCE (not mirrored from Langfuse): a LangChain callback that
// writes one append-only `LlmUsage` row per model invocation, with token counts from the
// provider response. The tenant/agent/conversation are passed EXPLICITLY (never read from
// the ALS at runtime) and the write goes through a scoped tx so RLS pins the row. Capture
// is best-effort: it never throws into the reply path.

export type UsageSource = "inbox" | "playground";

// HOW A CALL NAMES THE MODEL THAT ANSWERED IT, when that is not the one the agent is configured with.
//
// The capture is built once per turn and holds the configured id, which is right for every call
// until a fallback provider takes one (issue #143). Nothing LangChain hands the handler settles it:
// measured, `invocation_params.model` carries the configured id on openai/anthropic/deepseek and is
// UNDEFINED on google, and `response_metadata.model_name` carries the vendor's dated snapshot
// (`gpt-5.4-mini-2026-03-17`), which would silently rewrite the value of every row already in the
// ledger and move the dashboard's per-model break-down with it.
//
// So the caller says. The graph node is the only thing that knows which of its two models it just
// invoked, and it says so in the CALL's own metadata — measured to merge with the turn's metadata
// and to reach the inherited handlers, unlike `callbacks`, which replaces them and would have cost
// the Langfuse trace.
export const USAGE_MODEL_METADATA_KEY = "fazerai_usage_model";

export interface UsageRow {
  tenantId: bigint;
  agentId: bigint | null;
  conversationId: bigint | null;
  // The DB Inbox.id this usage is attributed to (null in the playground / when unresolved).
  inboxId: bigint | null;
  threadId: string | null;
  model: string;
  node: string | null;
  // "inbox" (real customer traffic) | "playground" (operator test turns).
  source: UsageSource;
  promptTokens: number;
  completionTokens: number;
  // Cached-input accounting: a discounted SUBSET of promptTokens, never additive.
  cachedReadTokens: number;
  cacheCreationTokens: number;
}

export type UsagePersist = (row: UsageRow) => Promise<void>;

// Every `node` the ledger can carry, against the one question a reader asking about the AGENT has to
// settle first: did the agent take the turn this call was billed for?
//
// "There is a billed call on this conversation" is not that question, and the two came apart the
// moment the ledger got complete (#316). Vision runs on the incoming attachment BEFORE the
// bot-ownership gate decides anything, so an image sent into a conversation a human owns bills the
// tenant while the agent never speaks. Every other node is downstream of a turn that did run.
//
// The map is TOTAL on purpose, and the fence in tests/modules/billed-call-usage.test.ts keeps it
// that way: a node value missing from it is a red test, never a silent default. Defaulting to true
// inflates involvement exactly the way vision just did; defaulting to false deflates it as quietly.
export const USAGE_NODE_IS_AGENT_TURN: Readonly<Record<string, boolean>> =
  Object.freeze({
    agent: true,
    nudge: true,
    guardrail: true,
    tts_normalize: true,
    memory_compact: true,
    vision: false,
  });

// Consumed as an EXCLUSION, with `node: null` kept beside it: a row from before this column was
// always written is an agent turn, because the agent path was the only one in the ledger then. An
// inclusion list would drop those rows instead, and move every historical involvement number.
export const NON_AGENT_TURN_NODES: readonly string[] = Object.freeze(
  Object.entries(USAGE_NODE_IS_AGENT_TURN)
    .filter(([, isTurn]) => !isTurn)
    .map(([node]) => node),
);

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Default sink: a short scoped tx (no network) appending the row. tenant_id is re-pinned by the
// $extends override; passing it here keeps the intent explicit.
export function defaultUsagePersist(
  base: PrismaClient = basePrisma,
): UsagePersist {
  return async (row) => {
    await runScopedOn(base, sysCtx(row.tenantId), async (db) => {
      await db.llmUsage.create({
        data: {
          tenantId: row.tenantId,
          agentId: row.agentId ?? undefined,
          conversationId: row.conversationId ?? undefined,
          inboxId: row.inboxId ?? undefined,
          threadId: row.threadId ?? undefined,
          model: row.model,
          node: row.node ?? undefined,
          source: row.source,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          cachedReadTokens: row.cachedReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
        },
      });
      // Fleet event (the subscriber consolidates). Same scoped tx as the row; allowlisted
      // numerics/ids only. Best-effort for the domain — never break usage capture on a fan-out
      // failure (this whole persist is already wrapped in a try/catch by the caller).
      await emitOutbound(db, row.tenantId, "llm.usage", {
        agent_id: row.agentId != null ? String(row.agentId) : null,
        conversation_id:
          row.conversationId != null ? String(row.conversationId) : null,
        inbox_id: row.inboxId != null ? String(row.inboxId) : null,
        source: row.source,
        model: row.model,
        // NOTE: the call type ("agent", "nudge", "tts_normalize", …). A fleet subscriber that only
        // sums tokens now sees the same split the dashboard does, instead of one undifferentiated
        // total in which a secondary call looks like a second customer turn.
        node: row.node,
        prompt_tokens: row.promptTokens,
        completion_tokens: row.completionTokens,
        cached_read_tokens: row.cachedReadTokens,
        cache_creation_tokens: row.cacheCreationTokens,
      });
    });
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  // Cached input — a discounted SUBSET of promptTokens (never added on top): read-from-cache
  // (OpenAI/Anthropic/Google) and cache-write (Anthropic, premium).
  cachedReadTokens: number;
  cacheCreationTokens: number;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Pulls prompt/completion + cached token counts from an LLMResult across the provider shapes
// LangChain exposes: the normalized `usage_metadata` on the generation message (preferred —
// consistent across providers; carries `input_token_details.{cache_read,cache_creation}` in
// LangChain v1.x), then the OpenAI-style `llmOutput.tokenUsage`, then the Anthropic-style
// `llmOutput.usage`. Cached counts are best-effort across the legacy bags too.
//
// The question every branch here answers is not "did it carry a number" but "did it carry every
// counter the provider BILLED" (issue #334). Two of them used to answer no.
export function extractTokenUsage(output: LLMResult): TokenUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const gens of output.generations ?? []) {
    for (const gen of gens) {
      // biome-ignore lint/suspicious/noExplicitAny: generation message shape is provider-dependent.
      const meta = (gen as any).message?.usage_metadata;
      if (meta) {
        const input = num(meta.input_tokens);
        const generated = num(meta.output_tokens);
        promptTokens += input;
        // NOTE: the remainder of the provider's OWN total is generation the integration could not name,
        // and it is billed all the same. Gemini is the live case: `convertUsageMetadata` maps
        // `output_tokens` from `candidatesTokenCount` alone and reads `thoughtsTokenCount` nowhere,
        // so with thinking on (the default of the current generation) every turn recorded less
        // output than it cost. The API reference defines the total as prompt + thoughts +
        // candidates, so the gap IS the thinking, and `total_tokens` is the only trace of it that
        // survives into `usage_metadata`.
        //   Inert everywhere else by construction: OpenAI's total is prompt + completion exactly
        // (reasoning already inside completion), Anthropic's is summed upstream before it gets
        // here, and a response with no total at all leaves the term at zero.
        //   The premise that the gap is only thinking is fenced, not assumed: Gemini also folds
        // `toolUsePromptTokenCount` into the total, which is populated only by its BUILT-IN tools
        // (Search grounding, code execution, URL context). We enable none — client-side function
        // declarations are ordinary prompt tokens — and tests/graph/usage-provider-counts.test.ts
        // goes red the day one is turned on.
        completionTokens +=
          generated + Math.max(0, num(meta.total_tokens) - input - generated);
        const det = meta.input_token_details;
        if (det) {
          cachedReadTokens += num(det.cache_read);
          cacheCreationTokens += num(det.cache_creation);
        }
      }
    }
  }
  if (promptTokens > 0 || completionTokens > 0) {
    return {
      promptTokens,
      completionTokens,
      cachedReadTokens,
      cacheCreationTokens,
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: llmOutput is an untyped provider bag.
  const out = (output.llmOutput ?? {}) as any;
  const tu = out.tokenUsage ?? out.estimatedTokenUsage;
  if (tu && (tu.promptTokens != null || tu.completionTokens != null)) {
    return {
      promptTokens: num(tu.promptTokens),
      completionTokens: num(tu.completionTokens),
      // OpenAI raw exposes the cached subset under prompt_tokens_details.cached_tokens.
      cachedReadTokens: num(tu.promptTokensDetails?.cachedTokens),
      cacheCreationTokens: 0,
    };
  }
  const u = out.usage;
  if (u && (u.input_tokens != null || u.output_tokens != null)) {
    // NOTE: Anthropic raw exposes cache read/write as their own counters, and they are ADDITIVE
    // here. `input_tokens` is documented as the tokens that were NOT read from or used to create a
    // cache, so the billed input is the sum of the three. That is the opposite of what this row means by
    // `cachedReadTokens` (a discounted SUBSET of `promptTokens`), which is why the sum happens here
    // rather than at the reader — and it is what `ChatAnthropic` itself does in `buildUsageMetadata`
    // before handing over the normalized path above.
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreation = num(u.cache_creation_input_tokens);
    return {
      promptTokens: num(u.input_tokens) + cacheRead + cacheCreation,
      completionTokens: num(u.output_tokens),
      cachedReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
    };
  }
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

// The attribution a SECONDARY billed call inherits from the turn it belongs to. A turn's own call
// gets these from the loaded agent config; a call made beside it (the guardrail analysis, a vision
// extraction) holds a FlowContext and nothing else, and that context already carries exactly the
// five fields a row needs.
//
// Reading them from one place is what keeps the two apart from a third possibility, measured in
// #316 and the reason this exists: a billed call attributed to NOTHING, because the code that made
// it had no way to say where it came from and so wrote no row at all.
export function usageAttribution(flow: FlowContext): {
  tenantId: bigint;
  agentId: bigint | null;
  conversationId: bigint | null;
  inboxId: bigint | null;
  threadId: string | null;
  source: UsageSource;
  base?: PrismaClient;
} {
  return {
    tenantId: flow.tenantId,
    agentId: flow.agentId ?? null,
    conversationId: flow.conversationId ?? null,
    inboxId: flow.inboxId ?? null,
    threadId: flow.threadId ?? null,
    // FlowSource and UsageSource are the same two values ("inbox" | "playground") for the same
    // reason: a row and a log line about one call must not disagree about which traffic it was.
    source: flow.source,
    base: flow.base,
  };
}

// Records a billed call that did NOT go through LangChain, so no callback could have seen it: a
// provider reached by raw fetch (vision). Best-effort, like the callback path — a ledger write
// never breaks the call it is about.
export async function recordDirectUsage(
  flow: FlowContext,
  row: {
    model: string;
    node: string;
    promptTokens: number;
    completionTokens: number;
    cachedReadTokens?: number;
    cacheCreationTokens?: number;
  },
): Promise<void> {
  if (row.promptTokens === 0 && row.completionTokens === 0) return;
  const attr = usageAttribution(flow);
  try {
    await defaultUsagePersist(attr.base)({
      ...attr,
      model: row.model,
      node: row.node,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cachedReadTokens: row.cachedReadTokens ?? 0,
      cacheCreationTokens: row.cacheCreationTokens ?? 0,
    });
  } catch (err) {
    logger.warn({ err, node: row.node }, "usage: direct capture failed");
  }
}

export interface UsageCaptureParams {
  tenantId: bigint;
  agentId?: bigint | null;
  conversationId?: bigint | null;
  inboxId?: bigint | null;
  threadId?: string | null;
  model: string;
  node?: string | null;
  source?: UsageSource;
  persist?: UsagePersist;
  base?: PrismaClient;
}

export class UsageCapture extends BaseCallbackHandler {
  name = "fazerai-usage-capture";
  // Bias toward the handler being awaited so the row is durable before the turn returns.
  override awaitHandlers = true;

  private readonly tenantId: bigint;
  private readonly agentId: bigint | null;
  private readonly conversationId: bigint | null;
  private readonly inboxId: bigint | null;
  private readonly threadId: string | null;
  private readonly model: string;
  private readonly node: string | null;
  private readonly source: UsageSource;
  private readonly persist: UsagePersist;

  constructor(params: UsageCaptureParams) {
    super();
    this.tenantId = params.tenantId;
    this.agentId = params.agentId ?? null;
    this.conversationId = params.conversationId ?? null;
    this.inboxId = params.inboxId ?? null;
    this.threadId = params.threadId ?? null;
    this.model = params.model;
    this.node = params.node ?? null;
    this.source = params.source ?? "inbox";
    this.persist = params.persist ?? defaultUsagePersist(params.base);
  }

  // Which model each in-flight run is on, when the caller said. Keyed by runId rather than held as
  // one field because the two halves are separate callbacks: a field would be the last START to
  // fire, which on a turn whose primary failed and whose fallback answered is exactly the wrong one.
  // Bounded by the runs in flight on one turn, and erased by whichever of END / ERROR arrives.
  private readonly runModel = new Map<string, string>();

  override async handleLLMStart(
    _llm: unknown,
    _prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const named = metadata?.[USAGE_MODEL_METADATA_KEY];
    // PRESENT, not truthy. An empty name is what a model-less `openai-compatible` fallback is
    // called — the server picks, so there is no id to record, and `""` is exactly what this ledger
    // already stores for a PRIMARY pointed at such an endpoint (`cfg.mc.model`). Discarding it as
    // falsy sent the row to `this.model` instead, which is the primary's name: a call that never
    // reached that vendor, billed to it, in the one column this table has for saying who answered.
    if (typeof named === "string") this.runModel.set(runId, named);
  }

  override async handleLLMError(_err: unknown, runId: string): Promise<void> {
    this.runModel.delete(runId);
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const {
      promptTokens,
      completionTokens,
      cachedReadTokens,
      cacheCreationTokens,
    } = extractTokenUsage(output);
    const model = this.runModel.get(runId) ?? this.model;
    this.runModel.delete(runId);
    if (promptTokens === 0 && completionTokens === 0) return;
    try {
      await this.persist({
        tenantId: this.tenantId,
        agentId: this.agentId,
        conversationId: this.conversationId,
        inboxId: this.inboxId,
        threadId: this.threadId,
        model,
        node: this.node,
        source: this.source,
        promptTokens,
        completionTokens,
        cachedReadTokens,
        cacheCreationTokens,
      });
    } catch (err) {
      logger.warn({ err, threadId: this.threadId }, "llm usage capture failed");
    }
  }
}
