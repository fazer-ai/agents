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

// "Once" is a row in `unpriced_model_announcements`: whoever inserts it announces, across processes
// and restarts, and no retention prunes it before the month ends. Only a row marked delivered
// silences the model. A line that did not land deletes the row; a row nobody could mark or delete
// (the database gone between the claim and the line) is taken over after CLAIM_LEASE_MS, so the
// worst case is a second line, never a silent month. The set spares the queries for a delivered key.

const CLAIM_LEASE_MS = 5 * 60 * 1000;

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
  const ctx = sysCtx(params.tenantId);
  const warn = (err: unknown, msg: string) =>
    logger.warn({ err, tenantId: String(params.tenantId) }, msg);
  let outcome: "won" | "delivered" | "pending";
  try {
    outcome = await runScopedOn(base, ctx, async (db) => {
      const at = new Date();
      const inserted = await db.unpricedModelAnnouncement.createMany({
        data: [{ ...claim, claimedAt: at }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) return "won";
      const taken = await db.unpricedModelAnnouncement.updateMany({
        where: {
          ...claim,
          deliveredAt: null,
          claimedAt: { lt: new Date(at.getTime() - CLAIM_LEASE_MS) },
        },
        data: { claimedAt: at },
      });
      if (taken.count === 1) return "won";
      const row = await db.unpricedModelAnnouncement.findFirst({
        where: claim,
        select: { deliveredAt: true },
      });
      return row?.deliveredAt ? "delivered" : "pending";
    });
  } catch (err) {
    settled.delete(key);
    warn(err, "unpriced model: could not claim the announcement");
    return;
  }
  if (outcome === "delivered") return;
  // Another call holds a claim still in its lease: it may yet fail, so this key is asked again.
  if (outcome === "pending") {
    settled.delete(key);
    return;
  }
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
  if (delivered) {
    await runScopedOn(base, ctx, (db) =>
      db.unpricedModelAnnouncement.updateMany({
        where: claim,
        data: { deliveredAt: new Date() },
      }),
    ).catch((err) =>
      warn(err, "unpriced model: the line landed but its claim was not marked"),
    );
    return;
  }
  // The key stays settled until the claim is gone: a call in between would find the claim and take
  // it for one in flight.
  await runScopedOn(base, ctx, (db) =>
    db.unpricedModelAnnouncement.deleteMany({
      where: { ...claim, deliveredAt: null },
    }),
  ).catch((err) =>
    warn(
      err,
      "unpriced model: could not release the claim of a line that did not land",
    ),
  );
  settled.delete(key);
}

// Tests only: the set is process state, and a suite that reuses a model name across tenants or
// months must not inherit another case's answer.
export function resetUnpricedAnnouncements(): void {
  settled.clear();
}
