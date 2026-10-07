import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId } from "@/graph/checkpointer";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { authorizeContact, contactAuthFlowEvent } from "./service";
import { contactAuthHasRuleStage, readContactAuthConfig } from "./settings";

// The contact gate on the OBSERVER path (docs/contact-auth.md, The observer path). The gate decides
// which conversations a monitoring agent observes, before an observation is armed or a medium
// transcribed, so an out-of-scope conversation costs no job and no model call. Both stages run under
// the rules a responder follows: the conditions, then the endpoint when asked after them, or the
// endpoint alone when there are none. Asked once per arm; the tick re-checks only the conditions,
// since asking the endpoint again would double the calls for a verdict the arm just reached. A
// refusal, and an endpoint that fails, send nothing, open nothing and write no note; each leaves the
// same `contact_auth` line any verdict leaves.

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
  // Injectable for tests, as on every other caller of the gate.
  fetchImpl?: typeof fetch;
}

// The gate's answer for the watcher. `stage: "rule"` is the conditions alone, the tick's question;
// `"both"` is the whole gate, the arm's. `allowed` with nothing to ask (gate off, or the tick on a
// gate with no conditions), and then without a line, since no verdict was reached. `unreadable` is a
// read that failed, kept apart so the tick can retry it while the arm refuses it. `emit: false` is for
// the tick's own fence, asked at every tool hop: the tick's line says why it stopped, and a line per
// hop would only repeat the arm's.
async function observerGateVerdict(
  p: ObserverRuleParams,
  opts: { emit: boolean; stage: "rule" | "both" },
): Promise<"allowed" | "refused" | "unreadable"> {
  const cfg = readContactAuthConfig(p.settings);
  if (!cfg.enabled) return "allowed";
  if (opts.stage === "rule" && !contactAuthHasRuleStage(cfg)) return "allowed";
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
        select: {
          id: true,
          contactId: true,
          inboxId: true,
          inbox: { select: { chatwootInboxId: true, channelType: true } },
        },
      }),
    );
    const verdict = await authorizeContact({
      tenantId: p.tenantId,
      agentId: p.agentId,
      contactDbId: conv?.contactId ?? null,
      conversationDbId: conv?.id ?? null,
      conversationId: p.conversationId,
      // The endpoint's request carries the inbox it would for a responder. The message text never
      // travels from here: forwarding it exists so a customer can unlock themselves on their next
      // message, and an observer serves no customer to unlock.
      inboxId: conv?.inbox?.chatwootInboxId ?? null,
      channelType: conv?.inbox?.channelType ?? null,
      messageText: null,
      requestKey: "observe",
      stage: opts.stage,
      cfg,
      base: p.base,
      fetchImpl: p.fetchImpl,
    });
    if (opts.emit) {
      emitFlowEvent(
        {
          tenantId: p.tenantId,
          turnId: crypto.randomUUID(),
          source: "inbox",
          conversationId: conv?.id ?? null,
          agentId: p.agentId,
          inboxId: conv?.inboxId ?? null,
          threadId: chatwootThreadId(
            p.tenantId,
            p.instanceId,
            p.conversationId,
          ),
          base: p.base,
        },
        contactAuthFlowEvent(verdict),
      );
    }
    return verdict.outcome === "allowed" ? "allowed" : "refused";
  } catch (err) {
    logger.warn(
      "contact-auth: the observer's gate could not be evaluated (conv=%s agent=%s): %s",
      String(p.conversationId),
      String(p.agentId),
      err instanceof Error ? err.message : String(err),
    );
    return "unreadable";
  }
}

// The conditions alone, for the tick and its fence: an observation armed while they allowed it is
// asked again when it runs, so a label removed or a rule tightened in between keeps the model out.
export function observerRuleVerdict(
  p: ObserverRuleParams,
  opts: { emit: boolean },
): Promise<"allowed" | "refused" | "unreadable"> {
  return observerGateVerdict(p, { ...opts, stage: "rule" });
}

// Whether the watcher may observe this conversation, for the places that arm an observation: the
// whole gate, conditions and endpoint. A read that fails refuses, the gate's fail-closed direction: a
// missed observation is one tick, while an observed out-of-scope conversation is the model call the
// gate exists to prevent.
export async function observerArmAllows(
  p: ObserverRuleParams,
): Promise<boolean> {
  return (
    (await observerGateVerdict(p, { emit: true, stage: "both" })) === "allowed"
  );
}
