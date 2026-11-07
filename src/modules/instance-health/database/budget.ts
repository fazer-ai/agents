import type { PrismaClient } from "@/../generated/prisma/client";
import {
  asSuperAdminOn,
  DeadlinePassedError,
  runScopedOn,
  runWithinBudgetOn,
  type ScopedDb,
  type TxBudget,
} from "@/lib/tenancy";

// The only ways this module reaches the database (docs/logs.md, "Database"): every transaction gets
// a budget carved from one deadline, so the sampler tick, the flush and the screen's read each end
// when their time does, whatever statement they are on. The Biome rule
// require-database-screen-budget refuses any other access in this directory.

// What is left of `deadline`, at most `cap` milliseconds, as a transaction budget whose statements
// each get the remainder (src/lib/tenancy/deadline.ts). The cap moves the deadline itself, so a
// statement never gets more than the cap either.
export function budgetUntil(
  deadline: number,
  cap: number = Number.POSITIVE_INFINITY,
): TxBudget {
  const now = Date.now();
  const ms = Math.max(1, Math.min(cap, Math.ceil(deadline - now)));
  return { maxWait: ms, timeout: ms, deadline: Math.min(deadline, now + ms) };
}

// The budget a transaction gets at the moment it opens: what is left of the deadline, never the
// allowance computed when the budget was made, so a run that reuses one budget across transactions
// does not wait for a connection past its deadline. A deadline already spent opens nothing.
function opening(budget: TxBudget): TxBudget {
  if (budget.deadline === undefined) return budget;
  if (Date.now() >= budget.deadline) throw new DeadlinePassedError();
  return budgetUntil(budget.deadline, budget.timeout);
}

// A transaction in the fleet role, for the screen's own tables.
export async function fleetWithin<T>(
  base: PrismaClient,
  budget: TxBudget,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return asSuperAdminOn(base, fn, opening(budget));
}

// A transaction as the application role under one tenant, for a plan taken under that scope.
export async function scopedWithin<T>(
  base: PrismaClient,
  tenantId: bigint,
  budget: TxBudget,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return runScopedOn(
    base,
    { tenantId, userId: null, role: "TENANT_ADMIN" },
    fn,
    opening(budget),
  );
}

// A transaction without a scope, for the catalog and the statistics views.
export async function plainWithin<T>(
  base: PrismaClient,
  budget: TxBudget,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return runWithinBudgetOn(base, opening(budget), (tx) =>
    fn(tx as unknown as ScopedDb),
  );
}
