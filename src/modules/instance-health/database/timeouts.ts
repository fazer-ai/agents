import { createHash } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import config from "@/config";
import { parseDbId } from "@/lib/db-id";
import {
  drainStatementTimeouts,
  requeueStatementTimeouts,
  type StatementTimeoutEvent,
} from "@/lib/pool-stats";
import type { ScopedDb, TxBudget } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { budgetUntil, fleetWithin, plainWithin, scopedWithin } from "./budget";

// The statements that hit their `statement_timeout` (SQLSTATE 57014), stored with the scope they ran
// under and, for the first occurrence of each statement in a window, the plan Postgres gives it
// under that SAME scope: the application role, the same `app.tenant_id`, or the fleet role. A plan
// captured as the database owner skips RLS and shows a different, faster plan, which is how a plan that
// only goes wrong under RLS stays hidden. Only statements this process ran reach
// here (src/lib/pool-stats.ts): nothing takes SQL from a request.

// One plan per statement per hour: a storm of the same timeout costs one EXPLAIN, not one each.
export const PLAN_WINDOW_MS = 60 * 60 * 1000;
// What one EXPLAIN may take on the sampler's single connection.
const PLAN_TIMEOUT_MS = 5_000;
const PLAN_BUDGET: TxBudget = { maxWait: 5_000, timeout: PLAN_TIMEOUT_MS };
// A statement longer than this is stored cut; it still has its own fingerprint.
const STATEMENT_MAX = 8_000;

// The statement as one line of its own spelling, which is what makes two occurrences "the same".
export function normalizeStatement(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function statementFingerprint(sql: string): string {
  return createHash("sha256")
    .update(normalizeStatement(sql))
    .digest("hex")
    .slice(0, 32);
}

// Why a statement cannot be planned, or null when it can. Only one statement, and only the kinds
// EXPLAIN plans: the text comes from this process's own driver, but a plan is still run on the
// sampler's connection, so anything else is refused rather than trusted.
export function unplannableReason(sql: string): string | null {
  const body = sql.trim().replace(/;\s*$/, "");
  if (body.includes(";")) return "more than one statement";
  if (!/^(SELECT|WITH|UPDATE|INSERT|DELETE)\b/i.test(body)) {
    return "not a SELECT, WITH, INSERT, UPDATE or DELETE";
  }
  return null;
}

export function plannedAsOf(ev: {
  tenantId: string | null;
  fleet: boolean;
}): string {
  if (ev.fleet) return "fleet role";
  if (ev.tenantId) return `application role, tenant ${ev.tenantId}`;
  return "application role, no tenant";
}

// EXPLAIN without ANALYZE (nothing runs), in GENERIC_PLAN form: the parameters stay `$N`, so no value
// the statement carried is needed or stored, and the plan is the one Postgres builds for the
// statement's shape. Read-only, under the captured scope.
export async function capturePlan(
  ev: Pick<StatementTimeoutEvent, "sql" | "tenantId" | "fleet" | "pool">,
  base: PrismaClient = instanceHealthPrisma,
  budget: TxBudget = PLAN_BUDGET,
): Promise<{ plan: string; plannedAs: string } | { error: string }> {
  const refused = unplannableReason(ev.sql);
  if (refused) return { error: refused };
  // The plan is taken on the application database; a checkpointer on another one would explain a
  // statement against relations that are not there, or that are someone else's.
  if (
    ev.pool === "checkpointer" &&
    config.langgraphDatabaseUrl !== config.databaseUrl
  ) {
    return {
      error:
        "ran on the checkpointer's database (LANGGRAPH_DATABASE_URL), where plans are not taken",
    };
  }
  const body = ev.sql.trim().replace(/;\s*$/, "");
  // "Planned as" is read back from the transaction that planned, not restated from the event: the
  // record says which role and tenant Postgres actually applied.
  const explain = async (db: ScopedDb) => {
    // Inside the budgeted transaction, like everything else here: no statement escapes the deadline.
    const [version] = await db.$queryRaw<{ v: number }[]>`
      SELECT current_setting('server_version_num')::int AS v`;
    if ((version?.v ?? 0) < 160000) {
      throw new Error("EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16 or later");
    }
    await db.$executeRawUnsafe("SET LOCAL transaction_read_only = on");
    const rows = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN (GENERIC_PLAN) ${body}`,
    );
    const [scope] = await db.$queryRaw<
      { tenant: string | null; acting: boolean }[]
    >`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant,
             current_user <> session_user AS acting`;
    return {
      plan: rows.map((r) => r["QUERY PLAN"]).join("\n"),
      plannedAs: plannedAsOf({
        tenantId: scope?.tenant ?? null,
        fleet: scope?.acting ?? false,
      }),
    };
  };
  try {
    // The scope the statement's transaction was opened under (src/lib/db-scope.ts).
    const tenantId = parseDbId(ev.tenantId);
    const planned = ev.fleet
      ? await fleetWithin(base, budget, explain)
      : tenantId !== null
        ? await scopedWithin(base, tenantId, budget, explain)
        : await plainWithin(base, budget, explain);
    return planned;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// What one sampler tick spends here. The flush runs inside the database half, before the sample is
// evaluated, so a storm of distinct timeouts must not hold the instance alerts back: a bounded batch
// of events, and one EXPLAIN (up to PLAN_TIMEOUT_MS). What does not fit waits for the next tick.
export const FLUSH_MAX_EVENTS = 50;
// And the time a call may spend on them, all together: past it, what is left goes back to the queue.
const FLUSH_BUDGET_MS = 3_000;
const FLUSH_MAX_PLANS = 1;
// The most one store statement may take of what is left.
const STORE_CAP_MS = 2_000;
// Ticks an event may fail to be stored before it is given up on.
const MAX_STORE_ATTEMPTS = 3;
const failedAttempts = new WeakMap<StatementTimeoutEvent, number>();

// Stores what this process captured since the last call, and plans the first occurrence of each
// statement in the window. An event whose plan does not fit this call goes back to the queue, with
// every later event of the same statement, so the first occurrence is still the one planned.
// Returns how many were stored.
export async function flushStatementTimeouts(
  base: PrismaClient = instanceHealthPrisma,
  events: StatementTimeoutEvent[] = drainStatementTimeouts(FLUSH_MAX_EVENTS),
  maxPlans: number = FLUSH_MAX_PLANS,
  budgetMs: number = FLUSH_BUDGET_MS,
): Promise<number> {
  if (events.length === 0) return 0;
  const deadline = Date.now() + budgetMs;
  // Every statement of this call shares the call's deadline, so one slow event cannot overrun it.
  const left = (cap: number): TxBudget => budgetUntil(deadline, cap);
  const plannedNow = new Set<string>();
  const deferred: StatementTimeoutEvent[] = [];
  const deferredPrints = new Set<string>();
  let stored = 0;
  for (const [i, ev] of events.entries()) {
    if (Date.now() >= deadline) {
      deferred.push(...events.slice(i));
      break;
    }
    const fingerprint = statementFingerprint(ev.sql);
    if (deferredPrints.has(fingerprint)) {
      deferred.push(ev);
      continue;
    }
    try {
      const recent = await fleetWithin(base, left(STORE_CAP_MS), (db) =>
        db.dbStatementTimeout.findFirst({
          where: {
            fingerprint,
            occurredAt: { gte: new Date(ev.at - PLAN_WINDOW_MS) },
            OR: [{ plan: { not: null } }, { planError: { not: null } }],
          },
          select: { id: true },
        }),
      );
      const wantsPlan = !recent && !plannedNow.has(fingerprint);
      if (wantsPlan && plannedNow.size >= maxPlans) {
        deferred.push(ev);
        deferredPrints.add(fingerprint);
        continue;
      }
      // Stored first, the plan after: a plan that uses up the call's time must not keep the
      // occurrence itself from being recorded, tick after tick.
      const row = await fleetWithin(base, left(STORE_CAP_MS), (db) =>
        db.dbStatementTimeout.create({
          data: {
            occurredAt: new Date(ev.at),
            fingerprint,
            statement: clipText(normalizeStatement(ev.sql), STATEMENT_MAX),
            label: ev.label,
            scopeTenantId: parseDbId(ev.tenantId),
            fleet: ev.fleet,
            budgetMs: ev.budgetMs,
          },
          select: { id: true },
        }),
      );
      stored++;
      if (wantsPlan) {
        plannedNow.add(fingerprint);
        // capturePlan answers a failure (the deadline included) as a reason, which is stored.
        const plan = await capturePlan(ev, base, left(PLAN_TIMEOUT_MS));
        try {
          await fleetWithin(base, left(STORE_CAP_MS), (db) =>
            db.dbStatementTimeout.update({
              where: { id: row.id },
              data: {
                plan: "plan" in plan ? plan.plan : null,
                planError: "error" in plan ? plan.error : null,
                plannedAs:
                  "plannedAs" in plan ? plan.plannedAs : plannedAsOf(ev),
              },
            }),
          );
        } catch (err) {
          // The occurrence is stored; the next one of this statement asks for its plan again.
          logger.warn(
            { err },
            "database screen: a timeout's plan was not stored",
          );
        }
      }
    } catch (err) {
      // The call's time ran out under this event: it and the rest wait for the next tick, and that
      // is not a failure of the event.
      if (Date.now() >= deadline) {
        deferred.push(...events.slice(i));
        break;
      }
      // Most likely the database itself is in trouble, which is when this evidence matters: this
      // event and the rest of the batch go back to the queue instead of each paying its own failure.
      // An event that keeps failing is dropped after a few ticks, so it cannot wedge the queue.
      const attempts = (failedAttempts.get(ev) ?? 0) + 1;
      failedAttempts.set(ev, attempts);
      logger.warn(
        { err, attempts },
        "database screen: a statement timeout was not stored",
      );
      if (attempts < MAX_STORE_ATTEMPTS) deferred.push(ev);
      deferred.push(...events.slice(i + 1));
      break;
    }
  }
  requeueStatementTimeouts(deferred);
  return stored;
}
