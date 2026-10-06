import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import type { UsageSource } from "@/graph/usage";
import { runScopedOn } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { monthStart } from "@/modules/spend-ceiling/decide";

// A MODEL THE LEDGER COULD NOT PRICE is announced on the `spend_ceiling` stage at warn, once per
// model per month per tenant and per source, ceiling or not, Langfuse or not: every call to it is
// left out of the cost and of the ceiling's figure until someone acts. Per source because only the
// inbox's line reaches the alert channels, so a playground line must not use up the inbox's.

// "Once" is the announcement's own record: a model is announced unless this month's flow log already
// holds the line for it, so a restart does not repeat it and an upgrade does not count unpriced rows
// written before the alert existed as a warning someone received. Two first calls in separate
// processes may both announce, the direction to err in; within a process the set holds the key from
// the first lookup on.

const settled = new Set<string>();

function sysCtx(tenantId: bigint) {
  return { tenantId, userId: null, role: "TENANT_ADMIN" as const };
}

export async function announceUnpricedModel(params: {
  tenantId: bigint;
  model: string;
  source: UsageSource;
  now?: Date;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  const month = monthStart(params.now ?? new Date());
  const key = `${params.tenantId}:${params.source}:${month.toISOString()}:${params.model}`;
  if (settled.has(key)) return;
  settled.add(key);
  try {
    const said = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.executionLog.findFirst({
        where: {
          tenantId: params.tenantId,
          stage: "spend_ceiling",
          source: params.source,
          createdAt: { gte: month },
          detail: { path: ["unpricedModel"], equals: params.model },
        },
        select: { id: true },
      }),
    );
    if (said) return;
  } catch (err) {
    settled.delete(key);
    logger.warn(
      { err, tenantId: String(params.tenantId) },
      "unpriced model: could not check for an earlier announcement",
    );
    return;
  }
  const model = params.model === "" ? "(unnamed model)" : params.model;
  // Awaited, so a line that did not land releases the key and the next call tries again.
  const { delivered } = await writeFlowEvent(
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
      detail: {
        subject: "unpriced",
        models: [params.model],
        unpricedModel: params.model,
      },
      errorMessage: `No price for ${model}: its calls are left out of the cost and the spend ceiling. Set this account's own price for it (Advanced > Model prices), then re-price the calls already made (scripts/reprice-usage.ts).`,
    },
  );
  if (!delivered) settled.delete(key);
}

// Tests only: the set is process state, and a suite that reuses a model name across tenants or
// months must not inherit another case's answer.
export function resetUnpricedAnnouncements(): void {
  settled.clear();
}
