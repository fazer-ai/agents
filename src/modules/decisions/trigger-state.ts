// The decisions engine's trigger state (docs/decisions.md, "When a rule acts"): one row per rule
// that acted and is held back, keyed by `ruleStateKey`. THE INVARIANT: an older observation never
// changes the state a newer one read. Every read takes the next generation of (agent, conversation)
// in decision_rule_claims; every write or deletion first moves the claim row `WHERE generation =
// <its own>` in the same transaction, which also locks it until commit. A tick a newer observation
// has read past writes nothing (`false`): no latch, release, undo or drop.

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

export interface TriggerClaim {
  generation: bigint;
  latched: Set<string>;
}

// Takes the next generation and reads the state under it, in one transaction.
export async function claimTriggerState(
  base: PrismaClient,
  scope: TriggerScope,
): Promise<TriggerClaim> {
  const where = {
    agentId: scope.agentId,
    conversationId: scope.conversationId,
  };
  return runScopedOn(base, sysCtx(scope.tenantId), async (db) => {
    await db.decisionRuleClaim.createMany({
      data: [{ tenantId: scope.tenantId, ...where, generation: 0n }],
      skipDuplicates: true,
    });
    const claim = await db.decisionRuleClaim.update({
      where: { agentId_conversationId: where },
      data: { generation: { increment: 1n } },
      select: { generation: true },
    });
    const rows = await db.decisionRuleState.findMany({
      where,
      select: { ruleKey: true },
    });
    return {
      generation: claim.generation,
      latched: new Set(rows.map((r) => r.ruleKey)),
    };
  });
}

// Runs `write` only while `generation` is still the current one; false when a newer observation
// has read the state since.
async function owned(
  base: PrismaClient,
  scope: TriggerScope,
  generation: bigint,
  write: (db: ScopedDb) => Promise<unknown>,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(scope.tenantId), async (db) => {
    const held = await db.decisionRuleClaim.updateMany({
      where: {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        generation,
      },
      data: { generation },
    });
    if (held.count === 0) return false;
    await write(db);
    return true;
  });
}

// Latches written by the tick before it dispatches the actions they answer for (run.ts,
// LatchAhead).
export async function latchRules(
  base: PrismaClient,
  scope: TriggerScope,
  generation: bigint,
  keys: string[],
): Promise<boolean> {
  return owned(base, scope, generation, (db) =>
    db.decisionRuleState.createMany({
      data: keys.map((ruleKey) => ({
        tenantId: scope.tenantId,
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        ruleKey,
      })),
      skipDuplicates: true,
    }),
  );
}

// Releases, by a tick the deadline ended, of what it owes (DecisionProgress).
export async function unlatchRules(
  base: PrismaClient,
  scope: TriggerScope,
  generation: bigint,
  keys: string[],
): Promise<boolean> {
  return owned(base, scope, generation, (db) =>
    db.decisionRuleState.deleteMany({
      where: {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        ruleKey: { in: keys },
      },
    }),
  );
}

// What a tick that finished releases (`release`, `undo`), and the keys no rule of the block has any
// more (an edited or deleted rule's state goes with it). Its `latch` is not written here: every
// latch went out ahead of its action (latchRules).
export async function writeTriggerState(
  base: PrismaClient,
  scope: TriggerScope,
  generation: bigint,
  change: TriggerStateChange,
): Promise<boolean> {
  const gone = [...change.release, ...change.undo];
  return owned(base, scope, generation, (db) =>
    db.decisionRuleState.deleteMany({
      where: {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        OR: [
          { ruleKey: { notIn: change.keep } },
          ...(gone.length > 0 ? [{ ruleKey: { in: gone } }] : []),
        ],
      },
    }),
  );
}
