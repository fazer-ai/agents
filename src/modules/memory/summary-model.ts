import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelConfig } from "@/graph/model-config";
import { resolveModelOverride } from "@/graph/model-override";
import { createChatModel, type ResolvedModelConfig } from "@/graph/models";
import type { AgentConfig } from "@/graph/prepare";

// The model a summary runs on: the memory compaction override when the agent has one, otherwise the
// agent's own model and credential. Shared by memory compaction and the summaries of the contact's
// conversations in other inboxes, so the two cannot disagree on which model or key a summary uses.
export type SummaryModel =
  | { ok: true; model: BaseChatModel; mc: ResolvedModelConfig }
  | { ok: false; error: string };

export function buildSummaryModel(
  cfg: Pick<
    AgentConfig,
    | "mc"
    | "apiKey"
    | "credentialBaseUrl"
    | "memoryCompactionOverride"
    | "memoryCompactionApiKey"
    | "memoryCompactionCredentialBaseUrl"
  >,
  // Names the summariser in the error, for the line the job dies with.
  label: string,
  makeModel: typeof createChatModel = createChatModel,
): SummaryModel {
  // Everything inherited from the agent comes back through the resolver BY NAME, never a spread of
  // `cfg.mc`, which would carry unknown fields (a credentialRef) across a provider switch.
  const resolved = resolveModelOverride(
    cfg.memoryCompactionOverride,
    {
      provider: cfg.mc.provider,
      model: cfg.mc.model,
      baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL,
    },
    { ownCredentialBaseURL: cfg.memoryCompactionCredentialBaseUrl },
  );
  if (!resolved.runnable) {
    return {
      ok: false,
      error: `${label} model not runnable: ${resolved.reason ?? "unknown"}`,
    };
  }
  // Its own credential did not resolve; the AGENT's key would be a silent substitution.
  if (resolved.credential === "own" && !cfg.memoryCompactionApiKey) {
    return { ok: false, error: `${label} model: credential_not_found` };
  }
  // Same VENDOR is not enough to carry the agent's sampling: `reasoningEffort` is picked for one model
  // id and turns into a /v1/responses call another model can refuse.
  const sameModel =
    resolved.provider === cfg.mc.provider && resolved.model === cfg.mc.model;
  const mc: ResolvedModelConfig = {
    provider: resolved.provider as ModelConfig["provider"],
    model: resolved.model,
    apiKey:
      resolved.credential === "own"
        ? cfg.memoryCompactionApiKey
        : resolved.credential === "agent"
          ? cfg.apiKey
          : "",
    baseURL: resolved.baseURL ?? undefined,
    ...(sameModel
      ? {
          temperature: cfg.mc.temperature,
          reasoningEffort: cfg.mc.reasoningEffort,
        }
      : {}),
  };
  // createChatModel throws synchronously on some configurations (openai-compatible with no base
  // URL); the override is separately editable, so the throw becomes a named failure.
  try {
    return { ok: true, model: makeModel(mc), mc };
  } catch (err) {
    return {
      ok: false,
      error: `${label} model could not be built: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
