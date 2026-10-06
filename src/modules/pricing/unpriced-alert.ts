import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import type { UsageSource } from "@/graph/usage";
import { runScopedOn } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { monthStart } from "@/modules/spend-ceiling/decide";

// A MODEL THE LEDGER COULD NOT PRICE is announced on the `spend_ceiling` stage at warn, once per
// model per month per tenant, ceiling or not, Langfuse or not: every call to it is left out of the
// cost and of the ceiling's figure until someone acts.

// "Once" is the ledger's own answer, so it survives a restart: the row being written announces only
// when no EARLIER unpriced row of the model exists this month. Two first calls racing in separate
// transactions may both announce, the direction to err in. The set only spares repeated lookups.

const settled = new Set<string>();

function sysCtx(tenantId: bigint) {
  return { tenantId, userId: null, role: "TENANT_ADMIN" as const };
}

export async function announceUnpricedModel(params: {
  tenantId: bigint;
  model: string;
  source: UsageSource;
  rowId: bigint;
  now?: Date;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  const month = monthStart(params.now ?? new Date());
  const key = `${params.tenantId}:${month.toISOString()}:${params.model}`;
  if (settled.has(key)) return;
  try {
    const earlier = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.llmUsage.findFirst({
        where: {
          tenantId: params.tenantId,
          model: params.model,
          costUsd: null,
          createdAt: { gte: month },
          id: { lt: params.rowId },
        },
        select: { id: true },
      }),
    );
    settled.add(key);
    if (earlier) return;
  } catch (err) {
    logger.warn(
      { err, tenantId: String(params.tenantId) },
      "unpriced model: could not check for an earlier announcement",
    );
    return;
  }
  const model = params.model === "" ? "(unnamed model)" : params.model;
  emitFlowEvent(
    {
      tenantId: params.tenantId,
      turnId: crypto.randomUUID(),
      source: params.source,
      base,
    },
    {
      stage: "spend_ceiling",
      level: "warn",
      status: "ok",
      detail: { subject: "unpriced", models: [params.model] },
      errorMessage: `No price for ${model}: its calls are left out of the cost and the spend ceiling. Set this account's own price for it (Advanced > Model prices), then re-price the calls already made (scripts/reprice-usage.ts).`,
    },
  );
}

// Tests only: the set is process state, and a suite that reuses a model name across tenants or
// months must not inherit another case's answer.
export function resetUnpricedAnnouncements(): void {
  settled.clear();
}
