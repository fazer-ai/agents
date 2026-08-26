import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  MAX_STRING,
  redactSecretsDeep,
  sanitizeErrorMessage,
} from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { dispatchAlertsForEvent } from "./alerts";
import { trackFlowWrite } from "./scheduled";
import type { FlowLevel, FlowSource, FlowStage, FlowStatus } from "./stages";

// Execution-flow log emit core. Verbose, per-stage operational telemetry (one row per stage per
// turn) written FIRE-AND-FORGET: unlike UsageCapture (which awaits its single billing row), the
// hot WhatsApp path must not pay write latency for 6+ log lines, and losing a line at process
// shutdown is acceptable for operational logging. Every emit has its own try/catch — a rejected
// write (or alert dispatch) never escapes into the turn. NEVER log message text / PII: `detail`
// carries only ids/counts/enums and is passed through redactSecretsDeep as defense-in-depth.

// The ceiling a `detail` string is written under while the agent's debug mode is on (#58).
//
// Derived, not chosen. The largest operator-authored string the API accepts is `AGENT_PROMPT_MAX_CHARS`
// (100k by default, `src/api/v1/agents.controller.ts`), and the field the mode exists for is that
// prompt's AUDIT, which is the same text with its context placeholders rewritten as
// `{{canal: string(1234)}}`. Measured, that rewrite expands the template by 1.08x on ordinary prose
// and at most 2.56x in the worst case the closed context-variable set allows — `{{canal}}` is the
// shortest placeholder there is, at 9 characters, and its audited form is at most 23
// (`tests/modules/flowlog-debug-mode.test.ts` pins both numbers). Three times the prompt ceiling
// therefore covers any prompt this API would have accepted, with margin.
//
// It is still a BOUND, and that is the point of not simply removing the cap: `detail` also carries
// tool arguments and results, which no configuration limits, so an unbounded write would let one
// runaway tool response into a row.
//
// `Math.max` because the prompt ceiling is an operator's env var and nothing stops it being small:
// under 667 the derivation falls below the ordinary 2,000, and arming the debug mode would then
// SHRINK what a line stores. A mode that records less than the default is not a weaker version of
// itself, it is the opposite of what it says.
//
// The `+` term is the SCHEDULE allowance, and it is there because the audit does not only mask: it
// keeps the agent's own configured hours resolved, since those are often the whole answer to "why
// did it say we were closed". A rendered schedule is not small — at `MAX_SCHEDULE_WINDOWS` it turns
// a 23-character placeholder into ~2.6k — so the audit collapses repeats and keeps ONE full
// rendering per schedule variable name (`prompt-audit.ts`). Six names, and 4k each is generous for
// a 200-window summary (measured: 2,639 characters, ~13 per window), so this reserves what that
// rule can still add on top of the template.
//
// A bound, and only since issue #346. `MAX_SCHEDULE_WINDOWS` is asked at the READER (`parseWindows`),
// so no stored row surfaces more than it however it was written, and the reserve above therefore
// covers every schedule this runtime can render. It was a MARGIN while the number bounded only the
// business-hours API: the agent import wrote `windows` unvalidated, and one past the cap rendered
// past what is reserved here. That fallback is still here and still right — the audit is cut and the
// row stays bounded, because the ceiling is also a budget — but reaching it no longer takes a
// schedule. Reserving for an unbounded input is not possible, and that is why the input is bounded.
const SCHEDULE_AUDIT_ALLOWANCE = 6 * 4_000;

// The derivation as a FUNCTION, so it can be measured at a prompt ceiling other than this
// deployment's: the schedule allowance only carries weight when `promptMaxChars` is small, and a
// test that could only ask about the default would never see it do anything.
export function debugCeilingFor(promptMaxChars: number): number {
  // No floor at `MAX_STRING`: the schedule allowance alone is more than ten times it, so the sum
  // cannot come out below the ordinary cap however small the prompt ceiling is set. A `Math.max`
  // here was a condition no input could reach, which is how the mutation battery found it.
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

// THE SAME WRITE, AWAITED, and it exists for a caller whose line is the only record there will be.
//
// Every turn-time caller wants the fire-and-forget form: the line describes work that already
// happened, and making a customer wait on a log write would be the wrong trade. The stranded-delivery
// sweep is the opposite case — it retires the ledger row that is the line's only other trace, so a
// swallowed failure loses the report permanently and no later pass can find the row again. Awaiting
// lets that caller write the line FIRST and retire the row only if it landed.
//
// Failures are still swallowed here, for the same reason they are swallowed above: a caller asking
// for the line is not asking to fail if it cannot be written. What awaiting buys is ORDERING, not an
// exception — the caller learns the outcome from `delivered`.
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
          // Lifting it would widen PII exposure to buy nothing this issue asked for.
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
  // Alerting: only warn/error, and only real (inbox) traffic — a playground error must not page.
  if ((level === "warn" || level === "error") && ctx.source === "inbox") {
    try {
      await dispatchAlertsForEvent(ctx, { ...ev, level }, base);
    } catch (err) {
      logger.warn({ err, turnId: ctx.turnId }, "flowlog alert dispatch failed");
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
