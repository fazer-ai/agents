import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Whether the guardrail screen is actually running, answered from what it did rather than from its
// configuration: analysis is fail-open, so a screen that can NEVER run (retired model, a parameter the
// vendor always rejects, chronic timeout, dead credential) looks like one that approved. The stage
// writes a row only when a check trips ("ok") or cannot run ("error"), so this counts failures, never a
// ratio, and a failure does not mean an unscreened send (the other direction or the other merged half
// may still have caught it). Each row proves only that that check caught nothing and held nothing back.
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
    // NOTE: newest row FIRST, then a count bounded by its timestamp: rows commit from other
    // transactions at READ COMMITTED, and this order makes the count a superset of the quoted row
    // (counting first could report "2 failures" beside the third's error). Newest by createdAt, not
    // id: `now()` is the transaction start, so an earlier turn can take a higher id. id breaks ties.
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
