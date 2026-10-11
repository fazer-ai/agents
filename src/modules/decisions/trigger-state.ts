// The decisions engine's trigger state (docs/decisions.md, "When a rule acts"): which rules already
// acted in a conversation and are held back until their conditions stop holding (`on_start`) or for
// good (`once`). One row per such rule, keyed by `ruleStateKey`, read before the actions and written
// after them by the observation that decided.

import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import type { TriggerStateChange } from "./run";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface TriggerScope {
  tenantId: bigint;
  agentId: bigint;
  conversationId: bigint;
}

export async function readLatchedRules(
  base: PrismaClient,
  scope: TriggerScope,
): Promise<Set<string>> {
  const rows = await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
    db.decisionRuleState.findMany({
      where: { agentId: scope.agentId, conversationId: scope.conversationId },
      select: { ruleKey: true },
    }),
  );
  return new Set(rows.map((r) => r.ruleKey));
}

// Latches written by the tick before it dispatches the actions they answer for (run.ts,
// LatchAhead): only added, never released or pruned.
export async function latchRules(
  base: PrismaClient,
  scope: TriggerScope,
  keys: string[],
  at: Date = new Date(),
): Promise<void> {
  if (keys.length === 0) return;
  await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
    writeLatches(db, scope, keys, at),
  );
}

// A row already there takes this write's time when it is older: the release bounded by `upTo`
// (unlatchRules) belongs to whoever latched last, so an older tick's late cleanup cannot remove a
// latch a newer one wrote over it.
async function writeLatches(
  db: ScopedDb,
  scope: TriggerScope,
  keys: string[],
  at: Date,
): Promise<void> {
  const where = {
    agentId: scope.agentId,
    conversationId: scope.conversationId,
  };
  await db.decisionRuleState.createMany({
    data: keys.map((ruleKey) => ({
      tenantId: scope.tenantId,
      ...where,
      ruleKey,
      createdAt: at,
    })),
    skipDuplicates: true,
  });
  await db.decisionRuleState.updateMany({
    where: { ...where, ruleKey: { in: keys }, createdAt: { lt: at } },
    data: { createdAt: at },
  });
}

// The latches written ahead for actions that then wrote nothing, released by a tick that ended
// before it could write its whole state. Only rows written up to `upTo`: a later observation's
// latch on the same rule is its own.
export async function unlatchRules(
  base: PrismaClient,
  scope: TriggerScope,
  keys: string[],
  upTo: Date,
): Promise<void> {
  if (keys.length === 0) return;
  await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
    db.decisionRuleState.deleteMany({
      where: {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        ruleKey: { in: keys },
        createdAt: { lte: upTo },
      },
    }),
  );
}

// What a tick that finished releases, and the keys no rule of the block has any more (an edited or
// deleted rule's state goes with it). Its `latch` is not written here: every latch went out ahead
// of its action (latchRules), and writing it again at the end would undo a newer tick's release.
// Only rows written up to `upTo` (when the tick read the state, or last latched) are touched: two
// ticks can finish out of order, and a newer one's latch is not the older one's to remove.
export async function writeTriggerState(
  base: PrismaClient,
  scope: TriggerScope,
  change: TriggerStateChange,
  upTo: Date = new Date(),
): Promise<void> {
  const where = {
    agentId: scope.agentId,
    conversationId: scope.conversationId,
  };
  await runScopedOn(base, sysCtx(scope.tenantId), async (db) => {
    await db.decisionRuleState.deleteMany({
      where: {
        ...where,
        createdAt: { lte: upTo },
        OR: [
          { ruleKey: { notIn: change.keep } },
          ...(change.release.length > 0
            ? [{ ruleKey: { in: change.release } }]
            : []),
        ],
      },
    });
  });
}
