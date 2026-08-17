import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { redactSecretsDeep, sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { dispatchAlertsForEvent } from "./alerts";
import type { FlowLevel, FlowSource, FlowStage, FlowStatus } from "./stages";

// Execution-flow log emit core. Verbose, per-stage operational telemetry (one row per stage per
// turn) written FIRE-AND-FORGET: unlike UsageCapture (which awaits its single billing row), the
// hot WhatsApp path must not pay write latency for 6+ log lines, and losing a line at process
// shutdown is acceptable for operational logging. Every emit has its own try/catch — a rejected
// write (or alert dispatch) never escapes into the turn. NEVER log message text / PII: `detail`
// carries only ids/counts/enums and is passed through redactSecretsDeep as defense-in-depth.

export interface FlowContext {
  tenantId: bigint;
  // Correlates every stage of one turn (crypto.randomUUID() once per turn).
  turnId: string;
  source: FlowSource;
  conversationId?: bigint | null;
  agentId?: bigint | null;
  inboxId?: bigint | null;
  threadId?: string | null;
  base?: PrismaClient;
}

export interface FlowEvent {
  stage: FlowStage;
  level?: FlowLevel;
  status?: FlowStatus;
  provider?: string | null;
  model?: string | null;
  durationMs?: number | null;
  // Allowlisted ids/counts/enums only — never message text/PII. Redacted on write.
  detail?: Record<string, unknown>;
  errorMessage?: string;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Fire-and-forget: schedules the row write (and, for warn/error on real traffic, alert dispatch)
// without awaiting. Returns immediately; failures are swallowed (logged at warn).
export function emitFlowEvent(ctx: FlowContext, ev: FlowEvent): void {
  const base = ctx.base ?? basePrisma;
  const level: FlowLevel = ev.level ?? "info";
  void (async () => {
    try {
      await runScopedOn(base, sysCtx(ctx.tenantId), (db) =>
        db.executionLog.create({
          data: {
            tenantId: ctx.tenantId,
            turnId: ctx.turnId,
            conversationId: ctx.conversationId ?? undefined,
            agentId: ctx.agentId ?? undefined,
            inboxId: ctx.inboxId ?? undefined,
            threadId: ctx.threadId ?? undefined,
            stage: ev.stage,
            level,
            status: ev.status ?? undefined,
            provider: ev.provider ?? undefined,
            model: ev.model ?? undefined,
            durationMs: ev.durationMs ?? undefined,
            source: ctx.source,
            detail: ev.detail
              ? (redactSecretsDeep(ev.detail) as Prisma.InputJsonValue)
              : Prisma.DbNull,
            errorMessage: ev.errorMessage
              ? sanitizeErrorMessage(ev.errorMessage)
              : undefined,
          },
        }),
      );
    } catch (err) {
      logger.warn({ err, turnId: ctx.turnId }, "flowlog emit failed");
    }
    // Alerting: only warn/error, and only real (inbox) traffic — a playground error must not page.
    if ((level === "warn" || level === "error") && ctx.source === "inbox") {
      try {
        await dispatchAlertsForEvent(ctx, { ...ev, level }, base);
      } catch (err) {
        logger.warn(
          { err, turnId: ctx.turnId },
          "flowlog alert dispatch failed",
        );
      }
    }
  })();
}

// Span helper: measures `fn`, emits an `ok` line on success and an `error` line on throw (then
// RE-THROWS so the caller's existing error handling is unchanged). When `ctx` is absent (no flow
// wiring on this path) it just runs `fn` with zero overhead. The emit is fire-and-forget, so the
// span only awaits the actual work — never the log write.
export async function withFlowStage<T>(
  ctx: FlowContext | undefined,
  stage: FlowStage,
  meta: {
    provider?: string | null;
    model?: string | null;
    detail?: Record<string, unknown>;
    // Extra detail derived FROM the result, merged over `detail` on the success line, for a stage
    // whose interesting numbers only exist once it returned (how much the speech normalizer rewrote,
    // say). Same PII rule as `detail`: counts, ids and enums, never text. It runs on the hot path, so
    // a throw here is swallowed rather than allowed to break the very work it was measuring.
    detailOf?: (out: T) => Record<string, unknown>;
    // Severity for the throw line (default "error"). Best-effort stages whose failure the caller
    // RECOVERS from (e.g. TTS → text fallback) pass "warn" so the conversation/Logs show an advisory
    // rather than a red error. The status stays "error" (the stage itself did fail).
    errorLevel?: FlowLevel;
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (!ctx) return fn();
  const start = Date.now();
  try {
    const out = await fn();
    let detail = meta.detail;
    if (meta.detailOf) {
      try {
        detail = { ...detail, ...meta.detailOf(out) };
      } catch (err) {
        logger.warn({ err, stage }, "flow stage detailOf failed");
      }
    }
    emitFlowEvent(ctx, {
      stage,
      level: "info",
      status: "ok",
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      durationMs: Date.now() - start,
      detail,
    });
    return out;
  } catch (err) {
    emitFlowEvent(ctx, {
      stage,
      level: meta.errorLevel ?? "error",
      status: "error",
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      durationMs: Date.now() - start,
      detail: meta.detail,
      errorMessage: sanitizeErrorMessage(err),
    });
    throw err;
  }
}
