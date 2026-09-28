import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "./mode";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Whether the agent is OBSERVING now (enabled and in monitoring), asked after a turn stood down as
// `agent-unavailable`. Fails CLOSED as `unreadable`, never "no": a caller marks the burst handled on
// this answer and a monitoring agent arms no flush to read it later, so an unreadable row is retried.
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

// Whether the agent may still speak to the customer, read NOW rather than from the config the turn
// loaded: every send asks it (`writeCalledOff` in graph/runtime.ts, `stillWanted` in graph/nudge.ts).
// Fails OPEN, since an unreadable row is not evidence the agent was silenced. Never asked by the playground.
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
