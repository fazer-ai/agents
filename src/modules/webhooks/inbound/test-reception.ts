// "Test reception" in the integration editor: a sample notification pasted by the operator runs the
// receptor's own path for one instance (receiveOnRoute, the same code a delivery takes) and comes
// back as the list of stages it passed or stopped at. Dry-run, the default, writes nothing: no
// delivery row, no conversion, no message, and the lookup and the correlation are asked without a
// row. Without it the event goes through the normal delivery path. docs/integrations.md.

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { trackWork } from "@/lib/shutdown";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { correlateConversationRef } from "@/modules/integrations/conversation-ref";
import type { runFetchBack } from "@/modules/integrations/fetch-back-run";
import type { ResolvedInboundRoute } from "@/modules/integrations/service";
import type { NormalizedInboundEvent } from "@/modules/integrations/types";
import { resolveInboundAuthConfig } from "./auth";
import {
  eventView,
  type InboundProbe,
  type InboundStage,
  identityProblem,
  lookUpNotice,
  type ProcessDeps,
  processInboundDelivery,
  receiveOnRoute,
  toolpackRefThread,
} from "./service";
import {
  isSignatureConfigProblem,
  parseSignatureConfig,
  parseSignatureParts,
  renderSignedMessage,
} from "./signed-message";

export const TEST_RECEPTION_PER_MINUTE = 10;
export const TEST_BODY_MAX_CHARS = 64 * 1024;
const SHOWN_MESSAGE_MAX_CHARS = 2000;

export interface TestReceptionInput {
  body: string;
  headers?: Record<string, string>;
  // The query string of the webhook URL as the provider would send it, with or without the `?`.
  query?: string;
  dryRun?: boolean;
}

export interface TestReceptionResult {
  dryRun: boolean;
  outcome: string;
  stages: InboundStage[];
}

// Per tenant and per process: a test runs the operator's own lookup tool against the provider, so
// the bound is the provider's budget, which this keeps far from. Not shared across replicas.
const recent = new Map<string, number[]>();

function takeSlot(tenantId: bigint, now: number): boolean {
  const key = tenantId.toString();
  const window = (recent.get(key) ?? []).filter((at) => now - at < 60_000);
  if (window.length >= TEST_RECEPTION_PER_MINUTE) {
    recent.set(key, window);
    return false;
  }
  window.push(now);
  recent.set(key, window);
  return true;
}

async function routeOf(
  base: PrismaClient,
  ctx: TenantContext & { tenantId: bigint },
  id: bigint,
): Promise<ResolvedInboundRoute> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.integrationInstance.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        catalogType: true,
        enabled: true,
        inboundAuthStrategy: true,
        inboundSecretRef: true,
        config: true,
      },
    }),
  );
  if (!row) {
    throw new NotFoundError(
      "Integration instance not found",
      "errors.integrationInstanceNotFound",
    );
  }
  return { ...row, config: (row.config ?? {}) as Record<string, unknown> };
}

// What the gate read, for the operator: never the secret, and the signed message only as text the
// operator pasted (it signs with the secret, it does not contain it).
function signatureView(
  route: ResolvedInboundRoute,
  rawBody: string,
  getHeader: (n: string) => string | null,
  getQuery: (n: string) => string | null,
): Record<string, unknown> {
  const strategy = route.inboundAuthStrategy;
  if (strategy === "NONE") return { strategy };
  const cfg = resolveInboundAuthConfig(route.catalogType, route.config);
  const header =
    strategy === "STATIC_HEADER" ? cfg.authHeader : cfg.signatureHeader;
  const view: Record<string, unknown> = {
    strategy,
    header,
    headerPresent: getHeader(header) !== null,
  };
  if (strategy !== "HMAC_SHA256") return view;
  const sig = parseSignatureConfig(cfg.signature);
  if (sig === undefined) return { ...view, signedMessage: "{{body}}" };
  if (isSignatureConfigProblem(sig)) return view;
  const parts =
    sig.format === "parts"
      ? parseSignatureParts(getHeader(header) ?? "")
      : new Map<string, string[]>();
  const message = renderSignedMessage(sig.groups, {
    rawBody,
    getHeader,
    getQuery,
    parts,
  });
  return {
    ...view,
    format: sig.format,
    ...(sig.format === "parts" ? { parts: [...parts.keys()] } : {}),
    ...(message === "missing" || message === "ambiguous"
      ? {}
      : {
          signedMessage:
            message.length > SHOWN_MESSAGE_MAX_CHARS
              ? `${message.substring(0, SHOWN_MESSAGE_MAX_CHARS)}…`
              : message,
        }),
  };
}

// The dry run's second half, what processing would do with the row it did not write: the lookup and
// the correlation, asked read-only.
async function explainPlanned(
  base: PrismaClient,
  ctx: TenantContext,
  route: ResolvedInboundRoute,
  planned: NonNullable<InboundProbe["planned"]>,
  stages: InboundStage[],
  run?: typeof runFetchBack,
): Promise<string> {
  let event: NormalizedInboundEvent;
  if (planned.kind === "notice") {
    const looked = await lookUpNotice({
      base,
      tenantId: route.tenantId,
      instanceConfig: route.config,
      resourceId: planned.resourceId,
      run,
    });
    if (looked.kind !== "mapped") {
      stages.push({
        stage: "fetch_back",
        ok: false,
        reason: looked.reason,
        ...(looked.kind === "fetch_failed"
          ? { detail: { retried: looked.retry } }
          : {}),
      });
      return looked.kind === "fetch_failed" && looked.retry
        ? "would-retry"
        : "invalid";
    }
    stages.push({ stage: "fetch_back", ok: true });
    if (!looked.result.ok) {
      stages.push({
        stage: "mapping",
        ok: false,
        reason: looked.result.reason,
        ...(looked.result.detail
          ? { detail: { missing: looked.result.detail } }
          : {}),
      });
      return looked.result.reason === "unhandled" ? "ignored" : "invalid";
    }
    event = looked.result.event;
    const bad =
      identityProblem(event.dedupeKey, "dedupeKey") ??
      identityProblem(event.externalId, "externalId");
    if (bad) {
      stages.push({
        stage: "mapping",
        ok: false,
        reason: "unstorable-identity",
        detail: { issues: bad },
      });
      return "invalid";
    }
    stages.push({ stage: "mapping", ok: true, detail: eventView(event) });
  } else {
    event = planned.event;
    // A GENERIC event was correlated by the receptor itself, already in the stages.
    if (route.catalogType === "GENERIC") return "queued";
  }
  if (event.kind !== "conversion" && event.kind !== "agent_nudge") {
    return "queued";
  }
  const threadId = await runScopedOn(base, ctx, (db) =>
    route.catalogType === "GENERIC"
      ? correlateConversationRef(db, {
          tenantId: route.tenantId,
          integrationInstanceId: route.id,
          ref: event.externalId,
        })
      : toolpackRefThread(db, route.tenantId, event.externalId),
  );
  stages.push(
    threadId
      ? { stage: "correlation", ok: true, detail: { conversation: threadId } }
      : { stage: "correlation", ok: false, reason: "uncorrelated" },
  );
  return threadId ? "queued" : "uncorrelated";
}

export async function testReception(
  ctx: TenantContext,
  instanceId: bigint,
  input: TestReceptionInput,
  base: PrismaClient = basePrisma,
  deps: {
    now?: number;
    runFetchBack?: typeof runFetchBack;
    process?: ProcessDeps;
  } = {},
): Promise<TestReceptionResult> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const scoped = { ...ctx, tenantId: ctx.tenantId };
  const route = await routeOf(base, scoped, instanceId);
  const dryRun = input.dryRun !== false;
  if (!dryRun && !route.enabled) {
    throw new AppError(
      "the integration is disabled, so a real delivery would be refused: enable it or test with the dry run",
      409,
      "errors.integrationTestReceptionDisabled",
    );
  }
  if (!takeSlot(route.tenantId, deps.now ?? Date.now())) {
    throw new AppError(
      `at most ${TEST_RECEPTION_PER_MINUTE} test receptions a minute`,
      429,
      "errors.integrationTestReceptionRateLimited",
      { limit: TEST_RECEPTION_PER_MINUTE },
    );
  }
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const search = new URLSearchParams((input.query ?? "").replace(/^\?/, ""));
  const getHeader = (n: string) => headers.get(n.toLowerCase()) ?? null;
  const getQuery = (n: string) => search.get(n);
  const probe: InboundProbe = { dryRun, stages: [] };
  const done = (outcome: string): TestReceptionResult => {
    const sig = probe.stages.find((s) => s.stage === "signature");
    if (sig) {
      sig.detail = signatureView(route, input.body, getHeader, getQuery);
    }
    return { dryRun, outcome, stages: probe.stages };
  };
  let received: Awaited<ReturnType<typeof receiveOnRoute>>;
  try {
    received = await receiveOnRoute(route, {
      rawBody: input.body,
      getHeader,
      getQuery,
      base,
      probe,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return done("unauthorized");
    if (err instanceof AppError && err.statusCode === 400) {
      return done("invalid");
    }
    throw err;
  }
  if (received.outcome !== "queued" && received.outcome !== "duplicate") {
    return done(received.outcome);
  }
  if (dryRun) {
    if (!probe.planned) return done(received.outcome);
    return done(
      await explainPlanned(
        base,
        scoped,
        route,
        probe.planned,
        probe.stages,
        deps.runFetchBack,
      ),
    );
  }
  if (received.deliveryId === undefined) return done(received.outcome);
  if (received.deferred) {
    // A lookup for this id already ran this minute: the delivery path books the next one, and so
    // does this test.
    probe.stages.push({
      stage: "delivery",
      ok: true,
      detail: { deferred: true },
    });
    return done(received.outcome);
  }
  try {
    const deliveryId = received.deliveryId;
    // Tracked like the webhook route's dispatch, so a shutdown waits for the turn the event runs
    // instead of cutting it after the conversion committed (src/lib/shutdown.ts).
    const result = await trackWork("inbound_delivery", () =>
      processInboundDelivery({
        deliveryId,
        tenantId: route.tenantId,
        base,
        stages: probe.stages,
        deps: {
          ...deps.process,
          ...(deps.runFetchBack ? { runFetchBack: deps.runFetchBack } : {}),
        },
      }),
    );
    const row = await runScopedOn(base, scoped, (db) =>
      db.inboundDelivery.findUnique({
        where: { id: received.deliveryId as bigint },
        select: { status: true },
      }),
    );
    probe.stages.push({
      stage: "delivery",
      ok: row?.status !== "FAILED",
      detail: { result, status: row?.status ?? null },
    });
  } catch (err) {
    probe.stages.push({
      stage: "delivery",
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // Processing can drop an event the receptor queued (a reference that names no conversation, a
  // lookup the provider refused) or fail on its own: the answer says so instead of the queued it
  // started from. A lookup that will be retried leaves the row for the sweep's re-dispatch.
  const stopped = probe.stages.find(
    (s) => !s.ok && s.stage !== "delivery" && s.stage !== "signature",
  );
  const delivered = probe.stages.find((s) => s.stage === "delivery");
  return done(
    stopped?.stage === "fetch_back" && stopped.detail?.retried === true
      ? "retrying"
      : stopped?.stage === "agent"
        ? "agent-failed"
        : stopped?.stage === "correlation"
          ? "uncorrelated"
          : stopped?.reason === "unhandled"
            ? "ignored"
            : stopped
              ? "invalid"
              : delivered && !delivered.ok
                ? "failed"
                : received.outcome,
  );
}
