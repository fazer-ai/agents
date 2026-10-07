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

export interface ObserverMessage {
  id: number;
  text: string | null;
}

// What the observer's ask carries, under the responder's contract: with `includeMessageText` the
// text of the message that armed it, and a key per message (as a responder's `msg:` key), so two
// messages are two questions; otherwise no text and one key per conversation. Shared with the media
// pass of a bound watcher (chatwoot/webhook.ts), so the pass and the arm put the same question.
export function observerAsk(
  cfg: { includeMessageText: boolean },
  conversationId: number,
  message: ObserverMessage | null | undefined,
): { messageText: string | null; requestKey: string } {
  if (cfg.includeMessageText && message) {
    return {
      messageText: message.text,
      requestKey: `observe:${conversationId}:msg:${message.id}`,
    };
  }
  return { messageText: null, requestKey: `observe:${conversationId}` };
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
  // The message that armed this ask, for an endpoint that forwards the text
  // (`includeMessageText`); none on a resolve.
  message?: ObserverMessage | null;
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
      // The endpoint's request carries what it would for a responder: the inbox, and with
      // `includeMessageText` the arming message's text (`observerAsk`).
      inboxId: conv?.inbox?.chatwootInboxId ?? null,
      channelType: conv?.inbox?.channelType ?? null,
      ...observerAsk(cfg, p.conversationId, p.message),
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
    // Only a refusal by the conditions is one the tick can reach again; the endpoint's, and one
    // reached before either stage (a conversation with no contact yet), are not.
    return verdict.stage === "rule" ? "refused" : "endpoint_refused";
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
  if (unretiredRefusals.has(refusalKey(p))) return Promise.resolve("refused");
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
  if (verdict === "allowed") {
    const key = refusalKey(p);
    rememberAllow(key, askedAt);
    const refusedAt = unretiredRefusals.get(key);
    if (refusedAt !== undefined && refusedAt < askedAt) {
      unretiredRefusals.delete(key);
    }
    return { askedAt };
  }
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
  // Fenced in memory before the first write, so a tick due while the writes retry already hears
  // the refusal. Ordered by when the verdicts were asked, not when their bookkeeping ends: an allow
  // asked after this refusal already answered for the conversation.
  const key = refusalKey(p);
  if ((recentAllows.get(key) ?? 0) < askedAt) {
    unretiredRefusals.set(
      key,
      Math.max(unretiredRefusals.get(key) ?? 0, askedAt),
    );
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await retireRefusedObserve({ ...p, askedAt });
      // Only what this retirement covers: a refusal asked after it keeps its own mark.
      const kept = unretiredRefusals.get(key);
      if (kept !== undefined && kept <= askedAt) unretiredRefusals.delete(key);
      return;
    } catch (err) {
      if (attempt >= RETIRE_ATTEMPTS) {
        // The fence stays in this process, where the tick asks it (`observerRuleVerdict`): the
        // database that refused the write is the one the tick will be claimed from once it is back.
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

// Refusals whose retirement never reached the database, by watcher and conversation, with the time
// each was asked. Cleared by a retirement that lands or by an allow asked after it. In memory: a
// tick claimed by another replica does not see it (docs/contact-auth.md, The observer path).
const unretiredRefusals = new Map<string, number>();

// The newest allow asked per watcher and conversation, so a refusal whose retries end after a newer
// allow does not fence it. Bounded, oldest first out: an allow older than the cap's reach is older
// than any retirement still retrying.
const recentAllows = new Map<string, number>();
const RECENT_ALLOWS_CAP = 10_000;

function rememberAllow(key: string, askedAt: number): void {
  const before = recentAllows.get(key) ?? 0;
  recentAllows.delete(key);
  recentAllows.set(key, Math.max(before, askedAt));
  if (recentAllows.size > RECENT_ALLOWS_CAP) {
    const oldest = recentAllows.keys().next().value;
    if (oldest !== undefined) recentAllows.delete(oldest);
  }
}

function refusalKey(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint;
}): string {
  return `${p.tenantId}:${p.instanceId}:${p.conversationId}:${p.agentId}`;
}
