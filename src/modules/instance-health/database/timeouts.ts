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
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TxBudget,
} from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { asFleetForInstanceHealth } from "../fleet-tx";

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
    const [version] = await base.$queryRaw<{ v: number }[]>`
      SELECT current_setting('server_version_num')::int AS v`;
    if ((version?.v ?? 0) < 160000) {
      return { error: "EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16 or later" };
    }
    // The tenant id is the one the transaction itself set, read back from its `set_config`.
    const tenantId = parseDbId(ev.tenantId);
    const planned = ev.fleet
      ? await asSuperAdminOn(base, explain, PLAN_BUDGET)
      : tenantId !== null
        ? await runScopedOn(
            base,
            {
              tenantId,
              userId: null,
              role: "TENANT_ADMIN",
            },
            explain,
            PLAN_BUDGET,
          )
        : await base.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(PLAN_TIMEOUT_MS)}, true)`;
              return explain(tx as unknown as ScopedDb);
            },
            { maxWait: PLAN_BUDGET.maxWait, timeout: PLAN_BUDGET.timeout },
          );
    return planned;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// What one sampler tick spends here. The flush runs inside the database half, before the sample is
// evaluated, so a storm of distinct timeouts must not hold the instance alerts back: a bounded batch
// of events, and one EXPLAIN (up to PLAN_TIMEOUT_MS). What does not fit waits for the next tick.
export const FLUSH_MAX_EVENTS = 50;
const FLUSH_MAX_PLANS = 1;
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
): Promise<number> {
  if (events.length === 0) return 0;
  const plannedNow = new Set<string>();
  const deferred: StatementTimeoutEvent[] = [];
  const deferredPrints = new Set<string>();
  let stored = 0;
  for (const [i, ev] of events.entries()) {
    const fingerprint = statementFingerprint(ev.sql);
    if (deferredPrints.has(fingerprint)) {
      deferred.push(ev);
      continue;
    }
    try {
      const recent = await asFleetForInstanceHealth(base, (db) =>
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
      let plan: { plan: string; plannedAs: string } | { error: string } | null =
        null;
      if (wantsPlan) {
        plannedNow.add(fingerprint);
        plan = await capturePlan(ev, base);
      }
      await asFleetForInstanceHealth(base, (db) =>
        db.dbStatementTimeout.create({
          data: {
            occurredAt: new Date(ev.at),
            fingerprint,
            statement: clipText(normalizeStatement(ev.sql), STATEMENT_MAX),
            label: ev.label,
            scopeTenantId: parseDbId(ev.tenantId),
            fleet: ev.fleet,
            budgetMs: ev.budgetMs,
            plan: plan && "plan" in plan ? plan.plan : null,
            planError: plan && "error" in plan ? plan.error : null,
            plannedAs: !plan
              ? null
              : "plannedAs" in plan
                ? plan.plannedAs
                : plannedAsOf(ev),
          },
        }),
      );
      stored++;
    } catch (err) {
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
