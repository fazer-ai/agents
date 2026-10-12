// The decisions engine's trigger state (docs/decisions.md, "When a rule acts"): one row per rule
// that acted and is held back, keyed by `ruleStateKey`. THE INVARIANT: an older observation never
// changes the state a newer one read, except to withdraw its own reservation. Every read takes the
// next generation of (agent, conversation) in decision_rule_claims. A tick adds, releases or drops
// rows only while that generation is still its own (checked and locked in the same transaction),
// and otherwise deletes only rows it wrote itself for actions that never wrote (`undo`).

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
        generation,
      })),
      skipDuplicates: true,
    }),
  );
}

// A tick's own latches for actions that wrote nothing or never started: deleted whoever holds the
// claim now, since the row is this tick's and no newer one wrote it.
async function undoOwn(
  db: ScopedDb,
  scope: TriggerScope,
  generation: bigint,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  await db.decisionRuleState.deleteMany({
    where: {
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      ruleKey: { in: keys },
      generation,
    },
  });
}

// What a tick that finished owes (`release`, `undo`), and the keys no rule of the block has any
// more (an edited or deleted rule's state goes with it); also what a tick the deadline ended owes,
// with `keep` left out. Its `latch` is not written here: every latch went out ahead of its action
// (latchRules). `false` when a newer observation holds the claim: only `undo` was applied.
export async function writeTriggerState(
  base: PrismaClient,
  scope: TriggerScope,
  generation: bigint,
  change: Pick<TriggerStateChange, "release" | "undo"> & { keep?: string[] },
): Promise<boolean> {
  const held = await owned(base, scope, generation, (db) =>
    db.decisionRuleState.deleteMany({
      where: {
        agentId: scope.agentId,
        conversationId: scope.conversationId,
        OR: [
          ...(change.keep ? [{ ruleKey: { notIn: change.keep } }] : []),
          ...(change.release.length + change.undo.length > 0
            ? [{ ruleKey: { in: [...change.release, ...change.undo] } }]
            : []),
        ],
      },
    }),
  );
  if (!held) {
    await runScopedOn(base, sysCtx(scope.tenantId), (db) =>
      undoOwn(db, scope, generation, change.undo),
    );
  }
  return held;
}
