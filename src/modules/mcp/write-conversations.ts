import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { truncForAudit } from "@/modules/audit/projection";
import { reengageConversation } from "@/modules/conversations/reengage";
import {
  getConversationDetail,
  handoffConversation,
  replyToConversation,
  returnConversationToAgent,
  setConversationStatus,
} from "@/modules/conversations/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  err,
  gate,
  ok,
  parseMcpId,
  recordMcpAudit,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP conversation-control write tools. These have EXTERNAL effect: they post real messages
// to / change the state of a live customer conversation in Chatwoot. dry-run by default previews the
// action (conversation_reply shows the exact text that would be sent); applying is NOT reversible —
// the trade-off is the MCP client's per-call approval plus an audit row on every apply.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

export async function conversationReply(
  principal: VerifiedToken,
  args: {
    conversation_id: string;
    content: string;
    private?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  const isPrivate = args.private ?? false;
  const target = `conversation:${id}`;
  try {
    // Tenant-fence + existence check (DB only).
    await getConversationDetail(ctx, id, base);
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "reply",
        target,
        private: isPrivate,
        content: args.content,
        note: isPrivate
          ? "Would post a PRIVATE note (not visible to the customer)."
          : "Would send this message to the CUSTOMER (not reversible).",
      });
    }
    await replyToConversation(ctx, id, args.content, isPrivate, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "conversation.reply",
      target,
      before: null,
      after: truncForAudit({ private: isPrivate, content: args.content }),
    });
    return ok({ dryRun: false, applied: true, target, private: isPrivate });
  } catch (e) {
    return failOf(e);
  }
}

export async function conversationHandoff(
  principal: VerifiedToken,
  args: {
    conversation_id: string;
    assignee_id?: number | null;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  const assigneeId = args.assignee_id ?? null;
  const target = `conversation:${id}`;
  try {
    const current = await getConversationDetail(ctx, id, base);
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "handoff",
        target,
        currentStatus: current.status,
        currentAssigneeId: current.assigneeId,
        newAssigneeId: assigneeId,
        note: "Hands off to a human (sets status open, stops the bot). Calls Chatwoot.",
      });
    }
    await handoffConversation(ctx, id, assigneeId, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "conversation.handoff",
      target,
      before: truncForAudit({
        status: current.status,
        assigneeId: current.assigneeId,
      }),
      after: truncForAudit({ status: "open", assigneeId }),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function conversationReturn(
  principal: VerifiedToken,
  args: { conversation_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  const target = `conversation:${id}`;
  try {
    const current = await getConversationDetail(ctx, id, base);
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "return",
        target,
        currentStatus: current.status,
        note: "Returns the conversation to the bot (unassigns human, status pending). Calls Chatwoot.",
      });
    }
    const outcome = await returnConversationToAgent(ctx, id, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "conversation.return",
      target,
      before: truncForAudit({ status: current.status }),
      after: truncForAudit({ status: "pending", outcome }),
    });
    // Reported, not swallowed: a takeover during the call leaves the conversation with the human who
    // claimed it, and an `applied: true` alone would tell the caller the agent has it back.
    return ok({ dryRun: false, applied: true, target, outcome });
  } catch (e) {
    return failOf(e);
  }
}

export async function conversationStatus(
  principal: VerifiedToken,
  args: {
    conversation_id: string;
    status: "open" | "pending" | "resolved";
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  const target = `conversation:${id}`;
  try {
    const current = await getConversationDetail(ctx, id, base);
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "status",
        target,
        currentStatus: current.status,
        newStatus: args.status,
        note: "Sets the conversation status in Chatwoot.",
      });
    }
    await setConversationStatus(ctx, id, args.status, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "conversation.status",
      target,
      before: truncForAudit({ status: current.status }),
      after: truncForAudit({ status: args.status }),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function conversationReengage(
  principal: VerifiedToken,
  args: { conversation_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.conversation_id, "conversation_id");
  if (typeof id !== "bigint") return id;
  const target = `conversation:${id}`;
  try {
    const current = await getConversationDetail(ctx, id, base);
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "reengage",
        target,
        currentStatus: current.status,
        note: "Runs the agent on the unanswered tail and may SEND a proactive message to the customer (not reversible). Calls the model + Chatwoot.",
      });
    }
    const result = await reengageConversation(ctx, id, {}, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "conversation.reengage",
      target,
      before: null,
      after: truncForAudit({ outcome: result.outcome }),
    });
    return ok({
      dryRun: false,
      applied: true,
      target,
      outcome: result.outcome,
    });
  } catch (e) {
    return failOf(e);
  }
}
