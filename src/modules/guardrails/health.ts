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
// "3 rows" is "3 checks did not happen", not "3 out of N", and not "3 messages were delivered
// unscreened" either. A failed INPUT check leaves the output check free to still screen the reply,
// and the output direction MERGES two analyses (splitAnalyses), so one half can report an error
// while the other returns violated and the send is replaced or suppressed anyway. What every row
// does prove is narrower and still worth saying: fail-open applies to the check that failed, so
// that one caught nothing and held nothing back.
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
  // Analyses that could not run inside the window. Each one is a check that did not happen, on a
  // pass that is fail-open, so none of them blocked anything.
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
    // Newest row FIRST, then a count bounded by that row's timestamp. The order is the whole point.
    // These rows are written fire-and-forget from other transactions and Postgres reads at READ
    // COMMITTED, so a row can commit between two statements; taken in this order the second
    // statement can only ever be a superset of the first, so the row being quoted is always inside
    // the count. Counting first and quoting second is what lets the pair disagree, reporting "2
    // failures" beside an error from the third one. A row that commits after this makes the reading
    // a moment stale, which is what a snapshot is, and leaves it internally consistent.
    //
    // Newest by createdAt, never by id: the writes are independent transactions and `now()` is the
    // TRANSACTION's start time, so a turn that began earlier can be inserted later and take a higher
    // id. The sequence would then name the wrong row as the most recent failure, which is the one
    // field an operator reads to decide whether the screen is still failing. id breaks ties.
    const last = await db.executionLog.findFirst({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true, errorMessage: true },
    });
    if (!last) return { failures: 0, lastAt: null, lastError: null };
    // The cut is the keyset the ordering above defines, (createdAt, id), not the timestamp alone.
    // createdAt is a TIMESTAMP(3), so a burst puts several failures in the same millisecond, and a
    // bound of `createdAt <= last.createdAt` would readmit a row that this very ordering calls
    // NEWER than the one being quoted: the count would then be reporting a failure the message is
    // not describing.
    const failures = await db.executionLog.count({
      where: {
        ...where,
        OR: [
          { createdAt: { gte: since, lt: last.createdAt } },
          { createdAt: last.createdAt, id: { lte: last.id } },
        ],
      },
    });
    return {
      failures,
      lastAt: last.createdAt.toISOString(),
      lastError: last.errorMessage,
    };
  });
}
