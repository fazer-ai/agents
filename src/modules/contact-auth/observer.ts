import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId } from "@/graph/checkpointer";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { authorizeContact, contactAuthFlowEvent } from "./service";
import { contactAuthHasRuleStage, readContactAuthConfig } from "./settings";

// The contact gate on the OBSERVER path (docs/contact-auth.md, The observer path). A monitoring agent
// answers nobody, so only the rule stage applies to it: the rule decides which conversations are
// observed, before an observation is armed or a medium transcribed, so an out-of-scope conversation
// costs no job and no model call. The endpoint stage never runs here: its question is whether a
// contact may be SERVED, and an observer serves nobody. A refusal sends nothing, opens nothing and
// writes no note; it leaves the same `contact_auth` line any verdict leaves.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface ObserverRuleParams {
  tenantId: bigint;
  instanceId: bigint;
  // Chatwoot's display id of the conversation.
  conversationId: number;
  agentId: bigint;
  // The watcher's settings bag, the one its observation is armed under.
  settings: unknown;
  base: PrismaClient;
}

// Whether the watcher may observe this conversation. True with no rule to ask (gate off, or an
// endpoint-only gate, whose stage does not run here), and without a line: no verdict was reached.
// A read that fails refuses, the gate's fail-closed direction: a missed observation is one tick,
// while an observed out-of-scope conversation is the model call the rule exists to prevent.
export async function observerRuleAllows(
  p: ObserverRuleParams,
): Promise<boolean> {
  const cfg = readContactAuthConfig(p.settings);
  if (!cfg.enabled || !contactAuthHasRuleStage(cfg)) return true;
  try {
    const conv = await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
      db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId: p.tenantId,
            chatwootInstanceId: p.instanceId,
            chatwootConversationId: p.conversationId,
          },
        },
        select: { id: true, contactId: true, inboxId: true },
      }),
    );
    const verdict = await authorizeContact({
      tenantId: p.tenantId,
      agentId: p.agentId,
      contactDbId: conv?.contactId ?? null,
      conversationDbId: conv?.id ?? null,
      conversationId: p.conversationId,
      inboxId: null,
      channelType: null,
      messageText: null,
      requestKey: "observe",
      stage: "rule",
      cfg,
      base: p.base,
    });
    emitFlowEvent(
      {
        tenantId: p.tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: conv?.id ?? null,
        agentId: p.agentId,
        inboxId: conv?.inboxId ?? null,
        threadId: chatwootThreadId(p.tenantId, p.instanceId, p.conversationId),
        base: p.base,
      },
      contactAuthFlowEvent(verdict),
    );
    return verdict.outcome === "allowed";
  } catch (err) {
    logger.warn(
      "contact-auth: the observer's rule could not be evaluated (conv=%s agent=%s), not observing: %s",
      String(p.conversationId),
      String(p.agentId),
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
