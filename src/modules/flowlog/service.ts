import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { failureDetail } from "@/lib/provider-failure";
import {
  MAX_STRING,
  redactSecretsDeep,
  sanitizeErrorMessage,
} from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  causeKeyOf,
  dispatchAlertsForEvent,
  dispatchRateAlert,
  rateSubjectOf,
} from "./alerts";
import { trackFlowWrite } from "./scheduled";
import type { FlowLevel, FlowSource, FlowStage, FlowStatus } from "./stages";

// Execution-flow log emit core. Verbose, per-stage operational telemetry (one row per stage per
// turn) written FIRE-AND-FORGET: unlike UsageCapture (which awaits its single billing row), the
// hot WhatsApp path must not pay write latency for 6+ log lines, and losing a line at process
// shutdown is acceptable for operational logging. Every emit has its own try/catch — a rejected
// write (or alert dispatch) never escapes into the turn. NEVER log message text / PII: `detail`
// carries only ids/counts/enums and is passed through redactSecretsDeep as defense-in-depth.

// The ceiling a `detail` string is written under while the agent's debug mode is on. Three times
// `AGENT_PROMPT_MAX_CHARS` covers the audited prompt (placeholders expand it at most 2.56x, pinned
// in tests/modules/flowlog-debug-mode.test.ts); the allowance reserves one rendered schedule per
// variable name (six names, bounded by `MAX_SCHEDULE_WINDOWS` at the reader). Still a bound,
// because `detail` also carries tool arguments and results, which nothing limits.
const SCHEDULE_AUDIT_ALLOWANCE = 6 * 4_000;

// The derivation as a FUNCTION, so it can be measured at a prompt ceiling other than this
// deployment's: the schedule allowance only carries weight when `promptMaxChars` is small, and a
// test that could only ask about the default would never see it do anything.
export function debugCeilingFor(promptMaxChars: number): number {
  // NOTE: No floor at `MAX_STRING`: the schedule allowance alone is more than ten times it, so the
  // sum cannot come out below the ordinary cap however small the prompt ceiling is set.
  return promptMaxChars * 3 + SCHEDULE_AUDIT_ALLOWANCE;
}

export const DEBUG_MAX_STRING = debugCeilingFor(config.agent.promptMaxChars);

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
  // The agent's debug mode, resolved ONCE per turn by whoever built this context (it is a settings
  // read, and this emit is on the hot path and fire-and-forget). Absent means off, which is what
  // every context that does not know an agent must be.
  fullDetail?: boolean;
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
  trackFlowWrite(writeFlowEvent(ctx, ev));
}

// The same write, awaited, for a caller whose line is the only record left: the stranded-delivery
// sweep writes the line FIRST and retires its ledger row only if it landed. Failures are still
// swallowed; what awaiting buys is ORDERING, and the outcome comes back in `delivered`.
export async function writeFlowEvent(
  ctx: FlowContext,
  ev: FlowEvent,
): Promise<{ delivered: boolean }> {
  const base = ctx.base ?? basePrisma;
  const level: FlowLevel = ev.level ?? "info";
  let delivered = true;
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
            ? (redactSecretsDeep(
                ev.detail,
                0,
                ctx.fullDetail ? DEBUG_MAX_STRING : MAX_STRING,
                // The raised ceiling comes with an aggregate budget, because a per-string cap
                // bounds no ROW: `detail` is a tree and nothing here bounds an object's key
                // count, so fifty leaves at 300k each would be a 15 MB row. The default path
                // passes none and keeps the per-string behaviour every existing line has.
                ctx.fullDetail ? { left: DEBUG_MAX_STRING } : undefined,
              ) as Prisma.InputJsonValue)
            : Prisma.DbNull,
          // NOTE: `errorMessage` keeps its own 500-char cut, debug mode or not. That cut is not
          // the size policy `detail` is under — it is standing in for a scrub that does not
          // exist: a provider's error text is not allowlisted the way `detail` is, and it can
          // echo the customer's own message back (a content-filter refusal quoting the input).
          // Lifting it would widen PII exposure for no gain.
          errorMessage: ev.errorMessage
            ? sanitizeErrorMessage(ev.errorMessage)
            : undefined,
        },
      }),
    );
  } catch (err) {
    delivered = false;
    logger.warn({ err, turnId: ctx.turnId }, "flowlog emit failed");
  }
  // Alerting: only warn/error, plus a cause alert at any level (a run the job retries against a dead
  // key is an `info`, and the key still needs a person), and only real (inbox) traffic — a playground
  // error must not page.
  if (
    (level === "warn" || level === "error" || causeKeyOf(ev) !== null) &&
    ctx.source === "inbox"
  ) {
    try {
      await dispatchAlertsForEvent(ctx, { ...ev, level }, base);
    } catch (err) {
      logger.warn({ err, turnId: ctx.turnId }, "flowlog alert dispatch failed");
    }
  }
  // A transient provider failure also counts toward that provider's rate, at any level: the attempt
  // a retry recovers is `info` and pages nobody alone, and many of them are a degraded provider.
  if (ctx.source === "inbox" && rateSubjectOf(ev) !== null) {
    try {
      await dispatchRateAlert(ctx, ev, base);
    } catch (err) {
      logger.warn({ err, turnId: ctx.turnId }, "flowlog rate alert failed");
    }
  }
  return { delivered };
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
    // The failure line's level and extra detail, decided by the caller from the error, for a caller
    // that knows what comes next: a retry it is about to make is `info` with `willRetry`, and only the
    // failure that ends the work keeps the severity. Wins over `errorLevel`. A throw here falls back
    // to `errorLevel`, for the same reason `detailOf` is guarded.
    failureOf?: (err: unknown) => {
      level: FlowLevel;
      detail?: Record<string, unknown>;
    };
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
    let level = meta.errorLevel ?? "error";
    // What kind of failure it was, in the closed vocabulary (`timeout`, `HTTP <nnn>`,
    // `provider error`), never the server's text: the alert dispatcher keys causes and rates on it,
    // and the message beside it is free text no rule should parse.
    let detail: Record<string, unknown> = {
      ...meta.detail,
      ...failureDetail(err),
    };
    if (meta.failureOf) {
      try {
        const failure = meta.failureOf(err);
        level = failure.level;
        if (failure.detail) detail = { ...detail, ...failure.detail };
      } catch (e) {
        logger.warn({ err: e, stage }, "flow stage failureOf failed");
      }
    }
    emitFlowEvent(ctx, {
      stage,
      level,
      status: "error",
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      durationMs: Date.now() - start,
      detail,
      errorMessage: sanitizeErrorMessage(err),
    });
    throw err;
  }
}
