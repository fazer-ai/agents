import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "./mode";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Whether the agent may still speak to the customer, read NOW. The two operator settings that
// silence an agent — the switch and the mode — are read once, when a turn loads its config, and a
// reactive turn or a proactive nudge is a model call old by the first send and several waits old by
// the last. An operator who switches the agent off or flips it to monitoring inside that stretch
// must not see one more message go out (issue #209 review), so this rides the fence every send
// asks — `writeCalledOff` in graph/runtime.ts, `stillWanted` in graph/nudge.ts — rather than a
// check beside the model call, which the next wait would grow a window past.
//
// Fails OPEN: an unreadable row is not evidence the agent was silenced, and the ownership recheck
// beside this one refuses on its own evidence. The one place this must not be asked is the
// playground, whose reply is to an operator and never to a customer.
// The caller's second question, after a turn stood down as `agent-unavailable`: is the agent
// OBSERVING now — enabled and in monitoring — so the burst it did not answer is the observer's to
// fold into memory and mark handled? Fails CLOSED, the opposite of the fence above: this answer
// hands messages to ingestion and moves a watermark, and an unreadable row is not evidence that
// anybody is watching.
// Three answers and not two (round 20): the callers that hand a message or a burst to the
// observer's ingestion mark it handled on the strength of this answer, and a read that failed,
// collapsed into "no", would leave the message marked and remembered by nobody — a monitoring
// agent arms no flush that could read it later. Reported as unreadable, it is theirs to retry: the
// flush fails for the scheduler, the receiver leaves the delivery for the sweep.
export type ObservesNow = "yes" | "no" | "unreadable";

export async function agentObservesNow(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ObservesNow> {
  try {
    const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true },
      }),
    );
    return agent?.enabled === true && isMonitoring(agent.mode) ? "yes" : "no";
  } catch (err) {
    logger.warn(
      { err, agentId: String(agentId) },
      "agent: could not read whether the agent observes now; reporting it unreadable for a retry",
    );
    return "unreadable";
  }
}

export async function agentStillSpeaks(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  try {
    const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true },
      }),
    );
    if (!agent) return false;
    const speaks = agent.enabled && !isMonitoring(agent.mode);
    if (!speaks) {
      logger.info(
        { agentId: String(agentId), enabled: agent.enabled, mode: agent.mode },
        "agent: switched off or flipped to monitoring since this run loaded its config; standing down",
      );
    }
    return speaks;
  } catch (err) {
    logger.warn(
      { err, agentId: String(agentId) },
      "agent: could not re-read the switch and the mode at the send boundary; sending",
    );
    return true;
  }
}
