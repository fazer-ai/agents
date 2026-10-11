// The decisions engine's trigger state (docs/decisions.md, "When a rule acts"): which rules already
// acted in a conversation and are held back until their conditions stop holding (`on_start`) or for
// good (`once`). One row per such rule, keyed by `ruleStateKey`, read before the actions and written
// after them by the observation that decided.

import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
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
): Promise<void> {
  if (keys.length === 0) return;
  await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
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

// The latches written ahead for actions that then wrote nothing, released by a tick that ended
// before it could write its whole state.
export async function unlatchRules(
  base: PrismaClient,
  scope: TriggerScope,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
    db.decisionRuleState.deleteMany({
      where: {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        ruleKey: { in: keys },
      },
    }),
  );
}

// One transaction, so a crash between the steps cannot leave a released rule latched or a latch
// written for a key the same tick dropped. A key no rule of the block has any more is dropped too:
// the rule was edited or deleted, and its state goes with it.
export async function writeTriggerState(
  base: PrismaClient,
  scope: TriggerScope,
  change: TriggerStateChange,
): Promise<void> {
  const where = {
    agentId: scope.agentId,
    conversationId: scope.conversationId,
  };
  await runScopedOn(base, sysCtx(scope.tenantId), async (db) => {
    await db.decisionRuleState.deleteMany({
      where: {
        ...where,
        OR: [
          { ruleKey: { notIn: change.keep } },
          ...(change.release.length > 0
            ? [{ ruleKey: { in: change.release } }]
            : []),
        ],
      },
    });
    if (change.latch.length > 0) {
      await db.decisionRuleState.createMany({
        data: change.latch.map((ruleKey) => ({
          tenantId: scope.tenantId,
          ...where,
          ruleKey,
        })),
        skipDuplicates: true,
      });
    }
  });
}
