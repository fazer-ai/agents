import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Whether the guardrail screen is actually running, answered from what it did rather than from how
// it was configured. Analysis is fail-open by design (a moderation call that times out must not
// hold a customer's conversation), so a screen that can NEVER run behaves exactly like one that ran
// and approved: the reply goes out either way. Configuration cannot tell the two apart, because
// every cause is valid configuration right up to the moment the call is made:
//
//   - a model id the vendor has retired;
//   - a parameter the vendor rejects on every call (agents#130 was a live instance: the guardrails
//     pass pins temperature 0, and every current Claude model answers 400 to that);
//   - a chronic timeout;
//   - a credential that stopped resolving.
//
// The `guardrail` stage writes exactly two shapes (graph/runtime.ts): status "ok" when a check
// TRIPPED, and status "error" when the analysis itself could not be performed. Nothing is written
// when a screen runs and approves, so this counts failures and never a ratio: the honest reading of
// "3 rows" is "3 turns were delivered unscreened", not "3 out of N".
export const GUARDRAIL_HEALTH_WINDOW_HOURS = 24;

// The window's start, as a function so the unit conversion is reachable by a test. Written inline in
// the controller it is a silent bug class of its own: one missing factor of a thousand turns the
// panel's "last 24 hours" into the last 24 seconds, and every test still passes because the count is
// correct for the window it was actually given.
export function guardrailHealthWindowStart(now: Date = new Date()): Date {
  return new Date(
    now.getTime() - GUARDRAIL_HEALTH_WINDOW_HOURS * 60 * 60 * 1000,
  );
}

export interface GuardrailHealth {
  // Analyses that could not run inside the window. Each one is a turn delivered unscreened.
  failures: number;
  // When the most recent one was, so a count that stopped growing reads differently from one that
  // is still growing. Null exactly when `failures` is 0.
  lastAt: string | null;
  // The cause the most recent one carried, already scrubbed at write (sanitizeErrorMessage). It is
  // what names the vendor's refusal, which is the whole difference between "fix this" and "look".
  lastError: string | null;
}

export async function readGuardrailHealth(
  ctx: TenantContext,
  agentId: bigint,
  since: Date,
  base: PrismaClient = basePrisma,
): Promise<GuardrailHealth> {
  // No source filter, which today means inbox: the guardrail stage is written from the turn path
  // only, and the playground does not run the pass at all (modules/playground/service.ts never
  // reaches analyzeGuardrail). Filtering to "inbox" anyway would encode that absence as a rule, so
  // that the day the pass runs somewhere else its failures would be counted as zero by a filter
  // nobody remembered. The question this answers is "could the screen run", not "on which surface".
  const where = {
    agentId,
    stage: "guardrail",
    status: "error",
    createdAt: { gte: since },
  };
  return runScopedOn(base, ctx, async (db) => {
    // The agent is resolved first so an id that never existed (or was deleted while its rows are
    // still inside the retention window) answers 404 instead of a confident zero, or worse, the
    // history of whoever held the id before. Same shape as getAgentToolSelections.
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    const failures = await db.executionLog.count({ where });
    const last = failures
      ? await db.executionLog.findFirst({
          where,
          // By createdAt, not by id. The rows are written fire-and-forget from independent
          // transactions, and `now()` is the TRANSACTION's start time, so a turn that began
          // earlier can be inserted later and take a higher id. Ordering by the sequence would
          // then report an older failure as the most recent one, which is the single field an
          // operator uses to decide whether the screen is still failing. id breaks ties.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { createdAt: true, errorMessage: true },
        })
      : null;
    return {
      failures,
      lastAt: last ? last.createdAt.toISOString() : null,
      lastError: last?.errorMessage ?? null,
    };
  });
}
