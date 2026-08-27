import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { loadAgentConfig } from "@/graph/prepare";
import type { RunAgentTurnOutcome, RuntimeDeps } from "@/graph/runtime";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  type ChatwootMessageRow,
  parseChatwootMessages,
  pendingIncoming,
} from "@/modules/chatwoot/messages";
import { shouldBotHandle } from "@/modules/chatwoot/normalize";
import type { AuthContext } from "@/modules/contact-auth/check";
import {
  authorizeContact,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import { coalesceAndRunTurn } from "@/modules/debounce/handler";
import { readHandledWatermark } from "@/modules/debounce/watermark";
import { emitFlowEvent } from "@/modules/flowlog/service";
import {
  announceSpendCeiling,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import { clearConversationError } from "./error";

// Manual re-engage (item 6): re-fire the agent turn on a conversation WITHOUT waiting for a new
// customer message — the recovery path after a failed turn. It answers the unanswered tail (every
// incoming message after the last outgoing one), reusing the debounce flush's coalesce machinery
// (watermark CAS = at-most-once, so a double click or a racing flush posts at most once). Honors the
// assignee gate: if a human owns the conversation it does nothing (the operator should "return to
// agent" first), and the contact-authorization gate, because this path RUNS the model and SENDS its
// answer. Clears the conversation's lastError on a successful post.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function requireTenant(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) {
    throw new TenantTargetRequiredError();
  }
  return ctx.tenantId;
}

// The unanswered tail: incoming customer messages after the last outgoing/template message (what the
// customer said that we have not replied to). No outgoing yet ⇒ the whole page (first turn failed).
//
// A PRIVATE outgoing message is a note to the operator's own team, not a reply, and Chatwoot stores
// it after the message it is about — so counting one as the last reply makes the tail empty and the
// re-engage a no-op. The conversations most likely to be re-engaged are exactly the ones carrying
// such a note: a failed turn, an out-of-hours notice, a contact-authorization refusal. Same reason
// `pendingIncoming` skips private messages on the incoming side.
function incomingAfterLastOutgoing(
  messages: ChatwootMessageRow[],
): ChatwootMessageRow[] {
  let lastOut = 0;
  for (const m of messages) {
    if (
      (m.messageType === "outgoing" || m.messageType === "template") &&
      !m.private &&
      m.id > lastOut
    ) {
      lastOut = m.id;
    }
  }
  return pendingIncoming(messages, lastOut > 0 ? lastOut : null);
}

export type ReengageOutcome =
  | RunAgentTurnOutcome
  | "empty"
  | "gate-closed"
  | "not-authorized"
  // The tenant is past its month's tokens. Its own outcome rather than a silent no-reply, because
  // this path is an operator pressing a button: they are owed the reason, and it is one they can
  // act on from the settings page.
  | "over-ceiling";

export interface ReengageResult {
  outcome: ReengageOutcome;
}

export async function reengageConversation(
  ctx: TenantContext,
  conversationDbId: bigint,
  deps: RuntimeDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ReengageResult> {
  const tenantId = requireTenant(ctx);

  // Scoped read: resolve the conversation + its inbox's agent config (DB only; network is the turn).
  const resolved = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: { id: conversationDbId },
      select: {
        id: true,
        chatwootInstanceId: true,
        chatwootConversationId: true,
        threadId: true,
        status: true,
        assigneeType: true,
        assigneeId: true,
        inboxId: true,
      },
    });
    if (!conv) return "not-found" as const;
    if (!conv.inboxId) return "no-agent" as const;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, chatwootInboxId: true },
    });
    if (!inbox?.agentId) return "no-agent" as const;
    const agentRow = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { settings: true },
    });
    const loaded = await loadAgentConfig(db, {
      tenantId,
      instanceId: conv.chatwootInstanceId,
      conversationId: conv.chatwootConversationId,
      agentId: inbox.agentId,
      threadId: conv.threadId,
    });
    if (!loaded) return "no-agent" as const;
    return {
      convDbId: conv.id,
      instanceId: conv.chatwootInstanceId,
      conversationId: conv.chatwootConversationId,
      inboxChatwootId: inbox.chatwootInboxId,
      threadId: conv.threadId,
      status: conv.status,
      assigneeType: conv.assigneeType,
      assigneeId: conv.assigneeId,
      loaded,
      settings: agentRow?.settings ?? {},
    };
  });

  if (resolved === "not-found") {
    throw new NotFoundError(
      "conversation not found",
      "errors.conversationNotFound",
    );
  }
  if (resolved === "no-agent") {
    throw new AppError(
      "no agent is bound to this conversation's inbox",
      400,
      "errors.reengageNoAgent",
    );
  }

  // Assignee gate: never re-fire over a conversation a human owns (they should "return to agent"
  // first). runLoadedTurn re-checks before posting too, but gating early avoids a wasted LLM call.
  const gateOpen = shouldBotHandle(
    {
      assigneeType: resolved.assigneeType,
      assigneeId: resolved.assigneeId,
      status: resolved.status,
    },
    { ourAgentBotId: resolved.loaded.agentBotId },
  );
  if (!gateOpen) return { outcome: "gate-closed" };

  // WHAT THIS CLICK WOULD ANSWER, computed once and used twice: here, to decide whether there is a
  // turn at all, and inside `coalesceAndRunTurn`, to build it. One expression rather than two,
  // because the pre-check and the turn disagreeing is how a gate ends up refusing work that was
  // never going to happen (or letting through work it should have stopped).
  const authCfg = resolved.loaded.contactAuthConfig;
  const selectPending = authCfg.enabled
    ? async (messages: ChatwootMessageRow[]) => {
        // With the gate on, the tail is filtered by the handled watermark as well, re-read at the
        // point the burst is chosen. The authorization call below is a round-trip to somebody
        // else's endpoint, and a message that arrived and was REFUSED during it has already had the
        // watermark advanced past it by its own delivery — but the tail is chosen from the last
        // OUTGOING message, which a refusal never writes, so that refused message would be handed
        // straight to the model. "No turn for a contact the endpoint will not vouch for" is a
        // statement about turns, and this is one. The same guard the debounce flush carries.
        //
        // Only with the gate on: this floor is not free. A watermark ahead of the last outgoing
        // message is exactly what a deliberate skip leaves behind (out of hours, a human took
        // over), and re-engage exists to answer a tail nobody answered — so applying it
        // unconditionally would turn the button into a no-op on the conversations it was written
        // for.
        const tail = incomingAfterLastOutgoing(messages);
        const handled = await readHandledWatermark({
          tenantId,
          conversationDbId: resolved.convDbId,
          base,
        });
        return handled === null ? tail : tail.filter((m) => m.id > handled);
      }
    : incomingAfterLastOutgoing;

  // NOTHING TO ANSWER ⇒ NOTHING TO REFUSE, and the gates below are all about a TURN. A conversation
  // whose last message is ours has no tail, so this click was always going to be a no-op: reporting
  // a spent budget for it tells the operator to raise a ceiling that would change nothing, and
  // spends an authorization call on somebody else's endpoint for a turn that will not run.
  //
  // It costs one Chatwoot read, on a path that was going to make one anyway. Deliberately NOT a
  // spend: the gates sit in front of the billed call, and a message fetch is not one.
  const preview = await loadChatwootClient(tenantId, resolved.instanceId, {
    base,
    makeClient: deps.makeClient,
  });
  const previewTail = await selectPending(
    parseChatwootMessages(await preview.getMessages(resolved.conversationId)),
  );
  if (previewTail.length === 0) return { outcome: "empty" };

  // The spend ceiling, asked here for the reason every other turn seam asks it: this is a billed
  // call, and nothing above it is. An operator re-engaging a conversation by hand is spending the
  // same budget a customer's message spends, so the same wall applies — and unlike the customer
  // paths, this one REPORTS rather than going quiet, because somebody is looking at the button.
  const ceiling = await spendCeilingVerdict({
    tenantId,
    source: "inbox",
    base,
  });
  // ...AND THE TAIL IS RE-READ BEFORE THE REFUSAL, because the verdict above is two database reads
  // deep and this conversation is live the whole time. A delivery that answered the tail inside that
  // window leaves nothing for this click to run, so the refusal would tell the operator to raise a
  // ceiling for work that no longer exists — the same "nothing to answer ⇒ nothing to refuse" the
  // pre-fetch above applies, asked again at the moment the answer is used. Only on the refusing
  // path: `allowed` and `warning` both go on to coalesce for real, which re-reads anyway, and a
  // warning is a statement about the MONTH rather than about this turn.
  if (ceiling.state === "over") {
    const freshTail = await selectPending(
      parseChatwootMessages(await preview.getMessages(resolved.conversationId)),
    );
    if (freshTail.length === 0) return { outcome: "empty" };
  }
  announceSpendCeiling(
    {
      tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: resolved.convDbId,
      agentId: resolved.loaded.agentId,
      inboxId: resolved.loaded.inboxDbId,
      threadId: resolved.threadId,
      base,
    },
    ceiling,
    "inbox",
    tenantId,
  );
  if (ceiling.state === "over") return { outcome: "over-ceiling" };

  // The contact-authorization gate (docs/contact-auth.md) applies here for the same reason it
  // applies to a follow-up: this runs the model and sends its answer to the customer, so it is a
  // turn, and the invariant is that no turn happens for a contact the endpoint will not vouch for.
  // The operator pressing the button is not the authorization — the endpoint is, and the tail this
  // would answer may be unanswered precisely BECAUSE it was refused, or the contact may have been
  // revoked since it arrived.
  //
  // A refusal is reported to the operator who pressed the button and does nothing else: the
  // customer copy and the handoff exist to answer a message the customer just sent, and here there
  // is none. It is logged, though — a refused re-engage that left no trace would read in the
  // flowlog as if the click never happened.
  let authContext: AuthContext | null = null;
  if (authCfg.enabled) {
    const auth = await authorizeContact({
      tenantId,
      agentId: resolved.loaded.agentId,
      contactDbId: resolved.loaded.contactDbId,
      conversationId: resolved.conversationId,
      inboxId: resolved.inboxChatwootId,
      channelType: resolved.loaded.channelType,
      // A tail of messages is not one message: there is no single text to forward, and an unlock
      // code is something the CUSTOMER sends, on a message of their own.
      messageText: null,
      // Its own asking, for the reason the nudge has one: it carries no message text and must never
      // join (or be joined by) the flight of an incoming message that does.
      requestKey: "reengage",
      cfg: authCfg,
      base,
      fetchImpl: deps.contactAuthFetch,
    });
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: resolved.convDbId,
        agentId: resolved.loaded.agentId,
        inboxId: resolved.loaded.inboxDbId,
        threadId: resolved.threadId,
        base,
      },
      contactAuthFlowEvent(auth),
    );
    if (auth.outcome !== "allowed") return { outcome: "not-authorized" };
    // The facts the endpoint volunteered about this contact, for the prompt of the turn below: this
    // path re-asks the gate for the same reason it re-reads the mirror, so the answer is current.
    authContext = auth.context ?? null;
    // Allowed, after a round-trip that may have taken ten seconds. The assignee gate above ran
    // before it, so a human arriving during the wait would have the turn's tools run on their
    // conversation — the post gate only withholds the reply. Re-read the mirror and report the same
    // "gate-closed" the early check reports, because from the operator's side that is what happened.
    const stillOurs = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const conv = await db.conversation.findUnique({
        where: { id: resolved.convDbId },
        // assigneeId is part of the question, not decoration: without it shouldBotHandle cannot
        // tell OUR bot from another one, and a conversation handed to a different bot during the
        // authorization call would read as still ours.
        select: { status: true, assigneeType: true, assigneeId: true },
      });
      return shouldBotHandle(
        {
          assigneeType: conv?.assigneeType ?? null,
          assigneeId: conv?.assigneeId ?? null,
          status: conv?.status ?? null,
        },
        { ourAgentBotId: resolved.loaded.agentBotId },
      );
    });
    if (!stillOurs) return { outcome: "gate-closed" };
  }

  const outcome = await coalesceAndRunTurn(
    {
      // An operator pressing "re-engage" in the console: the turn IS the action, there is no queued
      // job behind it and nothing that could call it off while it runs.
      stillWanted: null,
      tenantId,
      instanceId: resolved.instanceId,
      conversationId: resolved.conversationId,
      threadId: resolved.threadId,
      agentBotId: resolved.loaded.agentBotId,
      convDbId: resolved.convDbId,
      loaded: resolved.loaded,
      settings: resolved.settings,
      authContext,
      // The same expression the pre-check above used, re-evaluated against a FRESH fetch: the
      // authorization call between them is a round trip long enough for the tail to change.
      selectPending,
      label: "reengage",
    },
    base,
    deps,
  );

  if (outcome === "posted") {
    await clearConversationError({
      tenantId,
      instanceId: resolved.instanceId,
      chatwootConversationId: resolved.conversationId,
      base,
    });
  }
  return { outcome };
}
