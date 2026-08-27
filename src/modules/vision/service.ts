import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { recordDirectUsage } from "@/graph/usage";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { stashMediaAnnotation } from "@/modules/chatwoot/annotations";
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
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { visionAcceptsDocuments } from "./document-support";
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

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// One extraction, asked as many times as the policy in ./retry allows. A transient provider failure
// used to end the attachment for good — `extract` was called once and the caller degraded to the
// "couldn't extract" marker, which is what enters the conversation history (issue #319).
//
// The flow span is INSIDE the loop, so each attempt is its own `vision` line carrying its own
// `attempt` and duration. That is what makes a retried failure readable on the Logs page: three
// lines saying 503 name an endpoint that is down, while one line summarising them reads like one
// bad call. A first-attempt success is unchanged — a single line, now with `attempt: 1`.
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
}): Promise<VisionResult> {
  const { kind } = args.req;
  // NOTE: A `baseURL` means the operator chose the endpoint, so the latency is their hardware's and
  // none of our measurements describe it — the ceiling stands down and the attempt keeps the total.
  const customEndpoint = args.req.baseURL !== null;
  const sleep = args.sleep ?? realSleep;
  // NOTE: `performance.now`, not `Date.now`: this is a hard deadline, and a wall clock can move
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
    // NOTE: The second is the one the provider gets, and it is read AFTER the wait: `sleep` is what
    // a stalled or suspended process oversleeps, and a deadline computed from the nominal delay
    // would hand that process time the total no longer has.
    const budgetMs = attemptBudgetMs({
      kind,
      attempt,
      elapsedMs: now() - startedAt,
      customEndpoint,
    });
    if (budgetMs === null) break;
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
  // NOTE: Reached when the attempts or the budget ran out, and by the loop's own bound — so
  // stopping never depends only on a rule that lives elsewhere. `lastErr` is always set here:
  // attempt 1 is asked at zero elapsed, so it always gets a budget and either returns or fills it.
  throw lastErr;
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
  deps?: {
    makeClient?: MakeClient;
    fetchImpl?: typeof fetch;
    // Injectable so the retry battery does not actually wait out the backoff.
    sleep?: (ms: number) => Promise<void>;
  };
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
  // The ENDPOINT decides, not the provider name: the same base URL that the call below posts to is
  // what has to be known to read a PDF (see ./document-support).
  if (
    kind === "document" &&
    !visionAcceptsDocuments(cfg.provider, entry.baseUrl ?? cfg.baseURL)
  )
    return skip("document_not_supported");

  // THE SPEND CEILING, asked here and not by the caller. Vision runs on the incoming attachment
  // BEFORE the webhook's gates decide anything, so the turn ceiling upstream has not run yet and
  // an image sent into a spent month would be billed with nothing to stop it.
  //
  // ASKED ONCE THE CALL IS KNOWN TO BE POSSIBLE, immediately before it, and not at the top of this
  // function. A refusal says that spend was what stood in the way, and everything above — an unknown
  // provider, a missing credential, a type this endpoint cannot read — is a reason the provider was
  // never going to be called at all, so a `vision` line saying the attachment was skipped for budget
  // would name a cause that was not operative. The download above is a Chatwoot fetch, not a billed
  // one, and it is what tells this function the attachment's type in the first place.
  //
  // It is the REFUSAL half that this ordering is for. The warning is a statement about the MONTH,
  // true whether or not this particular call runs, so a window it claims early costs at most a
  // staler percentage in the line the operator reads — see the waiver in `.codex-review-waived`,
  // which is where that adjudication lives.
  //
  // IT ANNOUNCES THE WARNING AND NOT THE REFUSAL, which is the one thing this gate does differently
  // from the other four, and the asymmetry is what the two halves leave behind.
  //
  // `spend_ceiling` `over` is written per refused MESSAGE, and this runs on the same message the
  // webhook gate refuses moments later: writing it here would put two refusal rows and two alert
  // bumps on the Logs page for one customer message, and the count of refusals is the number an
  // operator reads off that page. Nothing is lost by staying quiet, because the `vision` line below
  // says `skipped` with `spend_ceiling` as its reason, which is the stage the reader filters by when
  // they are asking why an attachment was never read.
  //
  // The WARNING leaves no such trace: the call proceeds, the attachment is read, and no line
  // anywhere says the month crossed its fraction. And the gate that would have said it may never
  // run — vision is upstream of every one of them, so a human-owned conversation, a silenced agent,
  // a redirect or an hour outside the schedule consumes the delivery first, and this billed call is
  // the only thing that happened. It cannot double-write: the warning's window is claimed once, so
  // a gate that follows and asks the same question writes nothing.
  //
  // The playground's own file path asks in the same place, for the same reason, and differs only in
  // what it does with the answer: it goes through `assertPlaygroundSpendCeiling`, where no webhook
  // gate follows it and both halves are its own to announce.
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
      String(ceiling.usedTokens),
      String(ceiling.ceilingTokens),
    );
    return skip("spend_ceiling");
  }

  let extracted: VisionResult;
  try {
    extracted = await extractWithRetry({
      provider,
      providerName: cfg.provider,
      model: cfg.model || provider.defaultModel,
      flow: params.flow,
      sleep: params.deps?.sleep,
      req: {
        bytes,
        mimeType:
          contentType ?? (kind === "image" ? "image/jpeg" : "application/pdf"),
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
    return null;
  }
  const text = extracted.text.trim();
  // The row is written whether or not the extraction yielded text: a call that came back empty was
  // billed exactly like one that came back full, and the early return below used to end the
  // function before anything could record it.
  if (params.flow && extracted.usage) {
    await recordDirectUsage(params.flow, {
      model: cfg.model || provider.defaultModel,
      node: "vision",
      ...extracted.usage,
    });
  }
  if (!text) return null;

  // NOTE: Stash BEFORE the write-back — same contract as the STT pass: on upstream Chatwoot (no
  // fork meta route) the in-process overlay is the only reader of this extraction (issue #49).
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
  // The REQUEST's context, unlike the inbound path above, whose tenant id this process read from a
  // row. Rebuilding one here would tell the unknown-tenant check at `runScopedOn` that a caller's
  // stale selector was internal, and the operator would get "agent not found" for a tenant that is
  // gone rather than a refusal naming the selection they are carrying (issue #268).
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
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
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

  // The playground's own ceiling, asked once the file is known to be extractable and before the
  // provider round trip. It throws (see `assertPlaygroundSpendCeiling`), so an operator uploading a
  // file into a spent month is told why instead of watching the extraction produce nothing.
  await assertPlaygroundSpendCeiling({
    tenantId: params.ctx.tenantId as bigint,
    base,
    flow: params.flow,
  });

  try {
    const extracted = await extractWithRetry({
      provider,
      providerName: cfg.provider,
      model: cfg.model || provider.defaultModel,
      flow: params.flow,
      sleep: params.deps?.sleep,
      req: {
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
      },
    });
    if (params.flow && extracted.usage) {
      await recordDirectUsage(params.flow, {
        model: cfg.model || provider.defaultModel,
        node: "vision",
        ...extracted.usage,
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
