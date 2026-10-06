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

// "Once" is a row in `unpriced_model_announcements`, inserted with ON CONFLICT DO NOTHING: whoever
// inserts it announces, across processes and restarts, and no retention prunes it before the month
// ends. A line that did not land deletes the row so the next call tries again. The set only spares
// the insert for a key this process already settled.

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
  const claim = {
    tenantId: params.tenantId,
    source: params.source,
    monthStart: month,
    model: params.model,
  };
  let claimed: boolean;
  try {
    claimed = await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
      const inserted = await db.unpricedModelAnnouncement.createMany({
        data: [claim],
        skipDuplicates: true,
      });
      return inserted.count === 1;
    });
  } catch (err) {
    settled.delete(key);
    logger.warn(
      { err, tenantId: String(params.tenantId) },
      "unpriced model: could not claim the announcement",
    );
    return;
  }
  if (!claimed) return;
  const model = params.model === "" ? "(unnamed model)" : params.model;
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
      detail: { subject: "unpriced", models: [params.model] },
      errorMessage: `No price for ${model}: its calls are left out of the cost and the spend ceiling. Set this account's own price for it (Advanced > Model prices), then re-price the calls already made (scripts/reprice-usage.ts).`,
    },
  );
  if (delivered) return;
  settled.delete(key);
  await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.unpricedModelAnnouncement.deleteMany({ where: claim }),
  ).catch((err) =>
    logger.warn(
      { err, tenantId: String(params.tenantId) },
      "unpriced model: could not release the claim of a line that did not land",
    ),
  );
}

// Tests only: the set is process state, and a suite that reuses a model name across tenants or
// months must not inherit another case's answer.
export function resetUnpricedAnnouncements(): void {
  settled.clear();
}
