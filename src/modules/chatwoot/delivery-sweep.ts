import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId } from "@/graph/checkpointer";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { armDebounce } from "@/modules/debounce/service";
import type { DebounceConfig } from "@/modules/debounce/settings";
import { WINDOW_MIN_SECONDS } from "@/modules/debounce/settings";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "./stranded-delivery";

// Recovers Chatwoot deliveries stranded on PROCESSING (issue #228). One DELIVERY_SWEEP job per
// tenant, armed at boot and self-rearming, on the ordinary scheduler lane.
//
// The recovery is NOT a replay of the delivery. The event body is gone with the process that held
// it, and it is not stored: `coalesceAndRunTurn` opens by re-reading the conversation's messages
// from Chatwoot, so the flush already has the only copy that matters. All the sweep has to do is
// re-arm the conversation's flush and let the flush decide, against the handled watermark, whether
// anything is still owed an answer. That is why the ledger grew ONE integer (the conversation's
// display id) rather than an encrypted payload column with a retention window.
//
// The re-arm is safe in every case, which is what makes a coarse staleness threshold acceptable:
//
//   * the delivery stranded before the burst was armed → the watermark never advanced, the flush
//     finds the customer's message pending and answers it. This is the case the issue is about;
//   * the delivery stranded after arming, or after the watermark advanced → the flush finds nothing
//     above the watermark and returns "empty";
//   * a flush is already armed for that conversation → `armDebounce` upserts one row per thread and
//     keeps the running burst's start stamp, so the recovery folds into it instead of racing it;
//   * the conversation stopped being the bot's → the flush's own ownership gate closes, and leaves
//     the trail it leaves for any other handoff.

// Longer than any legitimate delivery: the direct path runs the agent turn INSIDE
// `processChatwootDelivery` (model plus tool calls, no ceiling of its own), so a threshold in
// minutes is what separates "nobody is working this" from "somebody still is". Deliberately not an
// env var — it is a property of how the delivery path is built, not something an operator tunes.
const STALE_AFTER_MS = 10 * 60 * 1000;
// Cadence of the sweep itself. A stranded delivery is a customer waiting on a reply, so recovery is
// measured in minutes; the scan is one indexed read per tenant.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Bounds a row whose recovery keeps failing, so a poisoned delivery cannot cycle forever. Reached
// only when the re-arm itself throws: a successful re-arm makes the row terminal on the first pass.
const MAX_RECOVERY_ATTEMPTS = 3;
// How many stranded rows one pass handles. A bound, not a budget: strands come from process deaths,
// so a pass normally finds none, and a backlog is drained over consecutive passes.
const BATCH = 200;

// The window a recovery flush waits before running. The agent's own `settings.debounce` window is
// deliberately NOT consulted: it says how long to coalesce a LIVE burst of typing, and this burst
// stopped being live when the process holding it died. A disabled debounce is the same case — the
// agent answers without coalescing, but the flush is still how an already-sent message gets
// answered once the delivery that should have answered it is gone.
const RECOVERY_DEBOUNCE_CFG: DebounceConfig = {
  enabled: true,
  windowSeconds: WINDOW_MIN_SECONDS,
  maxMessagesPerBurst: 20,
  maxWindowSeconds: 60,
};

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface StrandedRow {
  id: bigint;
  chatwootInstanceId: bigint;
  deliveryId: string;
  event: string;
  receivedAt: Date;
  attempts: number;
  conversationId: number | null;
}

// Re-arms one conversation's flush. Returns false when the mirror cannot say who the bot is on that
// conversation, which is the one strand this design cannot recover: a death between the CAS and the
// mirror write leaves no row to read the inbox and the bot's identity from. That answer is NOT the
// same as a quiet success — see applyVerdict, where it is what separates a recovered message from a
// lost one in the ledger.
//
// `agentBotId` is derived rather than stored because the flush uses it for ONE thing — deciding
// whether an AgentBot assignee is us or a different persona's bot — and the mirror plus the bot
// registry answer that as well as the spent delivery would have.
async function rearmConversationFlush(
  params: {
    tenantId: bigint;
    instanceId: bigint;
    conversationId: number;
  },
  base: PrismaClient,
): Promise<boolean> {
  const { tenantId, instanceId, conversationId } = params;
  const agentBotId = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { inboxId: true },
    });
    if (!conv?.inboxId) return undefined;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return undefined;
    const bot = await db.chatwootAgentBot.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: inbox.agentId,
      },
      select: { chatwootAgentBotId: true },
    });
    return bot?.chatwootAgentBotId ?? undefined;
  });
  if (agentBotId === undefined) return false;
  await armDebounce({
    tenantId,
    threadId: chatwootThreadId(tenantId, instanceId, conversationId),
    agentBotId,
    cfg: RECOVERY_DEBOUNCE_CFG,
    base,
  });
  return true;
}

// Applies one verdict, and leaves the row saying WHICH of the two terminal things happened:
//
//   PROCESSED — there is no customer message outstanding on this row. Either the flush was re-armed
//               and will answer it, or the event named no conversation and carried none.
//   DEAD      — a message was lost. The recovery could not run at all (the mirror does not know the
//               conversation) or ran and kept failing until the attempt bound.
//
// The distinction is the whole operator-facing value of the sweep: `WHERE status = 'DEAD'` is the
// list of customers who wrote and were never answered, and collapsing it into PROCESSED would make a
// lost message and a recovered one look identical in the only place either is recorded.
//
// Every branch except "in-flight" is terminal or one attempt closer to terminal, so a row can never
// be classified forever.
async function applyVerdict(
  verdict: StrandedVerdict,
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
): Promise<void> {
  const label = `${row.deliveryId} (${row.event})`;
  const finish = (status: "PROCESSED" | "DEAD" | "PROCESSING") =>
    runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status,
          attempts: { increment: 1 },
          ...(status === "PROCESSING" ? {} : { processedAt: new Date() }),
        },
      }),
    );

  if (verdict === "unrecoverable") {
    logger.info(
      "chatwoot delivery sweep: %s stranded with no conversation to recover; closing",
      label,
    );
    await finish("PROCESSED");
    return;
  }
  if (verdict === "exhausted") {
    logger.error(
      "chatwoot delivery sweep: %s could not be recovered in %d attempts; giving up (the customer's message on conversation %s is unanswered)",
      label,
      row.attempts,
      String(row.conversationId),
    );
    await finish("DEAD");
    return;
  }
  // "recover"
  try {
    const rearmed = await rearmConversationFlush(
      {
        tenantId,
        instanceId: row.chatwootInstanceId,
        conversationId: row.conversationId as number,
      },
      base,
    );
    if (!rearmed) {
      // The one window this design does not close: the process died between the CAS and the mirror
      // write, so there is no row to read the inbox and the bot's identity from, and the flush has
      // nothing to be armed against. Recorded as a loss rather than swallowed.
      logger.error(
        "chatwoot delivery sweep: %s stranded on conversation %s the mirror does not know; the customer's message is lost",
        label,
        String(row.conversationId),
      );
      await finish("DEAD");
      return;
    }
    logger.info(
      "chatwoot delivery sweep: %s stranded on PROCESSING; re-armed the flush for conversation %s",
      label,
      String(row.conversationId),
    );
    await finish("PROCESSED");
  } catch (err) {
    logger.warn(
      "chatwoot delivery sweep: re-arm failed for %s (conv=%s): %s — leaving it for the next pass",
      label,
      String(row.conversationId),
      err instanceof Error ? err.message : String(err),
    );
    await finish("PROCESSING");
  }
}

export interface SweepStrandedDeliveriesParams {
  tenantId: bigint;
  base: PrismaClient;
  now?: Date;
}

// One pass for one tenant. Exported for the tests, which drive it directly rather than through the
// scheduler tick.
export async function sweepStrandedDeliveries(
  params: SweepStrandedDeliveriesParams,
): Promise<Record<StrandedVerdict, number>> {
  const { tenantId, base } = params;
  const now = params.now ?? new Date();
  const counts: Record<StrandedVerdict, number> = {
    "in-flight": 0,
    recover: 0,
    unrecoverable: 0,
    exhausted: 0,
  };
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findMany({
      where: { status: "PROCESSING" },
      orderBy: { receivedAt: "asc" },
      take: BATCH,
      select: {
        id: true,
        chatwootInstanceId: true,
        deliveryId: true,
        event: true,
        receivedAt: true,
        attempts: true,
        conversationId: true,
      },
    }),
  );
  for (const row of rows) {
    const verdict = classifyStrandedDelivery(row, {
      now,
      staleAfterMs: STALE_AFTER_MS,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
    });
    counts[verdict] += 1;
    if (verdict === "in-flight") continue;
    await applyVerdict(verdict, row, tenantId, base);
  }
  return counts;
}

async function deliverySweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await sweepStrandedDeliveries({ tenantId: job.tenantId, base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
  };
}

let registered = false;
export function registerDeliverySweepHandler(): void {
  if (registered) return;
  registerJobHandler("DELIVERY_SWEEP", deliverySweepHandler);
  registered = true;
}

// Arms the per-tenant sweep (idempotent — enqueueJob upserts one live row per (tenant, kind,
// dedupeKey), re-arming run_at). The first pass is a sweep interval out: a boot is exactly when a
// deploy has just stranded rows, and they are not stale yet.
export async function ensureDeliverySweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "DELIVERY_SWEEP",
    dedupeKey: "delivery-sweep",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    base,
  });
}

// Arms the sweep for every existing tenant (called once at boot). Same best-effort discipline as
// ensureAllFlowlogSweeps: one tenant failing must not deprive every later tenant of its re-arm.
export async function ensureAllDeliverySweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      await ensureDeliverySweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "delivery sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
