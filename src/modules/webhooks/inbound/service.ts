import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, runAgentNudge } from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { makeStorableDeep, unstorableProblem } from "@/lib/text";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import { getMapper } from "@/modules/integrations/mappers";
import {
  type ResolvedInboundRoute,
  resolveInboundRouteByToken,
} from "@/modules/integrations/service";
import type {
  InboundEventKind,
  NormalizedInboundEvent,
} from "@/modules/integrations/types";
import { resolveVaultRefState } from "@/modules/vault/service";
import {
  type InboundAuthFailure,
  type InboundSecretResolution,
  resolveInboundAuthConfig,
  verifyInboundAuth,
} from "./auth";

// Generic inbound receptor. Resolve tenant by route token → verify the per-instance auth
// strategy (tenant-scoped secret) → normalize via the integration's pure mapper → persist an
// idempotent InboundDelivery (allowlisted payload) → ack fast. processInboundDelivery runs
// async (detached by the controller) and dispatches to the CLOSED set of domain events.

// A PROCESSING row older than this is presumed stranded by a crash and may be reclaimed (normal
// processing completes within seconds of receipt). Attempts are capped to stop poison loops.
const PROCESSING_STALE_MS = 5 * 60_000;
const MAX_PROCESS_ATTEMPTS = 5;

// What an identity field is allowed to be, and it is a REFUSAL rather than a truncation: cutting an
// identity is the same lossy-identity defect as repairing one. Measured against this database, a
// `dedupeKey` that does not compress fails its own unique index at ~2704 bytes ("index row size
// 6432 exceeds btree version 4 maximum 2704"), which is the same 500-with-no-record as an
// unstorable character, reached by a different road. 512 characters is far above any provider id
// (Asaas sends ~20, and the mapper already caps `externalReference` at 128) and far below the index
// limit even if every character were 4 bytes.
const MAX_IDENTITY_CHARS = 512;

// The two things an identity field must be for the row to exist: storable, and short enough for the
// index that enforces idempotency on it. Same verdict shape as `unstorableProblem`, whose message
// this passes through, because the caller does the same thing with either answer.
function identityProblem(value: string, what: string): string | null {
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
// my URL even right?" before "is my token right?", and both used to be the same silent throw.
type InboundRejection = "route_unknown" | "route_disabled" | InboundAuthFailure;

// The refusal, recorded where the operator can find it. The RESPONSE stays uniform on purpose (no
// oracle for which route tokens are live), and that argument covers the response, not the server's
// own record: without this line an unresolvable ref, an unfilled secret and a genuinely wrong token
// are the same event in every log we keep, which is issue #124. Carries ids and the vault REF
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

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
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
  if (n.metadata !== undefined) p.metadata = n.metadata;
  if (n.occurredAt) p.occurredAt = n.occurredAt.toISOString();
  return p;
}

export interface ReceiveResult {
  ack: true;
  deliveryId?: bigint;
  tenantId?: bigint;
  outcome: "queued" | "duplicate" | "ignored" | "no-mapper" | "invalid";
}

export interface ReceiveParams {
  routeToken: string;
  rawBody: string;
  getHeader: (name: string) => string | null;
  base?: PrismaClient;
  // Injectable for tests; defaults to the app logger. The refusal reason is the observable effect
  // of a 401 here (the response is uniform by design), so a test that cannot read it is testing a
  // proxy for the fix rather than the fix.
  deps?: { logger?: InboundLogger };
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
    config: resolveInboundAuthConfig(route.catalogType, route.config),
  });
  if (!auth.ok) {
    logRejection(log, auth.reason, route);
    throw new UnauthorizedError();
  }

  // Authenticated past this point — a malformed body is a 400 (caller's bug), not a 401.
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    throw new AppError("invalid JSON body", 400);
  }

  const mapper = getMapper(route.catalogType);
  if (!mapper) {
    logger.error(
      "inbound: no mapper registered for catalogType %s (instance %s)",
      route.catalogType,
      String(route.id),
    );
    const id = await persistFailed(base, route, params.rawBody, {
      reason: "no-mapper",
    });
    return {
      ack: true,
      deliveryId: id,
      tenantId: route.tenantId,
      outcome: "no-mapper",
    };
  }

  const result = mapper.map(parsed);
  if (!result.ok) {
    // Deliberately-unhandled lifecycle events stay silent; schema drift must never be —
    // warn (ids/paths only, NEVER the body) + a durable FAILED record, the same fail-closed
    // mold as no-mapper. Without this, a dropped real payment is indistinguishable from noise.
    if (result.reason === "unhandled") return { ack: true, outcome: "ignored" };
    logger.warn(
      "inbound: %s payload failed the mapper schema (instance %s): %s",
      route.catalogType,
      String(route.id),
      result.detail ?? "unknown",
    );
    const id = await persistFailed(base, route, params.rawBody, {
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

  // An identity field the row cannot carry is NOT repaired or cut: both are lossy,
  // and lossy on an identity is how a payment lands in the wrong conversation. `ref\u0000` repaired
  // to `ref` MATCHES the ref an unrelated conversation registered, and `dispatchConversion` would
  // credit the conversion there and nudge that customer, the one outcome this module says it never
  // produces. Two distinct provider ids that differ only by such a character would likewise collapse
  // into one `dedupeKey` and silently drop a real delivery. So a malformed identity takes the
  // fail-closed path that already exists for a payload we cannot process: a durable FAILED record
  // and a 2xx, which is what stops the sender's retry loop. The payload itself is display and
  // diagnostics, and IS repaired (below).
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
    const failedId = await persistFailed(base, route, params.rawBody, {
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

  const { id, duplicate } = await persistInbound(base, route, result.event);
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
async function persistFailed(
  base: PrismaClient,
  route: ResolvedInboundRoute,
  rawBody: string,
  payload: Record<string, unknown>,
): Promise<bigint> {
  const dedupeKey = `raw:${createHash("sha256").update(rawBody).digest("hex")}`;
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
  // NOTE: announced only on a REAL insert (issue #356). A provider that retries an unprocessable
  // body lands on the dedupe key below and gets back the row it already has; announcing there would
  // report one dropped event as many, at whatever rate the provider retries.
  //
  // The emit is OUTSIDE the try, not merely after the create: `emitFlowEvent` is fire-and-forget
  // and cannot reject, but a throw from inside that try is read as "not a unique violation" and
  // rethrown, which would turn a delivery that WAS persisted into a 500 for the provider.
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
//
// The mapper is pure and knows nothing about columns; this is where its output becomes a row, so it
// is where a third party's characters have to survive the write. Measured against Postgres, the
// `jsonb` payload refuses a lone surrogate (`invalid input syntax for type json`) and a NUL (22P05),
// and the refusal escapes `receiveInbound`, which nothing above catches: a 500 with no delivery row
// and no FAILED record either, and a sender retrying a body that can never succeed. The payload is
// display and diagnostics, so it is REPAIRED. The identity fields, which the `text` columns refuse
// just as flatly (22021), are not repairable without changing what they identify, and the caller has
// already turned those away.
async function persistInbound(
  base: PrismaClient,
  route: ResolvedInboundRoute,
  n: NormalizedInboundEvent,
): Promise<{ id: bigint; duplicate: boolean }> {
  const payload = makeStorableDeep(toStoredPayload(n));
  try {
    const row = await runScopedOn(base, sysCtx(route.tenantId), (db) =>
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
    return { id: row.id, duplicate: false };
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

export interface ProcessDeps {
  // Injectable for tests; defaults to the real LangGraph nudge runtime.
  runNudge?: typeof runAgentNudge;
  runtime?: RuntimeDeps;
}

export interface ProcessParams {
  deliveryId: bigint;
  tenantId: bigint;
  base?: PrismaClient;
  deps?: ProcessDeps;
}

function buildNudge(
  payload: Record<string, unknown>,
  source: string,
): AgentNudge {
  return {
    source,
    kind: "agent_nudge",
    status: asString(payload.status) ?? null,
    value: typeof payload.value === "number" ? payload.value : null,
    currency: asString(payload.currency) ?? null,
    summary: asString(payload.summary) ?? null,
  };
}

type ProcessPlan =
  | { kind: "skip" }
  | { kind: "done" }
  | { kind: "nudge"; threadId: string; nudge: AgentNudge };

// Two phases. Phase A (one tx): CAS claim + read + DB-only effects (conversion/status_update),
// marking PROCESSED inside the same tx so the effect and processedAt commit together. For
// agent_nudge it ONLY correlates the thread (DB read) and leaves the row PROCESSING; the network
// turn cannot run inside the tx. Phase B (no tx): run the nudge, then mark PROCESSED.
export async function processInboundDelivery(
  params: ProcessParams,
): Promise<"processed" | "skipped"> {
  const base = params.base ?? basePrisma;
  // NOTE: set inside the claim below, emitted AFTER it commits: a line written from inside the
  // scope would survive a rollback of the very write it reports.
  let exhausted: bigint | null | undefined;
  const plan: ProcessPlan = await runScopedOn(
    base,
    sysCtx(params.tenantId),
    async (db) => {
      // CAS: claim PENDING, OR reclaim a PROCESSING row stranded by a crash (its effect never
      // committed — only agent_nudge leaves a window between Phase A and Phase B; DB-only kinds
      // commit effect+PROCESSED atomically). `attempts` bounds poison redeliveries: past the cap
      // the row is marked FAILED instead of looping. (A periodic sweeper is added with the
      // scheduler; until then a redelivery reclaims a stranded row.)
      const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MS);
      // NOTE: staleness is measured from the CURRENT claim, not from the delivery's receipt. That
      // distinction is the whole of it: `receivedAt` is stamped once and a claim never refreshes
      // it, so five minutes after a webhook arrives the row is permanently "stale" by that measure
      // and a duplicate delivery could take a row whose attempt was still running (issue #356).
      //
      // AN UNSTAMPED ROW FALLS BACK TO THE OLD RULE rather than reading as stale, and that is a
      // compatibility mechanism with a definite end, not a hedge. `docs/deploy.md` supports a
      // rolling pre-deploy over a scaled web tier, which is where inbound webhooks are served, so
      // the previous version keeps CLAIMING rows after the migration has run — a snapshot backfill
      // fences the rows that were PROCESSING at that instant and cannot fence the ones claimed a
      // second later. Reading those as stale would take a live claim.
      //
      // The fallback is exactly what shipped before this column, so a row the old code claimed is
      // judged no worse than it is today, and a row the new code claimed is judged correctly. It
      // stops being reachable once every replica stamps, and it is what makes this one release
      // instead of the two an expand/contract would need.
      const stale = [
        { claimedAt: { lt: staleCutoff } },
        { claimedAt: null, receivedAt: { lt: staleCutoff } },
      ] as const;
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
        // Either not reclaimable (done / freshly PROCESSING) or the attempt cap is exhausted —
        // in the latter case move it to a terminal FAILED so it stops being retried.
        //
        // NOTE: the PROCESSING half carries the SAME staleness rule the claim above does, and it
        // has to: the claim says a PROCESSING row is only takeable once its claim went stale, so
        // any other measure here would let this disagree with it about the same row. The last
        // attempt running RIGHT NOW is `attempts = MAX` and `PROCESSING`, and a duplicate webhook
        // arriving mid-flight would otherwise mark the delivery terminally FAILED under the
        // invocation still working on it — which then marks it PROCESSED over the top. Silent
        // before issue #356; announcing it is what made the disagreement visible, and a dead-letter
        // line about work still in flight is the one thing this announcement must never say.
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

      if (kind === "conversion") {
        const corr = await dispatchConversion(
          db,
          params.tenantId,
          delivery.externalId,
          source,
          payload,
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
            threadId: corr.threadId,
            nudge: buildNudge(payload, source),
          };
        }
        await markProcessed();
        return { kind: "done" };
      }

      if (kind === "agent_nudge") {
        // Correlate externalId → thread here (DB); defer the network turn to Phase B. An
        // uncorrelated nudge has nothing to act on — mark processed and stop.
        const ref = delivery.externalId
          ? await db.integrationExternalRef.findUnique({
              where: {
                tenantId_externalId: {
                  tenantId: params.tenantId,
                  externalId: delivery.externalId,
                },
              },
              select: { threadId: true },
            })
          : null;
        if (!ref) {
          logger.info(
            "inbound agent_nudge uncorrelated (source=%s); dropping",
            source,
          );
          await markProcessed();
          return { kind: "done" };
        }
        return {
          kind: "nudge",
          threadId: ref.threadId,
          nudge: buildNudge(payload, source),
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

  // NOTE: the row exhausted its processing budget and is terminally FAILED — the provider's event
  // was accepted with a 2xx and will never be acted on (issue #356).
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

  // Phase B: agent_nudge network turn outside the tx (best-effort), then mark PROCESSED.
  const runNudge = params.deps?.runNudge ?? runAgentNudge;
  try {
    await runNudge({
      tenantId: params.tenantId,
      threadId: plan.threadId,
      nudge: plan.nudge,
      base,
      deps: params.deps?.runtime,
    });
  } catch (err) {
    logger.warn(
      { err, threadId: plan.threadId },
      "agentNudge dispatch failed; marking delivery processed anyway",
    );
  }
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.inboundDelivery.update({
      where: { id: params.deliveryId },
      data: { status: "PROCESSED", processedAt: new Date() },
    }),
  );
  return "processed";
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
): Promise<{ threadId: string; recorded: boolean } | null> {
  if (!externalId) {
    logger.info("inbound conversion without externalId; dropping");
    return null;
  }
  const ref = await db.integrationExternalRef.findUnique({
    where: { tenantId_externalId: { tenantId, externalId } },
    select: { threadId: true },
  });
  if (!ref) {
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
        threadId: ref.threadId,
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
      ref.threadId,
      source,
    );
  }
  return { threadId: ref.threadId, recorded: result.count > 0 };
}
