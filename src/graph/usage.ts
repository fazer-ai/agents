import { AsyncLocalStorage } from "node:async_hooks";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  recordDirectGeneration,
  resolveLangfuseConfig,
} from "@/graph/observability";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  cachedPriceOverrides,
  type PriceOverridesBlock,
  readPriceOverrides,
} from "@/modules/pricing/overrides";
import { type PricedTokens, priceCall } from "@/modules/pricing/price";
import { reportedCostFromUsage } from "@/modules/pricing/reported";
import { announceUnpricedModel } from "@/modules/pricing/unpriced-alert";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";
import { emitOutbound } from "@/modules/webhooks/outbound/service";

// LLM usage capture AT THE SOURCE (not mirrored from Langfuse): a LangChain callback that
// writes one append-only `LlmUsage` row per model invocation, with token counts from the
// provider response. The tenant/agent/conversation are passed EXPLICITLY (never read from
// the ALS at runtime) and the write goes through a scoped tx so RLS pins the row. Capture
// is best-effort: it never throws into the reply path.

export type UsageSource = "inbox" | "playground";

// HOW A CALL NAMES THE MODEL THAT ANSWERED IT, when a fallback took the call instead of the configured
// model the capture holds. Nothing LangChain hands the handler settles it: `invocation_params.model`
// is undefined on google, and `response_metadata.model_name` is the vendor's dated snapshot, which
// would change the value existing ledger rows (and the dashboard's per-model split) group by. So the
// graph node, the only one that knows which model it invoked, puts it in the CALL's metadata, which
// merges with the turn's and reaches the inherited handlers (`callbacks` would replace them and lose
// the Langfuse trace).
export const USAGE_MODEL_METADATA_KEY = "fazerai_usage_model";
// The provider of that same model, beside it: the price table needs both, and a fallback can sit on
// another provider than the primary it replaced.
export const USAGE_PROVIDER_METADATA_KEY = "fazerai_usage_provider";

export interface UsageRow {
  tenantId: bigint;
  agentId: bigint | null;
  conversationId: bigint | null;
  // The DB Inbox.id this usage is attributed to (null in the playground / when unresolved).
  inboxId: bigint | null;
  threadId: string | null;
  // The turn this call belongs to, when its caller knows one: the id the ExecutionLog and the
  // Langfuse trace of that turn already carry.
  turnId: string | null;
  model: string;
  node: string | null;
  // "inbox" (real customer traffic) | "playground" (operator test turns).
  source: UsageSource;
  promptTokens: number;
  completionTokens: number;
  // Cached-input accounting: a discounted SUBSET of promptTokens, never additive.
  cachedReadTokens: number;
  cacheCreationTokens: number;
  // Of cacheCreationTokens, the writes made under the 1-hour TTL (priced at their own rate).
  cacheCreation1hTokens: number;
  // How long the call took, as the capture measured it. Null when nothing measured it.
  durationMs: number | null;
  // What the call cost in USD, from the price table or as the provider reported it. Null when
  // neither could price it.
  costUsd: number | null;
  // What priced it: the table (`litellm@<commit>`), the tenant's own price (`tenant-override@...`),
  // or the cost OpenRouter reported (`openrouter:reported`).
  priceTable: string;
}

export type UsagePersist = (row: UsageRow) => Promise<void>;

// WHAT ONE TURN SPENT, summed in process for the caller that shows it (the playground).
//
// The same numbers the ledger rows carry, from the same two places that write them (`UsageCapture`
// and `recordDirectUsage`), so a turn's line and the ledger cannot disagree about a call. A
// counter, never attribution: the tenant and thread a row is billed to still come in explicitly,
// and the async context only answers "is someone summing this turn?". Counted only when the row is
// on the thread being summed, so the live total and a reopened session's total (the ledger read by
// that thread) are the same sum.
export interface TurnUsage {
  calls: number;
  promptTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  // Of cacheCreationTokens, the 1-hour writes.
  cacheCreation1hTokens: number;
  completionTokens: number;
  // The calls by the step that made them, keyed by the ledger's `node`: the detail the screens
  // show, so "3 calls" says which three. A row with no node is the agent's.
  byNode: Record<string, number>;
  // USD over the calls the price table could price, and how many it could not. A total
  // with unpriced calls is a floor, and the screens say so rather than show it as the whole.
  costUsd: number;
  unpricedCalls: number;
  // Of the priced calls, how many a price table OLDER than the one in the tree priced. The popover
  // names the current table's date only when this is zero, since a reopened turn keeps the figure
  // its own table gave it.
  olderTablePricedCalls: number;
  // Of the priced calls, how many the tenant's own prices priced rather than the table, so the
  // popover can say where its figure came from.
  tenantPricedCalls: number;
  // And how many carry the cost OpenRouter reported for them.
  reportedPricedCalls: number;
}

export function emptyTurnUsage(): TurnUsage {
  return {
    calls: 0,
    promptTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    completionTokens: 0,
    byNode: {},
    costUsd: 0,
    unpricedCalls: 0,
    olderTablePricedCalls: 0,
    tenantPricedCalls: 0,
    reportedPricedCalls: 0,
  };
}

// The node a row is counted under on screen: a row with no node is the agent's, the same reading
// `NON_AGENT_TURN_NODES` gives it.
export function usageNode(node: string | null): string {
  return node ?? "agent";
}

// A summed `cost_usd` as the number the screens add up. The column is a Decimal so a sum of many
// sub-cent calls does not drift; a figure shown to four places loses nothing as a double.
export function usdOrNull(d: { toString(): string } | null): number | null {
  return d === null ? null : Number(d.toString());
}

// A row some price table priced, and not the table in the tree now.
export function isOlderTable(priceTable: string | null | undefined): boolean {
  return (
    typeof priceTable === "string" &&
    priceTable.startsWith("litellm@") &&
    priceTable !== PRICE_TABLE_VERSION
  );
}

// One ledger group (a `groupBy` bucket) added into a running usage, so every reader folds rows the
// same way.
export function addUsageGroup(
  into: TurnUsage,
  g: {
    node: string | null;
    calls: number;
    promptTokens: number | null;
    cachedReadTokens: number | null;
    cacheCreationTokens: number | null;
    cacheCreation1hTokens?: number | null;
    completionTokens: number | null;
    // The group's summed cost and how many of its rows carried one (`_count` of the column).
    costUsd: number | null;
    pricedCalls: number;
    // The table that priced the group's rows, when the reader groups by it.
    priceTable?: string | null;
  },
): void {
  into.calls += g.calls;
  into.promptTokens += g.promptTokens ?? 0;
  into.cachedReadTokens += g.cachedReadTokens ?? 0;
  into.cacheCreationTokens += g.cacheCreationTokens ?? 0;
  into.cacheCreation1hTokens += g.cacheCreation1hTokens ?? 0;
  into.completionTokens += g.completionTokens ?? 0;
  into.costUsd += g.costUsd ?? 0;
  into.unpricedCalls += g.calls - g.pricedCalls;
  if (isOlderTable(g.priceTable)) into.olderTablePricedCalls += g.pricedCalls;
  if (isTenantPrice(g.priceTable)) into.tenantPricedCalls += g.pricedCalls;
  if (g.priceTable === OPENROUTER_REPORTED_PRICE_TABLE)
    into.reportedPricedCalls += g.pricedCalls;
  const node = usageNode(g.node);
  into.byNode[node] = (into.byNode[node] ?? 0) + g.calls;
}

// How long the turn took and how much of that was spent waiting on a model. Kept beside the usage
// rather than in it: the ledger has no timing, so a reopened session's total could not carry it,
// and a number the live total has and the reopened one lacks would be two books.
export interface TurnTiming {
  // Wall time of the whole turn, as the server measured it.
  turnMs: number;
  // Summed over the calls counted in the usage: the rest of turnMs is everything else the turn did
  // (tools, retrieval, the checkpointer, the guardrail's own logic).
  modelMs: number;
}

const turnUsageSink = new AsyncLocalStorage<{
  threadId: string;
  usage: TurnUsage;
  modelMs: number;
}>();

// Nested sums on one thread share the outer counter and answer their own share of it: a file turn
// sums its inline file read AND the turn it then runs, and the turn alone is what the inner call
// reports. A new counter per level would hide the inner calls from the outer one.
export async function sumTurnUsage<T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<{ result: T; usage: TurnUsage; timing: TurnTiming }> {
  const startedAt = performance.now();
  const outer = turnUsageSink.getStore();
  if (outer && outer.threadId === threadId) {
    const before = { ...outer.usage, byNode: { ...outer.usage.byNode } };
    const modelBefore = outer.modelMs;
    const result = await fn();
    const after = outer.usage;
    return {
      result,
      timing: {
        turnMs: Math.round(performance.now() - startedAt),
        modelMs: Math.round(outer.modelMs - modelBefore),
      },
      usage: {
        calls: after.calls - before.calls,
        promptTokens: after.promptTokens - before.promptTokens,
        cachedReadTokens: after.cachedReadTokens - before.cachedReadTokens,
        cacheCreationTokens:
          after.cacheCreationTokens - before.cacheCreationTokens,
        cacheCreation1hTokens:
          after.cacheCreation1hTokens - before.cacheCreation1hTokens,
        completionTokens: after.completionTokens - before.completionTokens,
        costUsd: after.costUsd - before.costUsd,
        unpricedCalls: after.unpricedCalls - before.unpricedCalls,
        olderTablePricedCalls:
          after.olderTablePricedCalls - before.olderTablePricedCalls,
        tenantPricedCalls: after.tenantPricedCalls - before.tenantPricedCalls,
        reportedPricedCalls:
          after.reportedPricedCalls - before.reportedPricedCalls,
        byNode: Object.fromEntries(
          Object.entries(after.byNode)
            .map(([n, c]) => [n, c - (before.byNode[n] ?? 0)] as const)
            .filter(([, c]) => c > 0),
        ),
      },
    };
  }
  const sink = { threadId, usage: emptyTurnUsage(), modelMs: 0 };
  const result = await turnUsageSink.run(sink, fn);
  return {
    result,
    usage: sink.usage,
    timing: {
      turnMs: Math.round(performance.now() - startedAt),
      modelMs: Math.round(sink.modelMs),
    },
  };
}

function noteTurnUsage(row: UsageRow): void {
  const sink = turnUsageSink.getStore();
  if (!sink || row.threadId !== sink.threadId) return;
  if (row.durationMs !== null) sink.modelMs += row.durationMs;
  sink.usage.calls += 1;
  sink.usage.promptTokens += row.promptTokens;
  sink.usage.cachedReadTokens += row.cachedReadTokens;
  sink.usage.cacheCreationTokens += row.cacheCreationTokens;
  sink.usage.cacheCreation1hTokens += row.cacheCreation1hTokens;
  sink.usage.completionTokens += row.completionTokens;
  if (row.costUsd === null) sink.usage.unpricedCalls += 1;
  else {
    sink.usage.costUsd += row.costUsd;
    if (isTenantPrice(row.priceTable)) sink.usage.tenantPricedCalls += 1;
    if (row.priceTable === OPENROUTER_REPORTED_PRICE_TABLE)
      sink.usage.reportedPricedCalls += 1;
  }
  const node = usageNode(row.node);
  sink.usage.byNode[node] = (sink.usage.byNode[node] ?? 0) + 1;
}

// Every `node` the ledger can carry, against the question a reader asking about the AGENT settles
// first: did the agent take the turn this call was billed for? "A billed call on this conversation"
// is not that question: vision runs on the incoming attachment BEFORE the bot-ownership gate, so an
// image sent into a human-owned conversation bills the tenant while the agent never speaks. The map
// is TOTAL, fenced in tests/modules/billed-call-usage.test.ts: a default of true would inflate
// involvement, and a default of false would deflate it as quietly.
export const USAGE_NODE_IS_AGENT_TURN: Readonly<Record<string, boolean>> =
  Object.freeze({
    agent: true,
    nudge: true,
    guardrail: true,
    tts_normalize: true,
    memory_compact: true,
    vision: false,
    // The OBSERVE job classifying a conversation the agent watches: a model call on a
    // conversation nobody of ours answers, so it is involvement in nothing the agent said.
    observer: false,
    // The OBSERVE job on the `decisions` engine: a classification call (modules/decisions), same
    // conversation and same answer as `observer`.
    decision: false,
    // The SUGGESTION_REVIEW job judging a proposed knowledge entry: nothing the agent said.
    suggestion_review: false,
  });

// Consumed as an EXCLUSION, with `node: null` kept beside it: a row with no node is an agent turn,
// and an inclusion list would drop those rows and move every past involvement number.
export const NON_AGENT_TURN_NODES: readonly string[] = Object.freeze(
  Object.entries(USAGE_NODE_IS_AGENT_TURN)
    .filter(([, isTurn]) => !isTurn)
    .map(([node]) => node),
);

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function isTenantPrice(priceTable: string | null | undefined): boolean {
  return priceTable?.startsWith("tenant-override@") ?? false;
}

// The price of one call as this tenant pays it: its own price for the provider
// and model when it saved one, the table's otherwise. An unreadable settings row prices from the
// table and says so in the log; pricing never fails the capture it belongs to.
async function priceRow(
  tenantId: bigint,
  provider: string,
  model: string,
  tokens: PricedTokens,
  base: PrismaClient | undefined,
  reported: number | null = null,
): Promise<{ costUsd: number | null; priceTable: string }> {
  let overrides: PriceOverridesBlock | null = null;
  try {
    overrides = await cachedPriceOverrides(tenantId, () =>
      runScopedOn(base ?? basePrisma, sysCtx(tenantId), async (db) => {
        const t = await db.tenant.findUnique({
          where: { id: tenantId },
          select: { settings: true },
        });
        const settings = t?.settings;
        return readPriceOverrides(
          typeof settings === "object" && settings !== null
            ? (settings as Record<string, unknown>)
            : {},
        );
      }),
    );
  } catch (err) {
    logger.warn(
      { err, tenantId: String(tenantId) },
      "usage: tenant prices unreadable, pricing from the table",
    );
  }
  // The tenant's own price first, because it is what the account says it pays; then what
  // OpenRouter said it charged; then the table.
  const priced = priceCall(provider, model, tokens, new Date(), overrides);
  if (isTenantPrice(priced.priceTable) || reported === null) return priced;
  return { costUsd: reported, priceTable: OPENROUTER_REPORTED_PRICE_TABLE };
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
          turnId: row.turnId ?? undefined,
          model: row.model,
          node: row.node ?? undefined,
          source: row.source,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          cachedReadTokens: row.cachedReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          cacheCreation1hTokens: row.cacheCreation1hTokens,
          durationMs:
            row.durationMs === null ? undefined : Math.round(row.durationMs),
          costUsd: row.costUsd ?? undefined,
          priceTable: row.priceTable,
        },
      });
      // NOTE: Fleet event (the subscriber consolidates), in the same scoped tx as the row;
      // allowlisted numerics/ids only. A fan-out failure never breaks usage capture: the caller
      // wraps this whole persist in a try/catch.
      await emitOutbound(db, row.tenantId, "llm.usage", {
        agent_id: row.agentId != null ? String(row.agentId) : null,
        conversation_id:
          row.conversationId != null ? String(row.conversationId) : null,
        inbox_id: row.inboxId != null ? String(row.inboxId) : null,
        source: row.source,
        model: row.model,
        // NOTE: the call type ("agent", "nudge", "tts_normalize", …). A fleet subscriber that only
        // sums tokens sees the same split the dashboard does, so a secondary call does not look
        // like a second customer turn.
        node: row.node,
        prompt_tokens: row.promptTokens,
        completion_tokens: row.completionTokens,
        cached_read_tokens: row.cachedReadTokens,
        cache_creation_tokens: row.cacheCreationTokens,
        cache_creation_1h_tokens: row.cacheCreation1hTokens,
      });
    });
    if (row.costUsd === null) {
      await announceUnpricedModel({
        tenantId: row.tenantId,
        model: row.model,
        source: row.source,
        base,
      });
    }
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  // Cached input, a discounted SUBSET of promptTokens (never added on top): read-from-cache
  // (OpenAI/Anthropic/Google) and cache-write (Anthropic, premium).
  cachedReadTokens: number;
  cacheCreationTokens: number;
  // Of cacheCreationTokens, the writes under the 1-hour TTL (Anthropic's per-TTL split).
  cacheCreation1hTokens: number;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Pulls prompt/completion + cached token counts from an LLMResult across the provider shapes
// LangChain exposes: the normalized `usage_metadata` on the generation message (preferred, since it
// is consistent across providers and carries `input_token_details.{cache_read,cache_creation}`),
// then the OpenAI-style `llmOutput.tokenUsage`, then the Anthropic-style `llmOutput.usage`. Every
// branch must count every counter the provider BILLED, not merely some number.
export function extractTokenUsage(output: LLMResult): TokenUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedReadTokens = 0;
  let cacheCreationTokens = 0;
  let cacheCreation1hTokens = 0;
  for (const gens of output.generations ?? []) {
    for (const gen of gens) {
      // biome-ignore lint/suspicious/noExplicitAny: generation message shape is provider-dependent.
      const meta = (gen as any).message?.usage_metadata;
      if (meta) {
        const input = num(meta.input_tokens);
        const generated = num(meta.output_tokens);
        promptTokens += input;
        // NOTE: The remainder of the provider's OWN total is billed generation the integration
        // could not name. Gemini's `output_tokens` comes from `candidatesTokenCount` alone, and its
        // total is prompt + thoughts + candidates, so the gap IS the thinking. Inert elsewhere:
        // OpenAI's total is prompt + completion, Anthropic's is summed upstream, no total is zero.
        // Gemini also folds `toolUsePromptTokenCount` (its BUILT-IN tools only; our function
        // declarations are ordinary prompt tokens) into the total; we enable none, and
        // tests/graph/usage-provider-counts.test.ts goes red if one is turned on.
        completionTokens +=
          generated + Math.max(0, num(meta.total_tokens) - input - generated);
        const det = meta.input_token_details;
        if (det) {
          cachedReadTokens += num(det.cache_read);
          // `cache_creation_1h` is the 1-hour share `splitOneHourWrites` moves out of
          // `cache_creation`, so the two add up to the call's writes.
          cacheCreationTokens +=
            num(det.cache_creation) + num(det.cache_creation_1h);
          cacheCreation1hTokens += num(det.cache_creation_1h);
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
      cacheCreation1hTokens: Math.min(
        cacheCreation1hTokens,
        cacheCreationTokens,
      ),
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: llmOutput is an untyped provider bag.
  const out = (output.llmOutput ?? {}) as any;
  const tu = out.tokenUsage ?? out.estimatedTokenUsage;
  if (tu && (tu.promptTokens != null || tu.completionTokens != null)) {
    return {
      promptTokens: num(tu.promptTokens),
      completionTokens: num(tu.completionTokens),
      // NOTE: OpenAI raw exposes the cached subset under prompt_tokens_details.cached_tokens.
      cachedReadTokens: num(tu.promptTokensDetails?.cachedTokens),
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
    };
  }
  const u = out.usage;
  if (u && (u.input_tokens != null || u.output_tokens != null)) {
    // Anthropic raw exposes cache read/write as their own counters, and they are ADDITIVE
    // here. `input_tokens` is documented as the tokens that were NOT read from or used to create a
    // cache, so the billed input is the sum of the three. That is the opposite of what this row means by
    // `cachedReadTokens` (a discounted SUBSET of `promptTokens`), which is why the sum happens here
    // rather than at the reader, and it is what `ChatAnthropic` itself does in `buildUsageMetadata`
    // before handing over the normalized path above.
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreation = num(u.cache_creation_input_tokens);
    return {
      promptTokens: num(u.input_tokens) + cacheRead + cacheCreation,
      completionTokens: num(u.output_tokens),
      cachedReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      cacheCreation1hTokens: Math.min(anthropicOneHourWrites(u), cacheCreation),
    };
  }
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
  };
}

// Anthropic's `usage.cache_creation.ephemeral_1h_input_tokens`: the writes made under the 1-hour TTL,
// a subset of `cache_creation_input_tokens`. Zero for any other shape.
function anthropicOneHourWrites(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const split = (usage as { cache_creation?: unknown }).cache_creation;
  if (!split || typeof split !== "object") return 0;
  return num(
    (split as { ephemeral_1h_input_tokens?: unknown })
      .ephemeral_1h_input_tokens,
  );
}

// The `price_table` of a row whose cost OpenRouter itself reported.
export const OPENROUTER_REPORTED_PRICE_TABLE = "openrouter:reported";

// WHAT OPENROUTER SAID THE CALL COST, when it can stand for the whole charge. OpenRouter returns
// `usage.cost` (credits, whose base currency is USD) on every chat completion without being asked,
// and `ChatOpenAI` copies the raw `usage` into `response_metadata.usage`, on the non-streamed path
// and on the streamed one's final chunk alike. When the figure cannot stand is decided by
// `reportedCostFromUsage` (src/modules/pricing/reported.ts), shared with the image reader.
export function reportedCostUsd(
  provider: string,
  output: LLMResult,
): number | null {
  if (provider !== "openrouter") return null;
  for (const gens of output.generations ?? []) {
    for (const gen of gens) {
      // biome-ignore lint/suspicious/noExplicitAny: response_metadata is a provider bag.
      const usage = (gen as any).message?.response_metadata?.usage;
      const cost = reportedCostFromUsage(provider, usage);
      if (cost === undefined) continue;
      // NOTE: the first generation carrying it answers for the call. With `n > 1` every choice
      // carries the same response-level `usage`, so a sum would bill the call once per choice.
      return cost;
    }
  }
  return null;
}

// The attribution a SECONDARY billed call inherits from the turn it belongs to. A turn's own call
// gets these from the loaded agent config; a call made beside it (the guardrail analysis, a vision
// extraction) holds only a FlowContext, which carries exactly the fields a row needs. One reader
// means no billed call is left with no way to say where it came from, and so no row at all.
export function usageAttribution(flow: FlowContext): {
  tenantId: bigint;
  agentId: bigint | null;
  conversationId: bigint | null;
  inboxId: bigint | null;
  threadId: string | null;
  turnId: string | null;
  source: UsageSource;
  base?: PrismaClient;
} {
  return {
    tenantId: flow.tenantId,
    agentId: flow.agentId ?? null,
    conversationId: flow.conversationId ?? null,
    inboxId: flow.inboxId ?? null,
    threadId: flow.threadId ?? null,
    turnId: flow.turnId ?? null,
    // NOTE: FlowSource and UsageSource are the same two values ("inbox" | "playground") for the same
    // reason: a row and a log line about one call must not disagree about which traffic it was.
    source: flow.source,
    base: flow.base,
  };
}

// Records a billed call that did NOT go through LangChain, so no callback could have seen it: a
// provider reached by raw fetch (vision). Best-effort: a ledger write never breaks its call. It
// writes the ledger row, which every cost figure reads, and a Langfuse generation
// (`recordDirectGeneration`) so the call shows up in the turn's trace like any other. The tenant's
// Langfuse is resolved here rather than carried in the `FlowContext`, so no call site has to thread
// a credential. A tenant with no Langfuse keeps the row and skips the trace, as on the turn path.
export async function recordDirectUsage(
  flow: FlowContext,
  row: {
    provider: string;
    model: string;
    node: string;
    promptTokens: number;
    completionTokens: number;
    cachedReadTokens?: number;
    cacheCreationTokens?: number;
    // How long the caller waited on the provider, retries included, when it measured it.
    durationMs?: number;
    // What the provider said the call cost, when it did.
    reportedCostUsd?: number | null;
  },
): Promise<void> {
  if (row.promptTokens === 0 && row.completionTokens === 0) return;
  const attr = usageAttribution(flow);
  const usageRow: UsageRow = {
    ...attr,
    model: row.model,
    node: row.node,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cachedReadTokens: row.cachedReadTokens ?? 0,
    cacheCreationTokens: row.cacheCreationTokens ?? 0,
    // A direct call carries no cache mark, so it never writes under the 1-hour TTL.
    cacheCreation1hTokens: 0,
    durationMs: row.durationMs ?? null,
    ...(await priceRow(
      attr.tenantId,
      row.provider,
      row.model,
      {
        promptTokens: row.promptTokens,
        cachedReadTokens: row.cachedReadTokens ?? 0,
        cacheCreationTokens: row.cacheCreationTokens ?? 0,
        completionTokens: row.completionTokens,
      },
      attr.base,
      row.reportedCostUsd ?? null,
    )),
  };
  noteTurnUsage(usageRow);
  try {
    await defaultUsagePersist(attr.base)(usageRow);
  } catch (err) {
    logger.warn({ err, node: row.node }, "usage: direct capture failed");
  }
  try {
    const cfg = await runScopedOn(
      attr.base ?? basePrisma,
      sysCtx(attr.tenantId),
      (db) => resolveLangfuseConfig(db, attr.tenantId),
    );
    recordDirectGeneration(
      cfg,
      {
        tenantId: attr.tenantId,
        turnId: flow.turnId,
        threadId: attr.threadId,
        conversationId: attr.conversationId,
        agentId: attr.agentId,
        source: attr.source,
      },
      {
        name: row.node,
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        cachedReadTokens: row.cachedReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
      },
    );
  } catch (err) {
    logger.warn({ err, node: row.node }, "usage: direct trace failed");
  }
}

export interface UsageCaptureParams {
  tenantId: bigint;
  agentId?: bigint | null;
  conversationId?: bigint | null;
  inboxId?: bigint | null;
  threadId?: string | null;
  turnId?: string | null;
  // The provider of `model`, for its price.
  provider: string;
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
  private readonly turnId: string | null;
  private readonly provider: string;
  private readonly model: string;
  private readonly node: string | null;
  private readonly source: UsageSource;
  private readonly persist: UsagePersist;
  private readonly base: PrismaClient | undefined;

  constructor(params: UsageCaptureParams) {
    super();
    this.tenantId = params.tenantId;
    this.agentId = params.agentId ?? null;
    this.conversationId = params.conversationId ?? null;
    this.inboxId = params.inboxId ?? null;
    this.threadId = params.threadId ?? null;
    this.turnId = params.turnId ?? null;
    this.provider = params.provider;
    this.model = params.model;
    this.node = params.node ?? null;
    this.source = params.source ?? "inbox";
    this.persist = params.persist ?? defaultUsagePersist(params.base);
    this.base = params.base;
  }

  // Which model each in-flight run is on, when the caller said. Keyed by runId rather than held as
  // one field because the two halves are separate callbacks: a field would be the last START to
  // fire, which on a turn whose primary failed and whose fallback answered is exactly the wrong one.
  // Bounded by the runs in flight on one turn, and erased by whichever of END / ERROR arrives.
  private readonly runModel = new Map<string, string>();
  private readonly runProvider = new Map<string, string>();
  // When each in-flight run started, for the turn's model time. Same lifetime as runModel.
  private readonly runStart = new Map<string, number>();

  override async handleLLMStart(
    _llm: unknown,
    _prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.runStart.set(runId, performance.now());
    const named = metadata?.[USAGE_MODEL_METADATA_KEY];
    // NOTE: PRESENT, not truthy. A model-less `openai-compatible` fallback is named `""` (the
    // server picks), as the ledger stores for such a PRIMARY (`cfg.mc.model`); dropping it as falsy
    // would bill the row to `this.model`, the primary's name, a vendor that call never reached.
    if (typeof named === "string") this.runModel.set(runId, named);
    const namedProvider = metadata?.[USAGE_PROVIDER_METADATA_KEY];
    if (typeof namedProvider === "string")
      this.runProvider.set(runId, namedProvider);
  }

  override async handleLLMError(_err: unknown, runId: string): Promise<void> {
    this.runModel.delete(runId);
    this.runProvider.delete(runId);
    this.runStart.delete(runId);
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const {
      promptTokens,
      completionTokens,
      cachedReadTokens,
      cacheCreationTokens,
      cacheCreation1hTokens,
    } = extractTokenUsage(output);
    // The pair, never one half: a named model is priced as its own provider's or not at all.
    const named = this.runModel.get(runId);
    const model = named ?? this.model;
    const provider =
      named === undefined ? this.provider : (this.runProvider.get(runId) ?? "");
    this.runModel.delete(runId);
    this.runProvider.delete(runId);
    const started = this.runStart.get(runId);
    this.runStart.delete(runId);
    const durationMs =
      started === undefined ? null : performance.now() - started;
    if (promptTokens === 0 && completionTokens === 0) return;
    const reported = reportedCostUsd(provider, output);
    const row: UsageRow = {
      tenantId: this.tenantId,
      agentId: this.agentId,
      conversationId: this.conversationId,
      inboxId: this.inboxId,
      threadId: this.threadId,
      turnId: this.turnId,
      model,
      node: this.node,
      source: this.source,
      promptTokens,
      completionTokens,
      cachedReadTokens,
      cacheCreationTokens,
      cacheCreation1hTokens,
      durationMs,
      ...(await priceRow(
        this.tenantId,
        provider,
        model,
        {
          promptTokens,
          cachedReadTokens,
          cacheCreationTokens,
          cacheCreation1hTokens,
          completionTokens,
        },
        this.base,
        reported,
      )),
    };
    noteTurnUsage(row);
    try {
      await this.persist(row);
    } catch (err) {
      logger.warn({ err, threadId: this.threadId }, "llm usage capture failed");
    }
  }
}
