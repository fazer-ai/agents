import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { stashMediaAnnotation } from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { cleanTranscription } from "@/modules/chatwoot/render";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { getSttProvider } from "./providers";
import { readSttConfig, type SttConfig } from "./settings";

// Speech-to-text orchestration: download the voice note, transcribe via the configured provider
// (key from the vault), and write the transcription back onto the Chatwoot attachment meta so the
// debounce re-fetch reads it (and human agents see it too). The meta write-back is a FORK route —
// on upstream Chatwoot it 404s, so every completed transcription is also stashed in the in-process
// annotation store (chatwoot/annotations.ts) that the flush overlays (issue #49). We never store
// the transcription in our own DB — Chatwoot already holds the conversation, consistent with the
// anti-PII no-body-mirror rule. All network I/O is outside transactions; deps are injectable.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type MakeClient = (
  cfg: ConstructorParameters<typeof ChatwootClient>[0],
) => Promise<ChatwootClient>;

// Resolves the STT config for the inbox's agent. Returns null when unbound, disabled, or STT off —
// the caller then leaves audio untranscribed (rendered as a "send text" marker).
export async function resolveSttConfig(
  tenantId: bigint,
  instanceId: bigint,
  chatwootInboxId: number,
  base: PrismaClient = basePrisma,
): Promise<SttConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
        },
      },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readSttConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

export interface TranscribeInboundParams {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  messageId: number;
  attachmentId: number;
  dataUrl: string;
  cfg: SttConfig;
  base?: PrismaClient;
  deps?: { makeClient?: MakeClient; fetchImpl?: typeof fetch };
  // Optional execution-flow context: when present, the transcription is logged as an `stt` stage.
  flow?: FlowContext;
}

// Downloads, transcribes, and writes the transcription back to Chatwoot. Returns the transcription
// (also persisted in the attachment meta) or null when STT is not runnable (no key / misconfigured)
// or yields nothing. Throws only on a hard download/provider error so the caller can decide; the
// webhook treats STT as best-effort and never strands the delivery on it.
export async function transcribeInboundAudio(
  params: TranscribeInboundParams,
): Promise<string | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  // Surface a misconfig skip on the turn trail / Logs (warn + skipped), so an STT that silently does
  // nothing (voice note left untranscribed) is visible to the operator instead of vanishing.
  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "stt",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getSttProvider(cfg.provider);
  if (!provider) {
    logger.warn("stt: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  if (!cfg.credentialRef) {
    logger.warn("stt: no credentialRef configured — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    logger.warn(
      "stt: credential %s not found in the vault — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }
  // NOTE: credential baseUrl takes precedence over the agent config baseURL (config is a fallback).
  // The requiresBaseURL check uses the effective value so a credential-stored URL satisfies the guard.
  const effectiveBaseURL = entry.baseUrl ?? cfg.baseURL;
  if (provider.requiresBaseURL && !effectiveBaseURL) {
    logger.warn("stt: provider %s requires a baseURL — skipping", cfg.provider);
    return skip("no_base_url");
  }

  const client = await loadChatwootClient(params.tenantId, params.instanceId, {
    base,
    makeClient: params.deps?.makeClient,
  });
  // NOTE: the download sits OUTSIDE the withFlowStage span below, so a failure here used to leave NO
  // `stt` line at all — the operator saw a turn that answered "não consegui ouvir" with nothing on the
  // Logs page to explain it. Emit the stage line, then re-throw (the caller decides; see the contract
  // above). `retryOnMissing` absorbs Chatwoot's write race on a fresh voice note.
  let bytes: ArrayBuffer;
  let contentType: string | null;
  try {
    ({ bytes, contentType } = await client.downloadAttachment(params.dataUrl, {
      retryOnMissing: true,
    }));
  } catch (err) {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "stt",
        level: "warn",
        status: "error",
        provider: cfg.provider,
        detail: { step: "download" },
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
  const raw = await withFlowStage(
    params.flow,
    "stt",
    { provider: cfg.provider, model: cfg.model || provider.defaultModel },
    () =>
      provider.transcribe({
        audio: bytes,
        mimeType: contentType,
        language: cfg.language,
        model: cfg.model || provider.defaultModel,
        apiKey: entry.secret,
        baseURL: effectiveBaseURL,
        fetchImpl: params.deps?.fetchImpl ?? fetch,
      }),
  );
  const text = cleanTranscription(raw);
  if (!text) return null;

  // NOTE: Stash BEFORE the write-back: on upstream Chatwoot (no fork meta route) the in-process
  // overlay is the only reader that will ever see this transcription (issue #49).
  stashMediaAnnotation(
    {
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      messageId: params.messageId,
    },
    { transcribedText: text },
  );

  // NOTE: Write back so the debounce re-fetch (and human agents) see it. Best-effort: a write-back
  // failure should not lose the transcription — the direct path uses the returned value and the flush reads
  // the stash above. Surface it on the flow log anyway (a fork operator wants to know the meta is
  // not landing; an upstream operator learns why Chatwoot shows no transcription).
  try {
    await client.updateAttachmentMeta(
      params.conversationId,
      params.messageId,
      params.attachmentId,
      { transcribed_text: text },
    );
  } catch (e) {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "stt",
        level: "warn",
        status: "error",
        provider: cfg.provider,
        detail: { step: "write_back" },
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    logger.warn(
      "stt: write-back failed (conv=%s msg=%d): %s",
      String(params.conversationId),
      params.messageId,
      e instanceof Error ? e.message : String(e),
    );
  }
  return text;
}

export interface PlaygroundTranscribeParams {
  // The REQUEST's context, unlike the inbound path above, whose tenant id this process read from a
  // row. Rebuilding one here would tell the unknown-tenant check at `runScopedOn` that a caller's
  // stale selector was internal, and the operator would get "agent not found" for a tenant that is
  // gone rather than a refusal naming the selection they are carrying (issue #268).
  ctx: TenantContext;
  agentId: bigint;
  audio: ArrayBuffer;
  mimeType: string | null;
  // The live-edit draft's full settings bag (if present): its `stt` overrides the saved config so a
  // freshly-set credential can be tested WITHOUT saving first (mirrors the model/prompt override).
  settings?: unknown;
  base?: PrismaClient;
  deps?: { fetchImpl?: typeof fetch };
}

// Transcribe an uploaded audio file with the agent's configured STT provider, for the playground.
// Unlike the inbound path (best-effort, silent on misconfig so a real conversation is never stranded),
// this THROWS a clear AppError when STT is not runnable — the operator is explicitly testing the
// configuration and needs to know what is wrong. No Chatwoot, no write-back: the transcription is
// returned to the caller only. The stt.enabled toggle IS respected (a disabled STT reads as
// not-configured): the live draft carries `enabled`, so the operator still tests before saving by
// flipping the toggle on in the editor. The returned string may be empty (silent/inaudible audio).
export async function transcribePlaygroundAudio(
  params: PlaygroundTranscribeParams,
): Promise<string> {
  const base = params.base ?? basePrisma;
  const cfg =
    params.settings !== undefined
      ? readSttConfig(params.settings)
      : await runScopedOn(base, params.ctx, async (db) => {
          const agent = await db.agent.findUnique({
            where: { id: params.agentId },
            select: { settings: true },
          });
          return agent ? readSttConfig(agent.settings) : null;
        });
  if (!cfg) throw new NotFoundError("agent not found", "errors.agentNotFound");

  const provider = getSttProvider(cfg.provider);
  if (!cfg.enabled || !provider || !cfg.credentialRef) {
    throw new AppError(
      "speech-to-text is not configured",
      400,
      "errors.sttNotConfigured",
    );
  }
  const entry = await runScopedOn(base, params.ctx, (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    throw new AppError(
      "transcription credential not found",
      400,
      "errors.sttCredentialMissing",
    );
  }
  const effectiveBaseURL = entry.baseUrl ?? cfg.baseURL;
  if (provider.requiresBaseURL && !effectiveBaseURL) {
    throw new AppError(
      "A base URL is required for this provider.",
      400,
      "errors.baseUrlRequired",
    );
  }

  let raw: string;
  try {
    raw = await provider.transcribe({
      audio: params.audio,
      mimeType: params.mimeType,
      language: cfg.language,
      model: cfg.model || provider.defaultModel,
      apiKey: entry.secret,
      baseURL: effectiveBaseURL,
      fetchImpl: params.deps?.fetchImpl ?? fetch,
    });
  } catch (e) {
    const detail = clipText(e instanceof Error ? e.message : String(e), 300);
    throw new AppError(
      `transcription failed: ${detail}`,
      502,
      "errors.sttFailed",
      { detail },
    );
  }
  return cleanTranscription(raw);
}
