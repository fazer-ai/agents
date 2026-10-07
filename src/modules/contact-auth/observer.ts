import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId } from "@/graph/checkpointer";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { retireRefusedObserve } from "@/modules/observe/job";
import { authorizeContact, contactAuthFlowEvent } from "./service";
import {
  contactAuthHasEndpointStage,
  contactAuthHasRuleStage,
  readContactAuthConfig,
} from "./settings";

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
  // The pause between retirement attempts (`observerArmPermit`), a seam for tests.
  sleep?: (ms: number) => Promise<void>;
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
): Promise<"allowed" | "refused" | "endpoint_refused" | "unreadable"> {
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
      // Per conversation: the endpoint may answer by the conversation's inbox or id, so two
      // conversations of one contact are two questions.
      requestKey: `observe:${p.conversationId}`,
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
    if (verdict.outcome === "allowed") return "allowed";
    return verdict.stage === "endpoint" ? "endpoint_refused" : "refused";
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
  return observerGateVerdict(p, { ...opts, stage: "rule" }).then((v) =>
    v === "endpoint_refused" ? "refused" : v,
  );
}

// Whether the watcher may observe this conversation, for the places that arm an observation: the
// whole gate, conditions and endpoint. A read that fails refuses, the gate's fail-closed direction: a
// missed observation is one tick, while an observed out-of-scope conversation is the model call the
// gate exists to prevent. An allow is a permit carrying when it was asked, which the arm hands to
// `armObserve` so a denial asked later wins over it. The ENDPOINT's refusal or failure retires the
// observation an earlier allow left queued (`retireRefusedObserve`), since the tick re-checks only
// the conditions and would otherwise analyze what the endpoint now refuses; the conditions' own
// refusal needs no such step, the tick asks them again. A tick already running is not stopped.
export async function observerArmPermit(
  p: ObserverRuleParams,
): Promise<{ askedAt: number } | null> {
  const askedAt = Date.now();
  const verdict = await observerGateVerdict(p, { emit: true, stage: "both" });
  if (verdict === "allowed") return { askedAt };
  // A gate that could not be read on one that asks an endpoint is taken as the endpoint's no: the
  // tick will not ask it, so an earlier allow's observation would otherwise run on a verdict nobody
  // could confirm.
  const takesBack =
    verdict === "endpoint_refused" ||
    (verdict === "unreadable" &&
      contactAuthHasEndpointStage(readContactAuthConfig(p.settings)));
  if (takesBack) await retireWithRetries(p, askedAt);
  return null;
}

// The retirement is what keeps a queued tick from analyzing a refused conversation, so a write that
// fails is tried again before it is given up on, with a warning: by then the database is down, and
// the tick, which needs it too, waits on it as well.
async function retireWithRetries(
  p: ObserverRuleParams,
  askedAt: number,
): Promise<void> {
  const nap =
    p.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await retireRefusedObserve({ ...p, askedAt });
      return;
    } catch (err) {
      if (attempt >= RETIRE_ATTEMPTS) {
        logger.warn(
          "contact-auth: could not retire the refused conversation's queued observation (conv=%s agent=%s): %s",
          String(p.conversationId),
          String(p.agentId),
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      await nap(100 * 4 ** (attempt - 1));
    }
  }
}

const RETIRE_ATTEMPTS = 3;
