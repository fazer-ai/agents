import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  type AgentNudge,
  type RunAgentNudgeOutcome,
  runAgentNudge,
} from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/pg-error";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { makeStorableDeep, unstorableProblem } from "@/lib/text";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import {
  CONVERSATION_REF_KIND,
  correlateConversationRef,
} from "@/modules/integrations/conversation-ref";
import {
  isFetchBackProblem,
  mapFetchedResource,
  noticeResourceId,
  parseFetchBackConfig,
} from "@/modules/integrations/fetch-back";
import { runFetchBack } from "@/modules/integrations/fetch-back-run";
import { getMapper } from "@/modules/integrations/mappers";
import {
  type ResolvedInboundRoute,
  resolveInboundRouteByToken,
} from "@/modules/integrations/service";
import type {
  InboundEventKind,
  MapResult,
  NormalizedInboundEvent,
} from "@/modules/integrations/types";
import { upsertJobRows } from "@/modules/scheduler/service";
import { resolveVaultRefState } from "@/modules/vault/service";
import {
  type InboundAuthFailure,
  type InboundSecretResolution,
  resolveInboundAuthConfig,
  verifyInboundAuth,
} from "./auth";
import {
  signatureCoversBody,
  signatureCoversId,
  signedLowered,
} from "./signed-message";
import { redispatchKey } from "./sweep";

// Generic inbound receptor. Resolve tenant by route token → verify the per-instance auth
// strategy (tenant-scoped secret) → normalize via the integration's pure mapper → persist an
// idempotent InboundDelivery (allowlisted payload) → ack fast. processInboundDelivery runs
// async (detached by the controller) and dispatches to the CLOSED set of domain events.

// A PROCESSING row older than this is presumed stranded by a crash and may be reclaimed (normal
// processing completes within seconds of receipt). Attempts are capped to stop poison loops.
export const PROCESSING_STALE_MS = 5 * 60_000;
const MAX_PROCESS_ATTEMPTS = 5;
// How long one dispatch may run before its nudge turn is told to stop, when the caller brings no
// deadline of its own (the route, which runs it detached after the ack). SHORTER than the window
// above: the inbound sweep re-dispatches a claim older than PROCESSING_STALE_MS, so a turn still
// running past it would deliver beside its own retry. The spare minute lets the abort land and the
// row be marked, as the scheduler's jobDeadlineMs does under the same window.
export const DISPATCH_DEADLINE_MS = 4 * 60_000;

// The stored payload kind of a GENERIC consult-back notice: not an event, the id an event is built
// from once the provider answers. Never leaves this module.
const FETCH_BACK_KIND = "fetch_back";

// WHAT "NO LONGER RUNNING" MEANS for a PROCESSING row. Two readers ask it and must not disagree: the
// claim below, which may take such a row, and the inbound sweep (./sweep.ts), which arms a re-dispatch
// for it and restates this rule in SQL because its query is a join Prisma cannot write. Change one,
// change both (tests/modules/inbound-sweep.test.ts drives both halves).
export function staleClaim(now: number = Date.now()) {
  const staleCutoff = new Date(now - PROCESSING_STALE_MS);
  return [
    { claimedAt: { lt: staleCutoff } },
    { claimedAt: null, receivedAt: { lt: staleCutoff } },
  ] as const;
}

// What an identity field is allowed to be, and a REFUSAL rather than a truncation: cutting an
// identity is as lossy as repairing one. Postgres's btree index refuses a row over ~2704 bytes (a
// 500 with no record); 512 characters is far above any provider id and below that limit even at 4
// bytes per character.
const MAX_IDENTITY_CHARS = 512;

// The two things an identity field must be for the row to exist: storable, and short enough for the
// index that enforces idempotency on it. Same verdict shape as `unstorableProblem`, whose message
// this passes through, because the caller does the same thing with either answer.
export function identityProblem(value: string, what: string): string | null {
  if (value.length > MAX_IDENTITY_CHARS) {
    return `${what} is ${value.length} characters, over the ${MAX_IDENTITY_CHARS} an identity field may hold.`;
  }
  return unstorableProblem(value, what);
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

type InboundLogger = Pick<typeof logger, "warn">;

// Everything that answers 401, route resolution included: an operator debugging a webhook asks "is
// my URL even right?" before "is my token right?", and the server log must tell them apart.
type InboundRejection = "route_unknown" | "route_disabled" | InboundAuthFailure;

// The refusal, recorded where the operator can find it. The RESPONSE stays uniform on purpose (no
// oracle for which route tokens are live), and that argument covers the response, not the server's
// own record: without this line an unresolvable ref, an unfilled secret and a genuinely wrong token
// are the same event in every log we keep. Carries ids and the vault REF
// (`vault:<id>` is an address, not a secret), never the header value, never the body.
function logRejection(
  log: InboundLogger,
  reason: InboundRejection,
  route: ResolvedInboundRoute | null,
): void {
  log.warn(
    {
      reason,
      ...(route
        ? {
            instanceId: String(route.id),
            tenantId: String(route.tenantId),
            catalogType: route.catalogType,
            strategy: route.inboundAuthStrategy,
            ...(route.inboundSecretRef
              ? { secretRef: route.inboundSecretRef }
              : {}),
          }
        : {}),
    },
    "inbound: rejected with 401",
  );
}

// The stored payload is exactly the mapper's allowlisted projection (kind + bounded fields),
// never the raw external JSON — it is PII-bearing and must not be echoed in logs/audit.
function toStoredPayload(n: NormalizedInboundEvent): Record<string, unknown> {
  const p: Record<string, unknown> = { kind: n.kind };
  if (n.value !== undefined) p.value = n.value;
  if (n.currency !== undefined) p.currency = n.currency;
  if (n.status !== undefined) p.status = n.status;
  if (n.summary !== undefined) p.summary = n.summary;
  if (n.text !== undefined) p.text = n.text;
  if (n.metadata !== undefined) p.metadata = n.metadata;
  if (n.occurredAt) p.occurredAt = n.occurredAt.toISOString();
  return p;
}

export interface ReceiveResult {
  ack: true;
  deliveryId?: bigint;
  tenantId?: bigint;
  outcome:
    | "queued"
    | "duplicate"
    | "ignored"
    | "no-mapper"
    | "invalid"
    // A GENERIC event whose `conversation_ref` does not correlate on this instance. Said
    // to the sender NOW, because nothing will ever act on it and the sender is the only party that
    // can stop: a periodic job keeps firing at a dead handle otherwise. Nothing is persisted.
    | "uncorrelated";
  // A lookup booked for the next window (persistNotice): the job at that window runs it, so the
  // receptor does not dispatch it now.
  deferred?: true;
}

// What a test reception (./test-reception.ts) reads off the real path: each stage the delivery
// passed or stopped at, in order. With `dryRun` nothing is written; `planned` then says what would
// have been queued, for the caller to carry on without a row.
export type InboundStageName =
  | "signature"
  | "mapping"
  | "fetch_back"
  | "correlation"
  | "record"
  | "agent"
  | "delivery";
export interface InboundStage {
  stage: InboundStageName;
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}
export interface InboundProbe {
  dryRun: boolean;
  stages: InboundStage[];
  planned?:
    | { kind: "notice"; resourceId: string; keyId: string }
    | { kind: "event"; event: NormalizedInboundEvent };
}

// The fields of a mapped event an operator needs to read a test result, and nothing of the body.
export function eventView(e: NormalizedInboundEvent): Record<string, unknown> {
  return {
    kind: e.kind,
    externalId: e.externalId,
    dedupeKey: e.dedupeKey,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.text !== undefined ? { text: e.text } : {}),
    ...(e.value !== undefined ? { value: e.value } : {}),
    ...(e.currency !== undefined ? { currency: e.currency } : {}),
  };
}

export interface ReceiveParams {
  routeToken: string;
  rawBody: string;
  getHeader: (name: string) => string | null;
  // The webhook URL's query string, which a signed message may cover (Mercado Pago signs the
  // `data.id` it carries).
  getQuery?: (name: string) => string | null;
  base?: PrismaClient;
  // Injectable for tests; defaults to the app logger. The refusal reason is the observable effect
  // of a 401 here (the response is uniform by design), so a test that cannot read it is testing a
  // proxy for the fix rather than the fix.
  deps?: { logger?: InboundLogger };
  probe?: InboundProbe;
}

export async function receiveInbound(
  params: ReceiveParams,
): Promise<ReceiveResult> {
  const base = params.base ?? basePrisma;
  const log = params.deps?.logger ?? logger;
  const route = await resolveInboundRouteByToken(params.routeToken, base);
  // Unknown token, disabled instance, and bad auth all return the SAME 401 (no oracle for
  // which tokens are live). The hash lookup is the constant-time part.
  if (!route?.enabled) {
    logRejection(log, route ? "route_disabled" : "route_unknown", route);
    throw new UnauthorizedError();
  }
  return receiveOnRoute(route, params);
}

// Everything after the route is known: the receptor's own path, and the one a test reception runs
// (which resolves the route by id, for its own tenant, instead of by token).
export async function receiveOnRoute(
  route: ResolvedInboundRoute,
  params: Omit<ReceiveParams, "routeToken">,
): Promise<ReceiveResult> {
  const base = params.base ?? basePrisma;
  const log = params.deps?.logger ?? logger;
  const probe = params.probe;
  const note = (stage: InboundStage) => {
    probe?.stages.push(stage);
  };
  const dry = probe?.dryRun === true;
  const recordFailed = async (
    payload: Record<string, unknown>,
    dedupeKeyOverride?: string,
  ) => {
    note({
      stage: "record",
      ok: true,
      detail: { recordedAs: "FAILED", dryRun: dry },
    });
    return dry
      ? undefined
      : persistFailed(base, route, params.rawBody, payload, dedupeKeyOverride);
  };
  const recordRow = async (row: Parameters<typeof persistRow>[2]) => {
    note({
      stage: "record",
      ok: true,
      detail: { recordedAs: "PENDING", dryRun: dry },
    });
    return dry
      ? { id: undefined, duplicate: false }
      : persistRow(base, route, row);
  };

  // The vault's three-state answer, not a value: "no such entry" and "never filled" are different
  // problems with different fixes, and collapsing them (as tryResolveVaultSecret does, correctly,
  // for "can I use this?") is what left the operator with nothing to act on.
  let secret: InboundSecretResolution = null;
  if (route.inboundAuthStrategy !== "NONE" && route.inboundSecretRef) {
    const ref = route.inboundSecretRef;
    secret = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      resolveVaultRefState<unknown>(db, ref),
    );
  }
  const auth = verifyInboundAuth({
    strategy: route.inboundAuthStrategy,
    secret,
    rawBody: params.rawBody,
    getHeader: params.getHeader,
    getQuery: params.getQuery,
    config: resolveInboundAuthConfig(route.catalogType, route.config),
  });
  note(
    auth.ok
      ? { stage: "signature", ok: true }
      : { stage: "signature", ok: false, reason: auth.reason },
  );
  if (!auth.ok) {
    logRejection(log, auth.reason, route);
    throw new UnauthorizedError();
  }

  // Authenticated past this point — a malformed body is a 400 (caller's bug), not a 401.
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    note({ stage: "mapping", ok: false, reason: "invalid JSON body" });
    throw new AppError("invalid JSON body", 400);
  }

  // A GENERIC instance with a consult-back takes the gateway's own thin notification: it is stored
  // as a notice naming one resource id, and the event is built later from the provider's answer
  // about that id (processInboundDelivery), so nothing here correlates or maps.
  const fetchBack =
    route.catalogType === "GENERIC"
      ? parseFetchBackConfig(route.config.fetchBack)
      : undefined;
  if (fetchBack !== undefined) {
    const resourceId = isFetchBackProblem(fetchBack)
      ? null
      : noticeResourceId(fetchBack, {
          parsedBody: parsed,
          getHeader: params.getHeader,
          getQuery: params.getQuery ?? (() => null),
        });
    // The writer refuses an id the signature does not vouch for, and this says it again: a row that
    // reached the table some other way (an import, a strategy changed later) must not look up an id
    // anyone can choose.
    const idUnsigned =
      resourceId !== null &&
      !isFetchBackProblem(fetchBack) &&
      route.inboundAuthStrategy === "HMAC_SHA256" &&
      !(fetchBack.idFrom.source === "body"
        ? signatureCoversBody(route.config.signature)
        : signatureCoversId(
            route.config.signature,
            fetchBack.idFrom.source,
            fetchBack.idFrom.name,
          ));
    if (resourceId === null || idUnsigned) {
      const issues = idUnsigned
        ? "fetch-back id not covered by the signed message"
        : isFetchBackProblem(fetchBack)
          ? `config.fetchBack.${fetchBack.field}`.replace(/\.$/, "")
          : "fetch-back id";
      logger.warn(
        "inbound: GENERIC notice names no usable resource id (instance %s): %s",
        String(route.id),
        issues,
      );
      note({
        stage: "mapping",
        ok: false,
        reason: "invalid",
        detail: { issues },
      });
      // Decided by the setting (an unusable lookup, an id the signature does not cover) or by an id
      // the request lacks, never by the body, which a manifest does not sign: one row per setting
      // and problem, however the replayed body varies.
      const id = await recordFailed(
        { reason: "invalid", issues },
        settingKey(`fetch-back-refused:${issues}`, route),
      );
      return {
        ack: true,
        deliveryId: id,
        tenantId: route.tenantId,
        outcome: "invalid",
      };
    }
    // The throttle counts what the signature vouches for: under `|lower`, `ABC` and `abc` are one
    // signed id and one lookup a window, whichever spelling arrived first.
    const lowered =
      !isFetchBackProblem(fetchBack) &&
      route.inboundAuthStrategy === "HMAC_SHA256" &&
      fetchBack.idFrom.source !== "body" &&
      signedLowered(
        route.config.signature,
        fetchBack.idFrom.source,
        fetchBack.idFrom.name,
      );
    const keyId = lowered ? resourceId.toLowerCase() : resourceId;
    note({ stage: "mapping", ok: true, detail: { lookup: resourceId } });
    if (probe) probe.planned = { kind: "notice", resourceId, keyId };
    note({
      stage: "record",
      ok: true,
      detail: { recordedAs: "PENDING", dryRun: dry },
    });
    if (dry) return { ack: true, tenantId: route.tenantId, outcome: "queued" };
    const notice = await persistNotice(base, route, resourceId, keyId);
    return {
      ack: true,
      deliveryId: notice.id,
      tenantId: route.tenantId,
      outcome: notice.duplicate ? "duplicate" : "queued",
      ...(notice.deferred ? { deferred: true } : {}),
    };
  }

  const mapper = getMapper(route.catalogType);
  if (!mapper) {
    logger.error(
      "inbound: no mapper registered for catalogType %s (instance %s)",
      route.catalogType,
      String(route.id),
    );
    note({ stage: "mapping", ok: false, reason: "no-mapper" });
    const id = await recordFailed({ reason: "no-mapper" });
    return {
      ack: true,
      deliveryId: id,
      tenantId: route.tenantId,
      outcome: "no-mapper",
    };
  }

  // Every mapper acts on the body (GENERIC takes the conversation and the text from it, a toolpack
  // its reference and amount), so a body the signature does not authenticate is not acted on,
  // however well the rest of the request is signed.
  if (
    route.inboundAuthStrategy === "HMAC_SHA256" &&
    !signatureCoversBody(route.config.signature)
  ) {
    logger.warn(
      "inbound: %s body not covered by the signed message (instance %s)",
      route.catalogType,
      String(route.id),
    );
    note({
      stage: "mapping",
      ok: false,
      reason: "invalid",
      detail: { issues: "body not covered by the signed message" },
    });
    // One row per instance and signature setting: the refusal depends on the setting, so every
    // request it refuses is the same problem, whatever unsigned body it carries.
    const id = await recordFailed(
      {
        reason: "invalid",
        issues: "body not covered by the signed message",
      },
      settingKey("uncovered-body", route),
    );
    return {
      ack: true,
      deliveryId: id,
      tenantId: route.tenantId,
      outcome: "invalid",
    };
  }

  const result = mapper.map(parsed);
  if (!result.ok) {
    // Deliberately-unhandled lifecycle events stay silent; schema drift must never be —
    // warn (ids/paths only, NEVER the body) + a durable FAILED record, the same fail-closed
    // mold as no-mapper. Without this, a dropped real payment is indistinguishable from noise.
    if (result.reason === "unhandled") {
      note({ stage: "mapping", ok: false, reason: "unhandled" });
      return { ack: true, outcome: "ignored" };
    }
    logger.warn(
      "inbound: %s payload failed the mapper schema (instance %s): %s",
      route.catalogType,
      String(route.id),
      result.detail ?? "unknown",
    );
    note({
      stage: "mapping",
      ok: false,
      reason: "invalid",
      ...(result.detail ? { detail: { issues: result.detail } } : {}),
    });
    const id = await recordFailed({
      reason: "invalid",
      ...(result.detail ? { issues: result.detail } : {}),
    });
    return {
      ack: true,
      deliveryId: id,
      tenantId: route.tenantId,
      outcome: "invalid",
    };
  }

  // An identity field the row cannot carry is NOT repaired or cut: `ref\u0000` repaired to
  // `ref` could match an unrelated conversation's ref and credit a payment there, and two ids could
  // collapse into one `dedupeKey`. It takes the fail-closed path instead (a durable FAILED record and
  // a 2xx, which stops the sender's retries). The payload, display only, IS repaired (below).
  const badIdentity =
    identityProblem(result.event.dedupeKey, "dedupeKey") ??
    identityProblem(result.event.externalId, "externalId");
  if (badIdentity) {
    logger.warn(
      "inbound: %s identity field cannot be stored (instance %s): %s",
      route.catalogType,
      String(route.id),
      badIdentity,
    );
    note({
      stage: "mapping",
      ok: false,
      reason: "unstorable-identity",
      detail: { issues: badIdentity },
    });
    const failedId = await recordFailed({
      reason: "unstorable-identity",
      issues: badIdentity,
    });
    return {
      ack: true,
      deliveryId: failedId,
      tenantId: route.tenantId,
      outcome: "invalid",
    };
  }

  note({ stage: "mapping", ok: true, detail: eventView(result.event) });

  // NOTE: A GENERIC delivery is correlated BEFORE the ack, so the sender learns a dead handle
  // from the response instead of from silence. Only the ref's existence is decided here; dispatch
  // re-correlates under its own claim, since the ref can go (instance deleted) in between.
  if (route.catalogType === "GENERIC") {
    const threadId = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      correlateConversationRef(db, {
        tenantId: route.tenantId,
        integrationInstanceId: route.id,
        ref: result.event.externalId,
      }),
    );
    note(
      threadId
        ? { stage: "correlation", ok: true, detail: { conversation: threadId } }
        : { stage: "correlation", ok: false, reason: "uncorrelated" },
    );
    if (!threadId) {
      logger.info(
        "inbound: GENERIC delivery uncorrelated (instance %s)",
        String(route.id),
      );
      return { ack: true, tenantId: route.tenantId, outcome: "uncorrelated" };
    }
  }

  if (probe) probe.planned = { kind: "event", event: result.event };
  const { id, duplicate } = await recordRow({
    externalId: result.event.externalId,
    dedupeKey: result.event.dedupeKey,
    payload: toStoredPayload(result.event),
  });
  return {
    ack: true,
    deliveryId: id,
    tenantId: route.tenantId,
    outcome: duplicate ? "duplicate" : "queued",
  };
}

// A durable, fail-closed record for a payload we authenticated but cannot process (no mapper
// registered, or the mapper's schema rejected it). `payload` is a small diagnostic object we
// build ({ reason, issues? }) — NEVER the raw body, which is PII-bearing. dedupeKey is a body
// digest so retries collapse; FAILED is terminal (the process claim never picks it up).
// The dedupe key of a refusal the instance's setting decides, not the body: a digest of the
// signature and lookup settings, so a changed setting files its own row once.
function settingKey(problem: string, route: ResolvedInboundRoute): string {
  const setting = JSON.stringify([
    route.config.signature ?? null,
    route.config.fetchBack ?? null,
  ]);
  return `${problem}:${createHash("sha256").update(setting).digest("hex")}`;
}

async function persistFailed(
  base: PrismaClient,
  route: ResolvedInboundRoute,
  rawBody: string,
  payload: Record<string, unknown>,
  // A refusal decided by the configuration alone, not by the body, dedupes on what decided it: keyed
  // on the body, a sender varying an unsigned body would file one FAILED row and one dead-letter per
  // variation of the same signed notification.
  dedupeKeyOverride?: string,
): Promise<bigint> {
  const dedupeKey =
    dedupeKeyOverride ??
    `raw:${createHash("sha256").update(rawBody).digest("hex")}`;
  const create = () =>
    runScopedOn(base, sysCtx(route.tenantId), (db) =>
      db.inboundDelivery.create({
        data: {
          tenantId: route.tenantId,
          integrationInstanceId: route.id,
          dedupeKey,
          payload: payload as Prisma.InputJsonValue,
          status: "FAILED",
        },
        select: { id: true },
      }),
    );
  // Announced only on a REAL insert: a provider retrying an unprocessable body lands on the
  // dedupe key and gets its row back, and announcing there would report one dropped event as many.
  // The emit is OUTSIDE the try: a throw inside it reads as "not a unique violation" and would turn a
  // persisted delivery into a 500 for the provider.
  let inserted: bigint | null = null;
  try {
    inserted = (await create()).id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      db.inboundDelivery.findFirst({
        where: { integrationInstanceId: route.id, dedupeKey },
        select: { id: true },
      }),
    );
    if (!existing) throw err;
    return existing.id;
  }
  emitDeadLetter({
    tenantId: route.tenantId,
    unit: "inbound_delivery",
    // NOTE: the event happened at the provider and the platform accepted it with a 2xx. It is gone.
    level: "error",
    error: `inbound payload not processable: ${String(payload.reason)}`,
    detail: {
      deliveryId: String(inserted),
      integrationInstanceId: String(route.id),
      catalogType: route.catalogType,
      // NOTE: `no-mapper`, `invalid`, `unstorable-identity` — a closed vocabulary this module
      // writes, and the three have different fixes. `issues` is the mapper's own diagnostic and
      // never the body (the raw body is only ever hashed into the dedupe key).
      reason: payload.reason,
      ...(payload.issues ? { issues: payload.issues } : {}),
    },
    base,
  });
  return inserted;
}

// create-then-catch across two transactions (a unique violation aborts its own transaction,
// so the existence re-read must run in a fresh one). Handles concurrent identical deliveries.
// The payload is REPAIRED before the write: Postgres `jsonb` refuses a lone surrogate and a NUL, and
// that refusal would be a 500 with no record while the sender retries forever. Identity fields are
// not repairable, and the caller has already turned those away.
async function persistInbound(
  base: PrismaClient,
  route: Pick<ResolvedInboundRoute, "id" | "tenantId">,
  n: NormalizedInboundEvent,
): Promise<{ id: bigint; duplicate: boolean }> {
  return persistRow(base, route, {
    externalId: n.externalId,
    dedupeKey: n.dedupeKey,
    payload: toStoredPayload(n),
  });
}

async function persistRow(
  base: PrismaClient,
  route: Pick<ResolvedInboundRoute, "id" | "tenantId">,
  n: {
    externalId: string | null;
    dedupeKey: string;
    payload: Record<string, unknown>;
  },
): Promise<{ id: bigint; duplicate: boolean }> {
  const payload = makeStorableDeep(n.payload);
  try {
    const created = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      db.inboundDelivery.create({
        data: {
          tenantId: route.tenantId,
          integrationInstanceId: route.id,
          externalId: n.externalId,
          dedupeKey: n.dedupeKey,
          payload: payload as Prisma.InputJsonValue,
          status: "PENDING",
        },
        select: { id: true },
      }),
    );
    return { id: created.id, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      db.inboundDelivery.findFirst({
        where: { integrationInstanceId: route.id, dedupeKey: n.dedupeKey },
        select: { id: true },
      }),
    );
    if (!existing) throw err;
    return { id: existing.id, duplicate: true };
  }
}

// One lookup per resource per window, keyed by the id the signature vouches for and never by the
// body (which a manifest like Mercado Pago's leaves unsigned, so a replay with other whitespace would
// otherwise be a fresh lookup each time). A notice arriving after its window's lookup was taken is
// not dropped: it books the next window's lookup, run by a job at the window's start, since the
// payment may have moved since the last answer (a gateway can send one bare body for successive
// states). At most two lookups a window per id, and no state change left unasked.
export const NOTICE_WINDOW_MS = 60_000;

async function persistNotice(
  base: PrismaClient,
  route: Pick<ResolvedInboundRoute, "id" | "tenantId">,
  resourceId: string,
  keyId: string,
  now = Date.now(),
): Promise<{ id: bigint; duplicate: boolean; deferred: boolean }> {
  const win = Math.floor(now / NOTICE_WINDOW_MS);
  const row = (w: number, payload: Record<string, unknown> = {}) =>
    persistRow(base, route, {
      externalId: null,
      dedupeKey: `notice:${keyId}:${w}`,
      // `keyId` too: the id as the signature vouches for it (lowercased under `|lower`), which the
      // event key falls back to, so a case variant in a later window is the same event.
      payload: { kind: FETCH_BACK_KIND, resourceId, keyId, ...payload },
    });
  const current = await row(win);
  if (!current.duplicate) return { ...current, deferred: false };
  const status = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
    db.inboundDelivery.findUnique({
      where: { id: current.id },
      select: { status: true },
    }),
  );
  // Not looked up yet: that lookup will see whatever this notice is about.
  if (status?.status === "PENDING") return { ...current, deferred: false };
  const runAt = new Date((win + 1) * NOTICE_WINDOW_MS);
  const next = await row(win + 1, { notBefore: runAt.toISOString() });
  if (!next.duplicate) {
    await runScopedOn(base, sysCtx(route.tenantId), (db) =>
      upsertJobRows(db, {
        tenantId: route.tenantId,
        kind: "INBOUND_REDISPATCH",
        rearm: "once",
        runAt,
        rows: [
          {
            dedupeKey: redispatchKey(next.id, 0),
            payload: { deliveryId: String(next.id) },
          },
        ],
      }),
    );
  }
  return { ...next, deferred: true };
}

// How a nudge turn can end having done what it was for: a message, a template, a note to the person
// holding the conversation, or the agent deciding to say nothing (`silent`) or to wait (`deferred`).
// The rest reached no one: the conversation is not the bot's, Chatwoot or the agent is unavailable,
// the month's spend ceiling, no conversation or no agent.
const NUDGE_REACHED: ReadonlySet<RunAgentNudgeOutcome> = new Set([
  "messaged",
  "templated",
  "noted",
  "noted-window",
  "silent",
  "deferred",
]);

export interface ProcessDeps {
  // Injectable for tests; defaults to the real LangGraph nudge runtime.
  runNudge?: typeof runAgentNudge;
  // Injectable for tests; defaults to running the instance's HTTP tool.
  runFetchBack?: typeof runFetchBack;
  runtime?: RuntimeDeps;
}

export interface ProcessParams {
  deliveryId: bigint;
  tenantId: bigint;
  base?: PrismaClient;
  deps?: ProcessDeps;
  // The deadline of the scheduler job running this, when one is (the inbound sweep's re-dispatch).
  // Handed to the nudge turn so a run past its deadline stops instead of finishing
  // beside the retry the sweep may arm once the claim goes stale. The route passes none.
  signal?: AbortSignal;
  // A test reception's stages (./test-reception.ts): what processing found, recorded as it goes.
  stages?: InboundStage[];
}

function buildNudge(
  payload: Record<string, unknown>,
  source: string,
  instanceConfig: Record<string, unknown>,
  // WHICH OCCASION THIS IS, and the delivery row is the answer: one row is one event, a redelivery
  // of that row is the same event, and two events on one conversation are two rows. Nothing else in
  // this descriptor separates them — an inbound nudge carries no `step` and no `refs`, so two
  // distinct deliveries would otherwise describe themselves identically and the second, refused by
  // the spend ceiling inside the first's window, would lose its flow line and its alert.
  deliveryId: bigint,
  // Which instance spoke, so the conversation can name it.
  integrationInstanceId: bigint,
): AgentNudge {
  return {
    source,
    kind: "agent_nudge",
    template: { kind: "inbound_event" },
    occasionId: `delivery:${deliveryId}`,
    integrationInstanceId: String(integrationInstanceId),
    status: asString(payload.status) ?? null,
    value: typeof payload.value === "number" ? payload.value : null,
    currency: asString(payload.currency) ?? null,
    summary: asString(payload.summary) ?? null,
    // NOTE: for GENERIC, the sender's own text is relayed rather than followed up on, with the
    // operator's guidance for this instance. The guidance is TRUSTED operator text and travels in
    // the instructions lane; the text stays fenced.
    ...(source === "GENERIC"
      ? {
          text: asString(payload.text) ?? null,
          framing: "operator_event" as const,
          ...(asString(instanceConfig.instructions)?.trim()
            ? { instructions: asString(instanceConfig.instructions)?.trim() }
            : {}),
        }
      : {}),
  };
}

type ProcessPlan =
  | { kind: "skip" }
  | { kind: "done" }
  | {
      kind: "fetch";
      resourceId: string;
      keyId: string;
      integrationInstanceId: bigint;
      instanceConfig: Record<string, unknown>;
    }
  | {
      kind: "nudge";
      threadId: string;
      nudge: AgentNudge;
      // GENERIC events reach a conversation the bot itself resolved.
      deliverToResolved: boolean;
    };

// Two phases. Phase A (one tx): CAS claim + read + DB-only effects (conversion/status_update),
// marking PROCESSED inside the same tx so the effect and processedAt commit together. For
// agent_nudge it ONLY correlates the thread (DB read) and leaves the row PROCESSING; the network
// turn cannot run inside the tx. Phase B (no tx): run the nudge, then mark PROCESSED.
export async function processInboundDelivery(
  params: ProcessParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;
  // Set inside the claim below, emitted AFTER it commits: a line written from inside the
  // scope would survive a rollback of the very write it reports.
  let exhausted: bigint | null | undefined;
  const plan: ProcessPlan = await runScopedOn(
    base,
    sysCtx(params.tenantId),
    async (db) => {
      // NOTE: CAS: claim PENDING, OR reclaim a PROCESSING row whose claim went stale (only
      // agent_nudge leaves a window between Phase A and Phase B). `attempts` bounds poison
      // redeliveries. Staleness is measured from the CURRENT claim (`claimedAt`), since `receivedAt`
      // is never refreshed.

      // A row with no `claimedAt` was claimed by a replica that does not stamp, and reading it
      // as stale would take a live claim, so it falls back to `receivedAt`. The fallback stops being
      // reachable once every replica stamps, and it is what lets the column ship in one release
      // instead of the two an expand/contract would need.
      const stale = staleClaim();
      const claimed = await db.inboundDelivery.updateMany({
        where: {
          id: params.deliveryId,
          attempts: { lt: MAX_PROCESS_ATTEMPTS },
          OR: [{ status: "PENDING" }, { status: "PROCESSING", OR: [...stale] }],
        },
        data: {
          status: "PROCESSING",
          attempts: { increment: 1 },
          claimedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        // Either not reclaimable (done / freshly PROCESSING) or the attempt cap is exhausted,
        // which moves it to a terminal FAILED. The PROCESSING half carries the SAME staleness rule
        // as the claim: the last attempt, running RIGHT NOW, is `attempts = MAX`, and a duplicate
        // webhook must not dead-letter work still in flight.
        const killed = await db.inboundDelivery.updateMany({
          where: {
            id: params.deliveryId,
            attempts: { gte: MAX_PROCESS_ATTEMPTS },
            OR: [
              { status: "PENDING" },
              { status: "PROCESSING", OR: [...stale] },
            ],
          },
          data: { status: "FAILED" },
        });
        // NOTE: the count separates the two cases the branch above collapses, and only one of them
        // is a death: a row that was simply not reclaimable (already processed, freshly claimed by
        // another replica, or still being worked on) matched nothing here and is not a loss.
        if (killed.count > 0) {
          const row = await db.inboundDelivery.findUnique({
            where: { id: params.deliveryId },
            select: { integrationInstanceId: true },
          });
          exhausted = row?.integrationInstanceId ?? null;
        }
        return { kind: "skip" };
      }

      const delivery = await db.inboundDelivery.findUniqueOrThrow({
        where: { id: params.deliveryId },
        select: {
          id: true,
          externalId: true,
          payload: true,
          integrationInstanceId: true,
          integrationInstance: { select: { catalogType: true, config: true } },
        },
      });
      const payload = (delivery.payload ?? {}) as Record<string, unknown>;
      const kind = payload.kind as InboundEventKind | undefined;
      const source = delivery.integrationInstance.catalogType;
      const instanceConfig = (delivery.integrationInstance.config ??
        {}) as Record<string, unknown>;

      const markProcessed = () =>
        db.inboundDelivery.update({
          where: { id: params.deliveryId },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

      if ((kind as string) === FETCH_BACK_KIND) {
        const resourceId = asString(payload.resourceId);
        if (resourceId) {
          return {
            kind: "fetch",
            resourceId,
            keyId: asString(payload.keyId) ?? resourceId,
            integrationInstanceId: delivery.integrationInstanceId,
            instanceConfig,
          };
        }
      }

      if (kind === "conversion") {
        const corr = await dispatchConversion(
          db,
          params.tenantId,
          delivery.externalId,
          source,
          payload,
          delivery.integrationInstanceId,
        );
        params.stages?.push(
          corr
            ? {
                stage: "correlation",
                ok: true,
                detail: {
                  conversation: corr.threadId,
                  recorded: corr.recorded,
                },
              }
            : { stage: "correlation", ok: false, reason: "uncorrelated" },
        );
        // Notify the customer that the payment went through, when the integration opts in (default
        // ON) AND the conversion was FRESHLY recorded. The ConversionEvent is the durable
        // idempotency barrier; the nudge is best-effort (Phase B, with an assignee re-check). A
        // redelivery (conversion already recorded → corr.recorded false) never re-notifies, so this
        // is at-most-once: the residual is a missed nudge, never a wrong-thread or double message.
        const notify = instanceConfig.notifyOnPayment !== false;
        if (corr?.recorded && notify) {
          return {
            kind: "nudge",
            // A GENERIC conversion (a lookup's paid status) reaches a conversation the bot itself
            // resolved, like every GENERIC event: the agent closing after sending the charge is the
            // ordinary case.
            deliverToResolved: source === "GENERIC",
            threadId: corr.threadId,
            nudge: buildNudge(
              payload,
              source,
              instanceConfig,
              params.deliveryId,
              delivery.integrationInstanceId,
            ),
          };
        }
        await markProcessed();
        return { kind: "done" };
      }

      if (kind === "agent_nudge") {
        // Correlate externalId → thread here (DB); defer the network turn to Phase B. An
        // uncorrelated nudge has nothing to act on — mark processed and stop.
        //
        // A GENERIC ref correlates only on the instance that minted it; every other source keeps
        // its toolpack's refs and never reads a `conversation_ref`.
        const generic = source === "GENERIC";
        const threadId = !delivery.externalId
          ? null
          : generic
            ? await correlateConversationRef(db, {
                tenantId: params.tenantId,
                integrationInstanceId: delivery.integrationInstanceId,
                ref: delivery.externalId,
              })
            : await toolpackRefThread(db, params.tenantId, delivery.externalId);
        params.stages?.push(
          threadId
            ? {
                stage: "correlation",
                ok: true,
                detail: { conversation: threadId },
              }
            : { stage: "correlation", ok: false, reason: "uncorrelated" },
        );
        if (!threadId) {
          logger.info(
            "inbound agent_nudge uncorrelated (source=%s); dropping",
            source,
          );
          await markProcessed();
          return { kind: "done" };
        }
        return {
          kind: "nudge",
          threadId,
          deliverToResolved: generic,
          nudge: buildNudge(
            payload,
            source,
            instanceConfig,
            params.deliveryId,
            delivery.integrationInstanceId,
          ),
        };
      }

      if (kind === "status_update") {
        // TODO(fase-6): reconcile the Conversation mirror from a status_update. No-op for now.
        logger.info(
          "inbound: status_update no-op delivery=%s",
          String(delivery.id),
        );
      } else {
        logger.warn(
          "inbound: unknown normalized kind on delivery %s",
          String(delivery.id),
        );
      }
      await markProcessed();
      return { kind: "done" };
    },
  );

  // NOTE: the row exhausted its processing budget and is terminally FAILED: the provider's event
  // was accepted with a 2xx and will never be acted on.
  if (exhausted !== undefined) {
    emitDeadLetter({
      tenantId: params.tenantId,
      unit: "inbound_delivery",
      level: "error",
      error: `inbound delivery exhausted ${MAX_PROCESS_ATTEMPTS} processing attempts`,
      detail: {
        deliveryId: String(params.deliveryId),
        ...(exhausted !== null
          ? { integrationInstanceId: String(exhausted) }
          : {}),
        reason: "attempts-exhausted",
      },
      base,
    });
  }

  if (plan.kind === "skip") return "skipped";
  if (plan.kind === "done") return "processed";
  if (plan.kind === "fetch") {
    return await consultBack(params, base, plan);
  }

  // Phase B: agent_nudge network turn outside the tx, then mark PROCESSED. BEST-EFFORT: the
  // outcome is not consulted, since the durable barrier is the ConversionEvent from Phase A. A
  // failed or refused nudge still ends PROCESSED, so neither the sweep nor a redelivery re-runs it
  // (the gap is recorded in docs/integrations.md).
  const runNudge = params.deps?.runNudge ?? runAgentNudge;
  // Armed from here, right after the claim committed, which is the instant the stale window started.
  const signal = params.signal ?? AbortSignal.timeout(DISPATCH_DEADLINE_MS);
  try {
    const outcome = await runNudge({
      tenantId: params.tenantId,
      threadId: plan.threadId,
      nudge: plan.nudge,
      deliverToResolved: plan.deliverToResolved,
      base,
      deps: params.deps?.runtime,
      signal,
    });
    // A test reception reads how the turn ended, which the row does not record (it ends PROCESSED
    // either way): a turn that reached no one is not a green run.
    params.stages?.push(
      NUDGE_REACHED.has(outcome)
        ? { stage: "agent", ok: true, detail: { outcome } }
        : { stage: "agent", ok: false, reason: outcome },
    );
  } catch (err) {
    logger.warn(
      { err, threadId: plan.threadId },
      "agentNudge dispatch failed; marking delivery processed anyway",
    );
    params.stages?.push({
      stage: "agent",
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.inboundDelivery.update({
      where: { id: params.deliveryId },
      data: { status: "PROCESSED", processedAt: new Date() },
    }),
  );
  return "processed";
}

// Phase B of a consult-back notice: run the instance's tool for the id, map the provider's answer,
// and hand the resulting event to this same function as its own delivery. The event row's dedupe
// key (`<id>:<status>` by default) is what collapses `payment.created`/`payment.updated` and the
// sender's retries into one event, so a notice that maps to an event already recorded ends here. A
// failure the same id may answer later (network, 5xx) throws, leaving the claim for the sweep's
// re-dispatch under the attempt cap; one that would answer the same ends FAILED with its reason.
async function consultBack(
  params: ProcessParams,
  base: PrismaClient,
  plan: Extract<ProcessPlan, { kind: "fetch" }>,
): Promise<"processed" | "skipped"> {
  const finish = (status: "PROCESSED" | "FAILED") =>
    runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.inboundDelivery.update({
        where: { id: params.deliveryId },
        data: { status, processedAt: new Date() },
      }),
    );
  const fail = async (reason: string) => {
    logger.warn(
      { deliveryId: String(params.deliveryId), reason },
      "inbound: consult-back could not build an event",
    );
    await finish("FAILED");
    emitDeadLetter({
      tenantId: params.tenantId,
      unit: "inbound_delivery",
      level: "error",
      error: `inbound consult-back failed: ${reason}`,
      detail: {
        deliveryId: String(params.deliveryId),
        integrationInstanceId: String(plan.integrationInstanceId),
        catalogType: "GENERIC",
        reason: "fetch-back",
      },
      base,
    });
    return "processed" as const;
  };
  // Bounded by the delivery's deadline, as the nudge is: the scheduler's job signal, or the route's
  // window from the claim. A lookup past it leaves the claim for the sweep instead of writing an
  // event after the stale window opened, or handing its turn a signal already aborted.
  const deadline = params.signal ?? AbortSignal.timeout(DISPATCH_DEADLINE_MS);
  const looked = await new Promise<Awaited<ReturnType<typeof lookUpNotice>>>(
    (resolve, reject) => {
      const stop = () =>
        reject(new Error("inbound consult-back passed the delivery deadline"));
      if (deadline.aborted) return stop();
      deadline.addEventListener("abort", stop, { once: true });
      lookUpNotice({
        base,
        tenantId: params.tenantId,
        instanceConfig: plan.instanceConfig,
        resourceId: plan.resourceId,
        keyId: plan.keyId,
        run: params.deps?.runFetchBack,
        signal: deadline,
      })
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener("abort", stop));
    },
  );
  const note = (stage: InboundStage) => params.stages?.push(stage);
  if (looked.kind !== "mapped") {
    note({
      stage: "fetch_back",
      ok: false,
      reason: looked.reason,
      ...(looked.kind === "fetch_failed"
        ? { detail: { retried: looked.retry } }
        : {}),
    });
  } else {
    note({ stage: "fetch_back", ok: true });
  }
  if (looked.kind === "unusable") return await fail(looked.reason);
  if (looked.kind === "fetch_failed") {
    if (looked.retry) {
      throw new Error(`inbound consult-back will be retried: ${looked.reason}`);
    }
    return await fail(looked.reason);
  }
  const mapped = looked.result;
  const badIdentity = mapped.ok
    ? (identityProblem(mapped.event.dedupeKey, "dedupeKey") ??
      identityProblem(mapped.event.externalId, "externalId"))
    : null;
  note(
    !mapped.ok
      ? {
          stage: "mapping",
          ok: false,
          reason: mapped.reason,
          ...(mapped.detail ? { detail: { missing: mapped.detail } } : {}),
        }
      : badIdentity
        ? {
            stage: "mapping",
            ok: false,
            reason: "unstorable-identity",
            detail: { issues: badIdentity },
          }
        : { stage: "mapping", ok: true, detail: eventView(mapped.event) },
  );
  if (!mapped.ok) {
    if (mapped.reason === "unhandled") {
      await finish("PROCESSED");
      return "processed";
    }
    return await fail(
      `the provider's answer has no ${mapped.detail ?? "usable fields"}`,
    );
  }
  if (badIdentity) return await fail(badIdentity);
  if (deadline.aborted) {
    throw new Error("inbound consult-back passed the delivery deadline");
  }
  const route = { id: plan.integrationInstanceId, tenantId: params.tenantId };
  const event = await persistInbound(base, route, mapped.event);
  await finish("PROCESSED");
  if (event.duplicate) return "processed";
  return await processInboundDelivery({ ...params, deliveryId: event.id });
}

// One consult-back: the instance's tool run for the id and its answer mapped. Shared by the delivery
// (consultBack) and a test reception, so what the test shows is what a delivery does.
export async function lookUpNotice(params: {
  base: PrismaClient;
  tenantId: bigint;
  instanceConfig: Record<string, unknown>;
  resourceId: string;
  // The id as the signature vouches for it (the notice's key), which the event key falls back to.
  keyId?: string;
  run?: typeof runFetchBack;
  // The delivery's deadline, handed to the request itself.
  signal?: AbortSignal;
  readOnly?: boolean;
}): Promise<
  | { kind: "unusable"; reason: string }
  | {
      kind: "fetch_failed";
      retry: boolean;
      reason: string;
      refusedMethod?: string;
    }
  | { kind: "mapped"; result: MapResult }
> {
  const cfg = parseFetchBackConfig(params.instanceConfig.fetchBack);
  if (cfg === undefined || isFetchBackProblem(cfg)) {
    return {
      kind: "unusable",
      reason: "the instance no longer has a usable consult-back",
    };
  }
  const fetched = await (params.run ?? runFetchBack)({
    base: params.base,
    tenantId: params.tenantId,
    toolId: cfg.toolId,
    idArg: cfg.idArg,
    resourceId: params.resourceId,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.readOnly ? { readOnly: true } : {}),
  });
  if (!fetched.ok) {
    return {
      kind: "fetch_failed",
      retry: fetched.retry,
      reason: fetched.reason,
      ...(fetched.refusedMethod
        ? { refusedMethod: fetched.refusedMethod }
        : {}),
    };
  }
  return {
    kind: "mapped",
    result: mapFetchedResource(
      cfg,
      params.keyId ?? params.resourceId,
      fetched.response,
    ),
  };
}

// Correlate externalId → thread via the ref created at outbound time, then record the
// conversion idempotently (ON CONFLICT DO NOTHING keeps the surrounding tx alive). An
// uncorrelated or duplicate conversion is dropped with a log, never invented. Returns the
// correlated thread + whether the conversion was FRESHLY recorded, so the caller can decide
// whether to notify the customer (only on a fresh record, never on a redelivery). Null when
// there is nothing to correlate to.
async function dispatchConversion(
  db: ScopedDb,
  tenantId: bigint,
  externalId: string | null,
  source: string,
  payload: Record<string, unknown>,
  integrationInstanceId: bigint,
): Promise<{ threadId: string; recorded: boolean } | null> {
  if (!externalId) {
    logger.info("inbound conversion without externalId; dropping");
    return null;
  }
  // A GENERIC conversion (built by a consult-back) correlates like every GENERIC event: only on a
  // ref this instance minted.
  const refThreadId =
    source === "GENERIC"
      ? await correlateConversationRef(db, {
          tenantId,
          integrationInstanceId,
          ref: externalId,
        })
      : await toolpackRefThread(db, tenantId, externalId);
  if (!refThreadId) {
    logger.info(
      "inbound conversion uncorrelated (source=%s); dropping",
      source,
    );
    return null;
  }
  const value = typeof payload.value === "number" ? payload.value : null;
  const currency = asString(payload.currency) ?? null;
  const occurredAt = asString(payload.occurredAt);
  const result = await db.conversionEvent.createMany({
    data: [
      {
        tenantId,
        threadId: refThreadId,
        source,
        value,
        currency,
        metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        ...(occurredAt ? { occurredAt: new Date(occurredAt) } : {}),
      },
    ],
    skipDuplicates: true,
  });
  if (result.count === 0) {
    logger.info(
      "inbound conversion already recorded (thread=%s source=%s)",
      refThreadId,
      source,
    );
  }
  return { threadId: refThreadId, recorded: result.count > 0 };
}

// The thread a toolpack's own correlation id points at (an Asaas payment's `externalReference`, a
// Resend email id). A `conversation_ref` is NOT one of them: it is a handle minted for one GENERIC
// instance, and a payment carrying it as its reference must not credit a conversion (and nudge the
// customer) through a door it was never handed to.
export async function toolpackRefThread(
  db: ScopedDb,
  tenantId: bigint,
  externalId: string,
): Promise<string | null> {
  const ref = await db.integrationExternalRef.findUnique({
    where: { tenantId_externalId: { tenantId, externalId } },
    select: { threadId: true, kind: true },
  });
  if (!ref || ref.kind === CONVERSATION_REF_KIND) return null;
  return ref.threadId;
}
