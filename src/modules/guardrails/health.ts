import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
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
  // Both sources on purpose. Alerting excludes the playground because a test turn must not page,
  // but the playground is exactly where an operator re-tests after changing the model id, and a
  // screen that cannot run there cannot run on real traffic either.
  const where = {
    agentId,
    stage: "guardrail",
    status: "error",
    createdAt: { gte: since },
  };
  return runScopedOn(base, ctx, async (db) => {
    const failures = await db.executionLog.count({ where });
    const last = failures
      ? await db.executionLog.findFirst({
          where,
          orderBy: { id: "desc" },
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
