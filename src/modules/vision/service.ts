import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { recordDirectUsage } from "@/graph/usage";
import { AppError, NotFoundError } from "@/lib/errors";
import { shareInFlight } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  fileReadFor,
  rememberFileRead,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  announceSpendCeilingWarning,
  assertPlaygroundSpendCeiling,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import {
  MediaSourceMismatchError,
  MediaTooLargeError,
  runMediaConverter,
} from "./convert";
import { isDecorativeImage } from "./decorative";
import { visionAcceptsDocuments } from "./document-support";
import { normalizeMediaType, planImageConversion } from "./media-conversion";
import {
  getVisionProvider,
  type VisionKind,
  type VisionProvider,
  type VisionRequest,
  type VisionResult,
  visionKindForMime,
} from "./providers";
import {
  attemptBudgetMs,
  isTransientVisionFailure,
  retryDelayMs,
  VISION_MAX_ATTEMPTS,
} from "./retry";
import { readVisionConfig, type VisionConfig } from "./settings";
import { isUnread, skipLevel, type Unread, unreadCauseOf } from "./unread";

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
  // The agent whose settings answer, when the caller already knows it: a delivery on an OBSERVER's
  // route is read by the observer's runtime, not by whoever `Inbox.agentId` names (possibly nobody).
  // Absent, the inbox's responder answers.
  opts: { agentId?: bigint | null } = {},
): Promise<VisionConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agentId =
      opts.agentId ??
      (
        await db.inbox.findUnique({
          where: {
            tenantId_chatwootInstanceId_chatwootInboxId: {
              tenantId,
              chatwootInstanceId: instanceId,
              chatwootInboxId,
            },
          },
          select: { agentId: true },
        })
      )?.agentId;
    if (!agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readVisionConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// One extraction, asked as many times as the policy in ./retry allows.
// The flow span is INSIDE the loop, so each attempt is its own `vision` line with its own `attempt`
// and duration: three lines saying 503 name an endpoint that is down, one summary reads like one
// bad call.
export async function extractWithRetry(args: {
  provider: VisionProvider;
  req: Omit<VisionRequest, "timeoutMs">;
  flow?: FlowContext;
  providerName: string;
  model: string;
  sleep?: (ms: number) => Promise<void>;
  // Injectable together with `sleep`, and for the same reason: what this loop spends is TIME, and a
  // battery that cannot move the clock cannot tell a budget read before the wait from one read
  // after it.
  now?: () => number;
  // The caller's deadline: past it, no further attempt is started.
  signal?: AbortSignal;
}): Promise<VisionResult> {
  const { kind } = args.req;
  // A `baseURL` means the operator chose the endpoint, so the latency is their hardware's and
  // none of our measurements describe it — the ceiling stands down and the attempt keeps the total.
  const customEndpoint = args.req.baseURL !== null;
  const sleep = args.sleep ?? realSleep;
  // `performance.now`, not `Date.now`: this is a hard deadline, and a wall clock can move
  // BACKWARD (an NTP correction, a VM resuming from a snapshot — this project has seen the Docker
  // VM's clock drift after sleep). A negative elapsed would hand an attempt more than the total has
  // left. The monotonic source cannot, and only differences are read here, so its arbitrary origin
  // does not matter.
  const now = args.now ?? (() => performance.now());
  const startedAt = now();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= VISION_MAX_ATTEMPTS; attempt++) {
    const delayMs = retryDelayMs(attempt);
    if (delayMs === null) break;
    // NOTE: Two readings of the same question, because the wait sits between them. The first asks
    // whether waiting is worth it AT ALL — a wait that lands past the total costs the turn hundreds
    // of milliseconds to buy nothing.
    if (
      attemptBudgetMs({
        kind,
        attempt,
        elapsedMs: now() - startedAt + delayMs,
        customEndpoint,
      }) === null
    )
      break;
    if (delayMs > 0) await sleep(delayMs);
    // The second is the one the provider gets, and it is read AFTER the wait: `sleep` is what
    // a stalled or suspended process oversleeps, and a deadline computed from the nominal delay
    // would hand that process time the total no longer has.
    const budgetMs = attemptBudgetMs({
      kind,
      attempt,
      elapsedMs: now() - startedAt,
      customEndpoint,
    });
    if (budgetMs === null) break;
    if (args.signal?.aborted) break;
    try {
      return await withFlowStage(
        args.flow,
        "vision",
        {
          provider: args.providerName,
          model: args.model,
          // NOTE: `budgetMs` is what THIS attempt was allowed, and the two lines of one extraction
          // do not carry the same number: the last attempt gets what is left of the total. Without
          // it a 39s timeout reads as a slow provider rather than as the budget running out.
          detail: { kind, attempt, budgetMs },
          // NOTE: Recovered (→ "couldn't extract" marker), so a failure reads as an advisory, not
          // a red error — same contract as TTS.
          errorLevel: "warn",
        },
        () => args.provider.extract({ ...args.req, timeoutMs: budgetMs }),
      );
    } catch (err) {
      // NOTE: A permanent failure (a bad key, a model id that does not exist, a file the provider
      // rejects) answers the same way every time, so asking again only makes the turn slower.
      if (!isTransientVisionFailure(err)) throw err;
      lastErr = err;
    }
  }
  // NOTE: Reached when the attempts, the budget or the caller's deadline ran out, and by the loop's
  // own bound, so stopping never depends only on a rule that lives elsewhere. `lastErr` is unset
  // only when the deadline had already passed before attempt 1, which always gets a budget.
  throw (
    lastErr ?? new Error("vision: the deadline passed before the first attempt")
  );
}

export interface ExtractInboundParams {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  messageId: number;
  // Null for an image kept inside an email body: there is no attachment to write back to.
  attachmentId: number | null;
  dataUrl: string;
  cfg: VisionConfig;
  base?: PrismaClient;
  deps?: {
    makeClient?: MakeClient;
    fetchImpl?: typeof fetch;
    // Injectable so the retry battery does not actually wait out the backoff.
    sleep?: (ms: number) => Promise<void>;
  };
  // Optional execution-flow context: when present, the extraction is logged as a `vision` stage
  // (mirrors STT), so a skip/failure is visible on the Logs page instead of vanishing.
  flow?: FlowContext;
  // Whether to write this extraction into the in-process annotation store. Default true. The
  // webhook passes FALSE and stashes ONE aggregate after the loop: the store is keyed by MESSAGE, so
  // a per-file write mid-flight would overlay a partial result over the complete meta.
  stashAnnotation?: boolean;
  // The caller's deadline, handed to the provider attempts.
  signal?: AbortSignal;
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

// THE CONVERSION, shared by both entry points: "can THIS PROVIDER read it" (./media-conversion),
// after `visionKindForMime` asked whether the file is readable at all.
// A FAILED CONVERSION SKIPS, except `MediaSourceMismatchError` (the declared type lied): vendors sniff
// the bytes, so the original goes as-is and is still read. The flow line is written ONLY when a
// conversion happened, so attachments that need none add nothing to the Logs page.
async function convertForProvider(args: {
  bytes: ArrayBuffer;
  mimeType: string | null;
  provider: string;
  flow?: FlowContext;
}): Promise<
  | { ok: true; bytes: ArrayBuffer; mimeType: string | null }
  | { ok: false; reason: string }
> {
  const plan = planImageConversion({
    mimeType: args.mimeType,
    provider: args.provider,
  });
  if (plan.action === "as-is")
    return { ok: true, bytes: args.bytes, mimeType: args.mimeType };
  const startedAt = performance.now();
  try {
    const bytes = await runMediaConverter(plan.converter, args.bytes);
    if (args.flow)
      emitFlowEvent(args.flow, {
        stage: "vision",
        level: "info",
        status: "ok",
        provider: args.provider,
        durationMs: Math.round(performance.now() - startedAt),
        detail: {
          step: "convert",
          converter: plan.converter,
          from: normalizeMediaType(args.mimeType),
          to: plan.to,
          bytesIn: args.bytes.byteLength,
          bytesOut: bytes.byteLength,
        },
      });
    return { ok: true, bytes, mimeType: plan.to };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // NOTE: A mismatch stopped NOTHING (the bytes go untouched and are read), so it logs that the
    // declared type was wrong, at info, not a conversion failure at warn. These are application log
    // lines only: the Logs page gets the caller's `convert_failed`, and nothing for a mismatch.
    if (err instanceof MediaSourceMismatchError) {
      logger.info(
        "vision: %s — sent as received, the provider sniffs the bytes (provider=%s)",
        why,
        args.provider,
      );
      return { ok: true, bytes: args.bytes, mimeType: args.mimeType };
    }
    if (err instanceof MediaTooLargeError) {
      logger.info(
        "vision: %s, the attachment was not read (provider=%s)",
        why,
        args.provider,
      );
      return { ok: false, reason: "over_pixel_cap" };
    }
    // The converter id is already the head of the wrapped message, so it is not repeated here.
    logger.warn(
      "vision: conversion failed, the attachment was not read (provider=%s): %s",
      args.provider,
      why,
    );
    return { ok: false, reason: "convert_failed" };
  }
}

// What an email body image comes back as when it is an ornament (a signature icon, the logo of a
// quoted email). Not a failure, so it is neither extracted nor counted among the files the model is
// told were not read. A URL that is not this Chatwoot's never gets here: the caller drops it
// before the per-message cap is applied.
export const BODY_IMAGE_IGNORED = "ignored" as const;

// Downloads, extracts, and writes the content back to Chatwoot. Returns the extraction (also
// persisted in the attachment meta) or null when vision is not runnable, the file is unsupported,
// or it yields nothing. Best-effort: the webhook never strands delivery on it.
export async function extractInboundFile(
  params: ExtractInboundParams,
): Promise<ExtractResult | null> {
  const r = await readInboundFile(params);
  return isUnread(r) ? null : r;
}

// The same read, saying why when the file was not read.
export async function readInboundFile(
  params: ExtractInboundParams,
): Promise<ExtractResult | Unread> {
  const r = await extractInbound(params);
  return r === BODY_IMAGE_IGNORED || r === BODY_IMAGE_OVER_CAP
    ? { unread: "failed" }
    : r;
}

// An image Chatwoot's mailbox kept inside the email body instead of making it an attachment.
export function extractBodyImage(
  params: Omit<ExtractInboundParams, "attachmentId">,
): Promise<ExtractResult | Unread | typeof BODY_IMAGE_IGNORED> {
  return extractInbound({
    ...params,
    attachmentId: null,
    bodyImage: true,
  }) as Promise<ExtractResult | Unread | typeof BODY_IMAGE_IGNORED>;
}

// A body image past the per-message cap, downloaded only to know whether it is an ornament: it is
// never sent to the provider, and what is not an ornament is what the model is told was not read.
export const BODY_IMAGE_OVER_CAP = "over_cap" as const;
export async function classifyBodyImage(
  params: Omit<ExtractInboundParams, "attachmentId">,
): Promise<null | typeof BODY_IMAGE_IGNORED | typeof BODY_IMAGE_OVER_CAP> {
  const r = await extractInbound({
    ...params,
    attachmentId: null,
    bodyImage: true,
    classifyOnly: true,
  });
  return r === BODY_IMAGE_IGNORED || r === BODY_IMAGE_OVER_CAP ? r : null;
}

// One read per file, however many deliveries of its message ask: a delivery that finds the file
// being read waits for that read, and one that comes later reuses its result while the annotation
// store keeps it. A failed read is not kept, so the next delivery tries again.
function extractInbound(
  params: ExtractInboundParams & {
    bodyImage?: boolean;
    classifyOnly?: boolean;
  },
): Promise<
  | ExtractResult
  | Unread
  | typeof BODY_IMAGE_IGNORED
  | typeof BODY_IMAGE_OVER_CAP
> {
  const key = `vision:${params.tenantId}:${params.instanceId}:${params.messageId}:${params.attachmentId ?? params.dataUrl}:${params.classifyOnly ? "classify" : "read"}`;
  const kept = fileReadFor(key);
  if (kept)
    return Promise.resolve(
      kept.value as
        | ExtractResult
        | typeof BODY_IMAGE_IGNORED
        | typeof BODY_IMAGE_OVER_CAP,
    );
  return shareInFlight(key, async () => {
    const value = await extractInboundOnce(params);
    if (!isUnread(value)) rememberFileRead(key, value);
    return value;
  });
}

async function extractInboundOnce(
  params: ExtractInboundParams & {
    bodyImage?: boolean;
    classifyOnly?: boolean;
  },
): Promise<
  | ExtractResult
  | Unread
  | typeof BODY_IMAGE_IGNORED
  | typeof BODY_IMAGE_OVER_CAP
> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  // Surface a skip on the Logs/turn trail so a vision that silently does nothing (attachment left
  // unextracted) is visible to the operator instead of vanishing. Mirrors STT.
  const skip = (reason: string): Unread => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "vision",
        level: skipLevel(reason),
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return { unread: unreadCauseOf(reason) };
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
    tryResolveApiKeyEntry(db, cfg.credentialRef as string),
  );
  if (entry.state !== "ok") {
    // NOTE: Gone/unfilled and wrong-KIND are separate lines because the operator's move differs:
    // re-pick or fill one, move the other to the field it belongs on.
    if (entry.state === "unusable") {
      logger.warn(
        "vision: credential %s is a %s credential, which cannot be used as an API key — skipping",
        cfg.credentialRef,
        entry.kind,
      );
      return skip("credential_unusable");
    }
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
    // A body image was stored by the mailbox before the message existed: its 404 will not heal, and
    // retrying it would multiply whatever a crafted body asks for.
    ({ bytes, contentType } = await client.downloadAttachment(params.dataUrl, {
      retryOnMissing: !params.bodyImage,
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
  // Only a positively identified ornament; a type vision cannot read is the unsupported skip below,
  // counted as unread like any other file that was sent and not read.
  if (params.bodyImage && kind === "image" && isDecorativeImage(bytes))
    return BODY_IMAGE_IGNORED;
  if (!kind) return skip("unsupported_mime"); // unsupported mime → marker
  if (params.classifyOnly) return BODY_IMAGE_OVER_CAP;
  // The ENDPOINT decides, not the provider name: the same base URL that the call below posts to is
  // what has to be known to read a PDF (see ./document-support).
  if (
    kind === "document" &&
    !visionAcceptsDocuments(cfg.provider, entry.baseUrl ?? cfg.baseURL)
  )
    return skip("document_not_supported");

  // THE SPEND CEILING, asked here because vision runs BEFORE the webhook's gates, and only
  // once the call is known to be possible: a refusal must mean spend was what stood in the way, so
  // the conversion (which can refuse on its own) runs first. It announces the warning and not the
  // refusal; why is in docs/spend-ceiling.md ("Vision asks for itself").
  const converted = await convertForProvider({
    bytes,
    mimeType: contentType,
    provider: cfg.provider,
    flow: params.flow,
  });
  if (!converted.ok) return skip(converted.reason);

  const ceiling = await spendCeilingVerdict({
    tenantId: params.tenantId,
    source: "inbox",
    base,
  });
  announceSpendCeilingWarning(params.flow, ceiling, "inbox", params.tenantId);
  if (ceiling.state === "over") {
    logger.info(
      "vision: spend ceiling reached (tenant=%s used=%s ceiling=%s) — the attachment was not read",
      String(params.tenantId),
      String(ceiling.usedUsd),
      String(ceiling.ceilingUsd),
    );
    return skip("spend_ceiling");
  }

  let extracted: VisionResult;
  const readStartedAt = performance.now();
  try {
    extracted = await extractWithRetry({
      provider,
      providerName: cfg.provider,
      model: cfg.model || provider.defaultModel,
      flow: params.flow,
      sleep: params.deps?.sleep,
      signal: params.signal,
      req: {
        bytes: converted.bytes,
        mimeType:
          converted.mimeType ??
          (kind === "image" ? "image/jpeg" : "application/pdf"),
        kind,
        prompt: cfg.extractionPrompt,
        model: cfg.model || provider.defaultModel,
        apiKey: entry.secret,
        baseURL: entry.baseUrl ?? cfg.baseURL,
        fetchImpl: params.deps?.fetchImpl ?? fetch,
      },
    });
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
    return { unread: "failed" };
  }
  const text = extracted.text.trim();
  // NOTE: The row is written whether or not the extraction yielded text: a call that came back empty
  // was billed like one that came back full, so the usage is recorded before the early return.
  if (params.flow && extracted.usage) {
    await recordDirectUsage(params.flow, {
      provider: cfg.provider,
      model: cfg.model || provider.defaultModel,
      node: "vision",
      ...extracted.usage,
      durationMs: performance.now() - readStartedAt,
    });
  }
  if (!text) return { unread: "failed" };

  // NOTE: Stash BEFORE the write-back, same contract as the STT pass: on upstream Chatwoot (no
  // fork meta route) the in-process overlay is the only reader of this extraction.
  if (params.stashAnnotation !== false)
    stashMediaAnnotation(
      {
        tenantId: params.tenantId,
        instanceId: params.instanceId,
        messageId: params.messageId,
      },
      kind === "image" ? { imageDescription: text } : { extractedText: text },
    );

  // NOTE: Write back so the debounce re-fetch (and human agents) see it. Best-effort; surfaced on
  // the flow log so a meta that never lands is visible to the operator.
  if (params.attachmentId !== null)
    try {
      await client.updateAttachmentMeta(
        params.conversationId,
        params.messageId,
        params.attachmentId,
        { [metaKeyFor(kind)]: text },
      );
    } catch (e) {
      if (params.flow) {
        emitFlowEvent(params.flow, {
          stage: "vision",
          level: "warn",
          status: "error",
          provider: cfg.provider,
          detail: { step: "write_back" },
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
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
  // The REQUEST's context, unlike the inbound path, whose tenant id was read from a row. Rebuilding
  // one here would make the unknown-tenant check at `runScopedOn` treat a stale selector as internal
  // and answer "agent not found" instead of refusing the selection.
  ctx: TenantContext;
  agentId: bigint;
  file: ArrayBuffer;
  mimeType: string | null;
  // The live-edit draft's full settings bag (if present): its `vision` overrides the saved config
  // so a freshly-set credential can be tested WITHOUT saving first.
  settings?: unknown;
  base?: PrismaClient;
  deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
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
      : await runScopedOn(base, params.ctx, async (db) => {
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
  const entry = await runScopedOn(base, params.ctx, (db) =>
    tryResolveApiKeyEntry(db, cfg.credentialRef as string),
  );
  if (entry.state !== "ok") {
    if (entry.state === "unusable") {
      throw new AppError(
        `vision credential is a "${entry.kind}" credential and cannot be used as an API key`,
        400,
        "errors.credentialKindUnusableAsKey",
        { kind: entry.kind },
      );
    }
    throw new AppError(
      "vision credential not found",
      400,
      "errors.visionCredentialMissing",
    );
  }

  // CAN WE READ THIS AT ALL, asked before the ceiling. A ceiling refusal is a statement that spend
  // was the thing standing in the way, and for a file whose type this provider cannot read there
  // was never any spend to refuse — the extraction returns `unsupported` in a month with budget to
  // spare, so a 429 in a spent one reports a refusal that did not happen and sends the operator
  // looking at their budget over a file that would have been rejected either way. The check needs
  // `entry`, because whether documents are accepted depends on the resolved base URL, which is why
  // the credential resolution moves up with it: an unreadable credential is a configuration error
  // like the `!cfg.enabled` one already above the ceiling, not something the budget decided.
  const kind = visionKindForMime(params.mimeType);
  if (
    !kind ||
    (kind === "document" &&
      !visionAcceptsDocuments(cfg.provider, entry.baseUrl ?? cfg.baseURL))
  ) {
    return { kind: "unsupported", text: "" };
  }

  // Same placement as the inbound path and the same rule: a file this provider cannot read stops the
  // call whatever the budget says, so it is answered before the money is. The refusal differs only
  // in its shape — the playground has no marker to leave on a Chatwoot attachment, so an
  // unconvertible file is the `unsupported` the operator already sees for an unreadable type, and
  // getting the order wrong would answer 429 for a file no budget can make readable.
  const converted = await convertForProvider({
    bytes: params.file,
    mimeType: params.mimeType,
    provider: cfg.provider,
    flow: params.flow,
  });
  if (!converted.ok) return { kind: "unsupported", text: "" };

  // The playground's own ceiling, asked once the file is known to be extractable AND convertible,
  // and before the provider round trip. It throws (see `assertPlaygroundSpendCeiling`), so an
  // operator uploading a file into a spent month is told why instead of watching the extraction
  // produce nothing.
  await assertPlaygroundSpendCeiling({
    tenantId: params.ctx.tenantId as bigint,
    base,
    flow: params.flow,
  });

  try {
    const startedAt = performance.now();
    const extracted = await extractWithRetry({
      provider,
      providerName: cfg.provider,
      model: cfg.model || provider.defaultModel,
      flow: params.flow,
      sleep: params.deps?.sleep,
      req: {
        bytes: converted.bytes,
        mimeType:
          converted.mimeType ??
          (kind === "image" ? "image/jpeg" : "application/pdf"),
        kind,
        prompt: cfg.extractionPrompt,
        model: cfg.model || provider.defaultModel,
        apiKey: entry.secret,
        baseURL: entry.baseUrl ?? cfg.baseURL,
        fetchImpl: params.deps?.fetchImpl ?? fetch,
      },
    });
    if (params.flow && extracted.usage) {
      await recordDirectUsage(params.flow, {
        provider: cfg.provider,
        model: cfg.model || provider.defaultModel,
        node: "vision",
        ...extracted.usage,
        durationMs: performance.now() - startedAt,
      });
    }
    return { kind, text: extracted.text.trim() };
  } catch (e) {
    // Provider error (bad file, model refusal, timeout) must NOT interrupt the turn: log at
    // error-level (the ops alert channel — no Sentry here) and degrade to the "couldn't extract"
    // marker so the agent still answers. Misconfig (no credential/disabled) already threw above.
    logger.error(
      {
        tenantId: String(params.ctx.tenantId),
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
