import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import {
  getVisionProvider,
  type VisionKind,
  visionKindForMime,
} from "./providers";
import { readVisionConfig, type VisionConfig } from "./settings";

// Image/document extraction orchestration (the vision mirror of stt/service): download the file,
// extract its content via the configured provider (key from the vault), and write the result back
// onto the Chatwoot attachment meta (image_description / extracted_text) so the debounce re-fetch
// reads it (and human agents see it too). The content lives only in Chatwoot, never our own DB —
// consistent with the anti-PII no-body-mirror rule. All network I/O is outside transactions.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type MakeClient = (
  cfg: ConstructorParameters<typeof ChatwootClient>[0],
) => Promise<ChatwootClient>;

// Resolves the vision config for the inbox's agent. Returns null when unbound, disabled, or vision
// off — the caller then leaves the attachment unextracted (rendered as a "could not extract" marker).
export async function resolveVisionConfig(
  tenantId: bigint,
  instanceId: bigint,
  chatwootInboxId: number,
  base: PrismaClient = basePrisma,
): Promise<VisionConfig | null> {
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
    return readVisionConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

export interface ExtractInboundParams {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  messageId: number;
  attachmentId: number;
  dataUrl: string;
  cfg: VisionConfig;
  base?: PrismaClient;
  deps?: { makeClient?: MakeClient; fetchImpl?: typeof fetch };
  // Optional execution-flow context: when present, the extraction is logged as a `vision` stage
  // (mirrors STT), so a skip/failure is visible on the Logs page instead of vanishing.
  flow?: FlowContext;
}

export interface ExtractResult {
  kind: VisionKind;
  text: string;
}

// The attachment-meta key the extracted content is written back under, per kind. The message parser
// reads both; renderInboundMessage injects the matching marker.
function metaKeyFor(kind: VisionKind): "image_description" | "extracted_text" {
  return kind === "image" ? "image_description" : "extracted_text";
}

// Downloads, extracts, and writes the content back to Chatwoot. Returns the extraction (also
// persisted in the attachment meta) or null when vision is not runnable, the file is unsupported
// (non-image/PDF, or a PDF on an image-only provider), or it yields nothing. Best-effort: the
// webhook never strands delivery on it.
export async function extractInboundFile(
  params: ExtractInboundParams,
): Promise<ExtractResult | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  // Surface a skip on the Logs/turn trail (warn + skipped) so a vision that silently does nothing
  // (attachment left unextracted) is visible to the operator instead of vanishing. Mirrors STT.
  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "vision",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getVisionProvider(cfg.provider);
  if (!provider) {
    logger.warn("vision: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  if (!cfg.credentialRef) {
    logger.warn("vision: no credentialRef configured — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    logger.warn(
      "vision: credential %s not found in the vault — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }

  const client = await loadChatwootClient(params.tenantId, params.instanceId, {
    base,
    makeClient: params.deps?.makeClient,
  });
  // Mirrors STT: the download is outside the span below, so surface its failure as a `vision` line
  // instead of letting it vanish, and absorb Chatwoot's write race on a freshly-posted attachment.
  let bytes: ArrayBuffer;
  let contentType: string | null;
  try {
    ({ bytes, contentType } = await client.downloadAttachment(params.dataUrl, {
      retryOnMissing: true,
    }));
  } catch (err) {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "vision",
        level: "warn",
        status: "error",
        provider: cfg.provider,
        detail: { step: "download" },
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
  const kind = visionKindForMime(contentType);
  if (!kind) return skip("unsupported_mime"); // unsupported mime → marker
  if (kind === "document" && !provider.supportsDocuments)
    return skip("document_not_supported");

  let text: string;
  try {
    text = (
      await withFlowStage(
        params.flow,
        "vision",
        {
          provider: cfg.provider,
          model: cfg.model || provider.defaultModel,
          detail: { kind },
          // Recovered (→ "couldn't extract" marker), so a failure reads as an advisory, not a red
          // error — same contract as TTS.
          errorLevel: "warn",
        },
        () =>
          provider.extract({
            bytes,
            mimeType:
              contentType ??
              (kind === "image" ? "image/jpeg" : "application/pdf"),
            kind,
            prompt: cfg.extractionPrompt,
            model: cfg.model || provider.defaultModel,
            apiKey: entry.secret,
            baseURL: entry.baseUrl ?? cfg.baseURL,
            fetchImpl: params.deps?.fetchImpl ?? fetch,
          }),
      )
    ).trim();
  } catch (e) {
    // Best-effort: a provider error must not strand delivery. Log at error-level (ops alert channel)
    // and leave the attachment unextracted → the agent sees the "couldn't extract" marker.
    logger.error(
      {
        tenantId: String(params.tenantId),
        conversationId: String(params.conversationId),
        provider: cfg.provider,
        mime: contentType,
        err: e instanceof Error ? e.message : String(e),
      },
      "inbound vision extraction failed; leaving attachment unextracted",
    );
    return null;
  }
  if (!text) return null;

  // Write back so the debounce re-fetch (and human agents) see it. Best-effort.
  try {
    await client.updateAttachmentMeta(
      params.conversationId,
      params.messageId,
      params.attachmentId,
      { [metaKeyFor(kind)]: text },
    );
  } catch (e) {
    logger.warn(
      "vision: write-back failed (conv=%s msg=%d): %s",
      String(params.conversationId),
      params.messageId,
      e instanceof Error ? e.message : String(e),
    );
  }
  return { kind, text };
}

export interface PlaygroundExtractParams {
  tenantId: bigint;
  agentId: bigint;
  file: ArrayBuffer;
  mimeType: string | null;
  // The live-edit draft's full settings bag (if present): its `vision` overrides the saved config
  // so a freshly-set credential can be tested WITHOUT saving first.
  settings?: unknown;
  base?: PrismaClient;
  deps?: { fetchImpl?: typeof fetch };
  // Optional execution-flow context: when present, the extraction is logged as a `vision` stage
  // (source=playground), so the operator sees it on the Logs page.
  flow?: FlowContext;
}

export interface PlaygroundExtractResult {
  kind: VisionKind | "unsupported";
  text: string;
}

// Extract an uploaded file with the agent's configured vision provider, for the playground. Unlike
// the inbound path (best-effort, silent), this THROWS a clear AppError on misconfig — the operator
// is explicitly testing the configuration. No Chatwoot, no write-back. An unsupported file type is
// reported (kind: "unsupported") rather than thrown, so the playground can render the marker. The
// vision.enabled toggle IS respected (a disabled vision reads as not-configured): the live draft
// carries `enabled`, so the operator still tests before saving by flipping the toggle on.
export async function extractPlaygroundFile(
  params: PlaygroundExtractParams,
): Promise<PlaygroundExtractResult> {
  const base = params.base ?? basePrisma;
  const cfg =
    params.settings !== undefined
      ? readVisionConfig(params.settings)
      : await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
          const agent = await db.agent.findUnique({
            where: { id: params.agentId },
            select: { settings: true },
          });
          return agent ? readVisionConfig(agent.settings) : null;
        });
  if (!cfg) throw new NotFoundError("agent not found", "errors.agentNotFound");

  const provider = getVisionProvider(cfg.provider);
  if (!cfg.enabled || !provider || !cfg.credentialRef) {
    throw new AppError(
      "image/document reading is not configured",
      400,
      "errors.visionNotConfigured",
    );
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    throw new AppError(
      "vision credential not found",
      400,
      "errors.visionCredentialMissing",
    );
  }

  const kind = visionKindForMime(params.mimeType);
  if (!kind || (kind === "document" && !provider.supportsDocuments)) {
    return { kind: "unsupported", text: "" };
  }

  try {
    const text = (
      await withFlowStage(
        params.flow,
        "vision",
        {
          provider: cfg.provider,
          model: cfg.model || provider.defaultModel,
          detail: { kind },
          errorLevel: "warn",
        },
        () =>
          provider.extract({
            bytes: params.file,
            mimeType:
              params.mimeType ??
              (kind === "image" ? "image/jpeg" : "application/pdf"),
            kind,
            prompt: cfg.extractionPrompt,
            model: cfg.model || provider.defaultModel,
            apiKey: entry.secret,
            baseURL: entry.baseUrl ?? cfg.baseURL,
            fetchImpl: params.deps?.fetchImpl ?? fetch,
          }),
      )
    ).trim();
    return { kind, text };
  } catch (e) {
    // Provider error (bad file, model refusal, timeout) must NOT interrupt the turn: log at
    // error-level (the ops alert channel — no Sentry here) and degrade to the "couldn't extract"
    // marker so the agent still answers. Misconfig (no credential/disabled) already threw above.
    logger.error(
      {
        tenantId: String(params.tenantId),
        agentId: String(params.agentId),
        provider: cfg.provider,
        mime: params.mimeType,
        err: e instanceof Error ? e.message : String(e),
      },
      "playground vision extraction failed; degrading to unsupported marker",
    );
    return { kind: "unsupported", text: "" };
  }
}
