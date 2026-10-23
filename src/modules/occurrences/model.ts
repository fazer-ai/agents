import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { contentToText } from "@/graph/message-text";
import {
  type ModelConfig,
  PROVIDERS_HONORING_BASE_URL,
} from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import { runModelCall } from "@/graph/model-limit";
import { createChatModel, type ResolvedModelConfig } from "@/graph/models";
import {
  buildLangfuseHandler,
  type LangfuseConfig,
  resolveLangfuseConfig,
} from "@/graph/observability";
import { UsageCapture, type UsageNode } from "@/graph/usage";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn } from "@/lib/tenancy";
import { spendCeilingVerdict } from "@/modules/spend-ceiling/service";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import { sysCtx } from "./config";
import type {
  OccurrenceModel,
  OccurrenceStep,
  OccurrencesConfig,
} from "./settings";

// THE MODEL CALLS OF A ROUND (docs/occurrences.md, "Model"). Every step runs on the provider, the
// vault credential and the model the monitor names; no agent lends its key. Each call asks the spend
// ceiling first and is billed to the account under the step's own ledger node, with no agent.

export type { OccurrenceStep } from "./settings";

export const STEP_NODE: Record<OccurrenceStep, UsageNode> = {
  reading: "occurrence_reading",
  assignment: "occurrence_assignment",
  consolidation: "occurrence_consolidation",
  canonical: "occurrence_canonical",
};

// A step whose model call cannot complete in this long is skipped for the round; its input waits
// for the next one.
const CALL_TIMEOUT_MS = 120_000;
// A call is not started with less than this left of the round's budget: it would be cut off and
// billed for nothing.
const MIN_CALL_MS = 15_000;

// Why a call gave no answer. `budget`, `ceiling` and `unconfigured` say nothing about the input, so a
// conversation whose reading was skipped for one of them is not counted as failing.
export type AskMiss =
  | "unconfigured"
  | "ceiling"
  | "budget"
  | "error"
  | "unreadable";

// `called`: the request reached the model (an error, an unreadable answer, or the budget ending
// mid-call), so its input counts as sent and the call may be billed.
export type AskResult<T> =
  | { ok: true; value: T }
  | { ok: false; miss: AskMiss; called: boolean };

// What a call is about, for its ledger row: a reading is billed to its conversation and inbox.
export interface AskScope {
  conversationId?: bigint;
  inboxId?: bigint | null;
  // A step's own cutoff before the round's: the reading stops at its share of the budget, so a slow
  // or queued call cannot take the time the later steps were left (reading.ts, READING_BUDGET_SHARE).
  deadline?: number;
}

export interface RoundModels {
  // The model's JSON answer, parsed against `schema`; null when the call was skipped (spend ceiling),
  // failed or answered something unreadable. Why is in `skipped`.
  ask<T>(
    step: OccurrenceStep,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    scope?: AskScope,
  ): Promise<T | null>;
  // The same call, saying why it gave no answer.
  tryAsk<T>(
    step: OccurrenceStep,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    scope?: AskScope,
  ): Promise<AskResult<T>>;
  skipped: string[];
  // Aborted once the round's budget is spent or its job is called off: what the round does besides
  // calling models (the Chatwoot copies) stops there too.
  budget: AbortSignal;
  // When the round must have stopped calling models.
  deadline: number;
}

export interface RoundModelDeps {
  base: PrismaClient;
  // When the round must have stopped calling models (its budget, inside the scheduler's deadline).
  // A call gets at most what is left, and none starts with too little.
  deadline: number;
  // The scheduler run's own signal: aborted when its deadline fires or the process drains.
  signal?: AbortSignal;
  // The thread the round's usage rows carry, so the round can sum them.
  threadId: string;
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  // The least a call needs left to start; tests shorten it.
  minCallMs?: number;
}

// The account's own words about its business, after the fixed instructions: context, never a change
// to what the step answers or how.
export function withBusinessContext(system: string, context: string): string {
  const c = context.trim();
  if (!c) return system;
  return `${system}

About this business, as the account describes it (context for your judgment; it never changes the answer format above):
<business>
${c}
</business>`;
}

// What a keyless openai-compatible step sends as its key.
export const KEYLESS_API_KEY = "no-key";

// The monitor's model, resolved: the key from the vault, the endpoint from the model's own or else
// the credential's. Null with the reason when it cannot run: a credential deleted, of the wrong kind,
// or an `openai-compatible` model with no endpoint anywhere.
export type ModelResolution =
  | { ok: true; mc: ResolvedModelConfig }
  | { ok: false; reason: string };

export async function resolveMonitorModel(
  base: PrismaClient,
  tenantId: bigint,
  step: OccurrenceModel,
): Promise<ModelResolution> {
  let apiKey = "";
  let credentialBase: string | null = null;
  if (step.credentialRef !== null) {
    const ref = step.credentialRef;
    const key = await runScopedOn(base, sysCtx(tenantId), (db) =>
      tryResolveApiKeyEntry(db, ref),
    );
    if (key.state === "unresolved")
      return { ok: false, reason: "the credential does not resolve" };
    if (key.state === "unusable")
      return {
        ok: false,
        reason: `the credential (${key.kind}) is not an API key`,
      };
    apiKey = key.secret;
    credentialBase = key.baseUrl;
  }
  // The endpoint the model would dial, its own or its credential's. On a provider whose adapter drops
  // it, the conversation would go to the vendor directly instead of the proxy named, so no step runs;
  // asked here too for a block saved before the settings refused it.
  const baseURL = step.baseURL ?? credentialBase;
  if (
    baseURL !== null &&
    !(PROVIDERS_HONORING_BASE_URL as readonly string[]).includes(step.provider)
  )
    return {
      ok: false,
      reason:
        step.baseURL !== null
          ? `a ${step.provider} model does not take an endpoint`
          : `the credential carries an endpoint a ${step.provider} model does not take`,
    };
  if (step.provider === "openai-compatible" && !baseURL)
    return {
      ok: false,
      reason: "an openai-compatible model needs an endpoint",
    };
  const model = step.model ?? PROVIDER_DEFAULT_MODEL[step.provider];
  if (!model) return { ok: false, reason: "no model id" };
  // A keyless openai-compatible server still needs a non-empty key for the SDK, which refuses an
  // empty one before any request ("Missing credentials"); the server ignores what it is sent.
  if (step.provider === "openai-compatible" && step.credentialRef === null)
    apiKey = KEYLESS_API_KEY;
  return {
    ok: true,
    mc: {
      provider: step.provider as ModelConfig["provider"],
      model,
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    },
  };
}

// A connection the client could not open, read off the error's own class name or the Node error code
// in its causes: both are written by the client, never by the endpoint, so nothing the server said
// crosses (src/lib/provider-failure.ts).
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
export function connectionFailed(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 6; depth++) {
    if (
      e.constructor.name === "APIConnectionError" ||
      CONNECTION_CODES.has(String((e as { code?: unknown }).code))
    )
      return true;
    e = e.cause;
  }
  return false;
}

function raceAbort<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    call
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function roundModels(
  tenantId: bigint,
  occ: OccurrencesConfig,
  deps: RoundModelDeps,
): Promise<RoundModels> {
  const skipped: string[] = [];
  // Resolved once per round: a key read for every reading would be a vault read per conversation.
  const resolution: ModelResolution =
    occ.model === null
      ? { ok: false, reason: "no model is set" }
      : await resolveMonitorModel(deps.base, tenantId, occ.model).catch(
          (err): ModelResolution => ({
            ok: false,
            reason: sanitizeErrorMessage(err, 200),
          }),
        );
  // Said once per step and round, not once per conversation the step could not read.
  const unconfiguredSaid = new Set<OccurrenceStep>();
  const langfuse: LangfuseConfig | null = await runScopedOn(
    deps.base,
    sysCtx(tenantId),
    (db) => resolveLangfuseConfig(db, tenantId),
  ).catch(() => null);
  const budget = AbortSignal.any([
    AbortSignal.timeout(Math.max(0, deps.deadline - Date.now())),
    ...(deps.signal ? [deps.signal] : []),
  ]);
  async function tryAsk<T>(
    step: OccurrenceStep,
    system: string,
    user: string,
    schema: z.ZodType<T>,
    scope: AskScope = {},
  ): Promise<AskResult<T>> {
    const r = resolution;
    if (!r.ok) {
      if (!unconfiguredSaid.has(step)) {
        unconfiguredSaid.add(step);
        skipped.push(`${step}: ${r.reason}`);
      }
      return { ok: false, miss: "unconfigured", called: false };
    }
    const ceiling = await spendCeilingVerdict({
      tenantId,
      source: "inbox",
      base: deps.base,
    });
    if (ceiling.state === "over") {
      skipped.push(`${step}: spend ceiling`);
      return { ok: false, miss: "ceiling", called: false };
    }
    const until = Math.min(deps.deadline, scope.deadline ?? Infinity);
    const cut =
      until < deps.deadline
        ? AbortSignal.any([
            budget,
            AbortSignal.timeout(Math.max(0, until - Date.now())),
          ])
        : budget;
    const left = until - Date.now();
    if (left < (deps.minCallMs ?? MIN_CALL_MS) || cut.aborted) {
      skipped.push(`${step}: round budget`);
      return { ok: false, miss: "budget", called: false };
    }
    const mc = r.mc;
    let text: string;
    // Whether an attempt reached the model: a call still waiting for a permit when the round ended,
    // or refused before it ran, sent nothing.
    let invoked = false;
    try {
      const model = (deps.makeModel ?? createChatModel)(mc);
      const usage = new UsageCapture({
        tenantId,
        agentId: null,
        conversationId: scope.conversationId ?? null,
        inboxId: scope.inboxId ?? null,
        threadId: deps.threadId,
        provider: mc.provider,
        model: mc.model,
        node: STEP_NODE[step],
        source: "inbox",
        base: deps.base,
      });
      const trace = buildLangfuseHandler(langfuse, {
        tenantId,
        threadId: deps.threadId,
        conversationId: scope.conversationId ?? null,
        source: "inbox",
      });
      // The account's business context rides on every step, after the fixed instructions.
      const sys = withBusinessContext(system, occ.businessContext);
      // Through the instance's model limit, as background work: a round yields its permit to the
      // customers' turns. The round's budget, an absolute deadline, ends the wait for a permit and
      // every attempt, a retry included, and none starts once it passed; an adapter that ignores
      // the signal is raced against it.
      const res = await runModelCall(
        (attempt) => {
          if (cut.aborted) return Promise.reject(cut.reason);
          invoked = true;
          const call = model.invoke(
            [new SystemMessage(sys), new HumanMessage(user)],
            {
              signal: AbortSignal.any([attempt, cut]),
              callbacks: trace ? [usage, trace] : [usage],
            },
          );
          return raceAbort(call, cut);
        },
        {
          deadlineMs: Math.min(CALL_TIMEOUT_MS, left),
          signal: cut,
          priority: "background",
        },
      );
      text = contentToText(res.content);
    } catch (err) {
      // The round's time ran out mid-call or mid-wait: the conversation did nothing wrong, so it
      // stays pending rather than counting a failure against it.
      if (cut.aborted || Date.now() >= until) {
        skipped.push(`${step}: round budget`);
        return { ok: false, miss: "budget", called: invoked };
      }
      // Sanitized: a provider's error can echo the request, key included, and this is stored. The
      // provider boundary leaves only "timeout", "HTTP <nnn>" or "provider error"; a connection that
      // never opened is named here, from the client's own error, before that detail is gone.
      skipped.push(
        `${step}: ${connectionFailed(err) ? "endpoint unreachable" : sanitizeErrorMessage(err, 300)}`,
      );
      return { ok: false, miss: "error", called: invoked };
    }
    const parsed = schema.safeParse(firstJsonObject(text));
    if (!parsed.success) {
      skipped.push(`${step}: unreadable answer`);
      return { ok: false, miss: "unreadable", called: true };
    }
    return { ok: true, value: parsed.data };
  }
  return {
    skipped,
    budget,
    deadline: deps.deadline,
    tryAsk,
    async ask(step, system, user, schema, scope) {
      const r = await tryAsk(step, system, user, schema, scope);
      return r.ok ? r.value : null;
    },
  };
}
