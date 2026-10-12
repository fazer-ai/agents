// THE FILES THAT ARRIVE AFTER THE CASE OPENED. `open_case_in_inbox` carries the origin's
// files once, inside the turn that opened the case, and that walk is fenced by the turn: a customer
// message landing mid-turn withdraws it, and a file sent after it is never walked at all. This job is
// the second road. It is armed by the tool once the case exists, and by every contact message with a
// file on a conversation that names its case; it walks the origin again and carries what the case
// does not have yet, through the same `carryCaseAttachments`, which records each file it posted.

// Its fences are the ones that mean "this conversation is not the agent's to act on": a /reset after
// the arming, the agent switched off or in monitoring, a person holding the origin, the block off. A
// new customer message is NOT one of them: it is what this job exists to carry.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId, getCheckpointer } from "@/graph/checkpointer";
import { resetLandedAfter } from "@/graph/reset-episode";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "@/modules/agents/mode";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { readDebugModes } from "@/modules/flowlog/debug-mode";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { attendanceStartedAt } from "@/modules/memory/attendance-start";
import {
  type ClaimedJob,
  enqueueJob,
  jobRetired,
  jobRetriesAfterFailure,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { carryCaseAttachments } from "./carry-attachments";
import {
  type CrossInboxCaseConfig,
  readCrossInboxCaseConfig,
} from "./settings";

export const OPEN_CASE_TOOL = "open_case_in_inbox";

// How long after the arming the walk runs: a burst of files is usually a few messages a second apart,
// and one walk after the last of them carries them in one note.
export const CASE_CARRY_DELAY_MS = 5_000;

// One row per ORIGIN conversation, the unit /reset retires (../chatwoot/webhook.ts).
export function caseCarryDedupeKey(threadId: string): string {
  return `case-carry:${threadId}`;
}

// Why a carry stands down, or null when it may go on.
export type CaseCarryHold =
  | "not_mirrored"
  | "reset"
  | "agent_off"
  | "taken_over"
  | "carry_off";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface CarryState {
  conversationRowId: bigint;
  inboxId: bigint;
  threadId: string | null;
  contactInboxId: number | null;
  chatwootContactId: number | null;
  agentId: bigint | null;
  // The agent's debug mode, for the flow line.
  fullDetail: boolean;
  config: CrossInboxCaseConfig | null;
  hold: CaseCarryHold | null;
}

// The origin as the mirror has it now, and the agent bound to its inbox now, with the verdict.
async function readCarryState(p: {
  tenantId: bigint;
  instanceId: bigint;
  originConversationId: number;
  armedAtMessageId: number | null;
  base: PrismaClient;
}): Promise<CarryState | null> {
  return runScopedOn(p.base, sysCtx(p.tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.originConversationId,
        },
      },
      select: {
        id: true,
        inboxId: true,
        threadId: true,
        contactInboxId: true,
        assigneeType: true,
        resetAtMessageId: true,
        testActivatedAt: true,
        contact: { select: { chatwootContactId: true } },
      },
    });
    if (!conv?.inboxId) return null;
    const state: CarryState = {
      conversationRowId: conv.id,
      inboxId: conv.inboxId,
      threadId: conv.threadId,
      contactInboxId: conv.contactInboxId,
      chatwootContactId: conv.contact?.chatwootContactId ?? null,
      agentId: null,
      fullDetail: false,
      config: null,
      hold: null,
    };
    if (resetLandedAfter(p.armedAtMessageId, conv.resetAtMessageId)) {
      return { ...state, hold: "reset" };
    }
    if (conv.assigneeType === "User") return { ...state, hold: "taken_over" };
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
    });
    const agent = inbox?.agentId
      ? await db.agent.findUnique({
          where: { id: inbox.agentId },
          select: { enabled: true, mode: true, settings: true },
        })
      : null;
    if (
      !inbox?.agentId ||
      !agent?.enabled ||
      isMonitoring(agent.mode) ||
      (agent.mode === "test" && conv.testActivatedAt === null)
    ) {
      return { ...state, hold: "agent_off" };
    }
    const config = readCrossInboxCaseConfig(agent.settings);
    const off =
      config.targetInboxId === null ||
      config.carryAttachments.mode === "off" ||
      (config.targetInstanceId !== null &&
        config.targetInstanceId !== Number(p.instanceId));
    return {
      ...state,
      agentId: inbox.agentId,
      fullDetail: readDebugModes(agent.settings, null).fullDetail,
      config,
      hold: off ? "carry_off" : null,
    };
  });
}

export interface CaseCarryArm {
  tenantId: bigint;
  instanceId: bigint;
  originConversationId: number;
  caseId: number;
  // The message whose arrival armed this carry (the contact's file, or the turn that opened the case).
  // A /reset typed after it withdraws the carry. Null ⇒ no message to order by; the reset's own
  // retirement of the row still applies.
  armedAtMessageId: number | null;
  base: PrismaClient;
}

// Arms the carry, unless it is already held: nothing is armed that its own run would stand down from,
// so a switched-off agent or a person on the origin leaves no row behind. Answers what it did.
export async function armCaseCarry(
  p: CaseCarryArm,
): Promise<"armed" | CaseCarryHold> {
  const state = await readCarryState(p);
  if (!state) return "not_mirrored";
  if (state.hold) return state.hold;
  await enqueueJob({
    tenantId: p.tenantId,
    kind: "CASE_CARRY",
    dedupeKey: caseCarryDedupeKey(
      chatwootThreadId(p.tenantId, p.instanceId, p.originConversationId),
    ),
    runAt: new Date(Date.now() + CASE_CARRY_DELAY_MS),
    payload: {
      instanceId: String(p.instanceId),
      originConversationId: p.originConversationId,
      caseId: p.caseId,
      armedAtMessageId: p.armedAtMessageId,
    },
    // A new file is new work: a failure budget spent on an older one does not carry over.
    rearm: "new-work",
    base: p.base,
  });
  return "armed";
}

function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function field(o: unknown, key: string): unknown {
  return o && typeof o === "object"
    ? (o as Record<string, unknown>)[key]
    : undefined;
}

export type CaseCarryDeps = Pick<LoadChatwootClientDeps, "makeClient">;

export async function caseCarryHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps: CaseCarryDeps = {},
): Promise<JobResult> {
  const tenantId = job.tenantId;
  const originConversationId = positiveInt(job.payload.originConversationId);
  const caseId = positiveInt(job.payload.caseId);
  const armedAtMessageId = positiveInt(job.payload.armedAtMessageId);
  const instanceId = parseDbId(
    typeof job.payload.instanceId === "string" ? job.payload.instanceId : null,
  );
  if (instanceId === null) return { outcome: "done" };
  if (originConversationId === null || caseId === null) {
    return { outcome: "done" };
  }
  const read = () =>
    readCarryState({
      tenantId,
      instanceId,
      originConversationId,
      armedAtMessageId,
      base,
    });
  const state = await read();
  if (!state) return { outcome: "done" };

  const line = (
    level: "info" | "warn",
    detail: Record<string, unknown>,
    error?: string,
  ) =>
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: state.conversationRowId,
        agentId: state.agentId,
        inboxId: state.inboxId,
        threadId: state.threadId,
        fullDetail: state.fullDetail,
        base,
      },
      {
        stage: "tool",
        level,
        status: level === "warn" ? "error" : "ok",
        detail: { ...detail, tool: OPEN_CASE_TOOL, phase: "case_carry" },
        ...(error ? { errorMessage: error } : {}),
      },
    );

  if (state.hold || !state.config) {
    line("info", { caseId, stoodDown: state.hold ?? "carry_off" });
    return { outcome: "done" };
  }
  if (await jobRetired(job, base)) return { outcome: "done" };
  const config = state.config;

  const client: ChatwootClient = await loadChatwootClient(
    tenantId,
    instanceId,
    {
      base,
      makeClient: deps.makeClient,
    },
  );
  // The case must still be the open case of the destination inbox: a closed or moved one is not
  // reopened, and no case is ever created here.
  let caseConv: unknown;
  let originConv: unknown;
  try {
    caseConv = await client.getConversation(caseId);
    originConv = await client.getConversation(originConversationId);
  } catch {
    // NOTE: the client's error can carry a URL or a body; the row keeps a fixed sentence.
    return {
      outcome: "fail",
      error: "case carry: could not read the case or its origin",
    };
  }
  const status = field(caseConv, "status");
  if (
    Number(field(caseConv, "inbox_id")) !== config.targetInboxId ||
    (status !== "open" && status !== "pending")
  ) {
    line("info", { caseId, stoodDown: "case_closed" });
    return { outcome: "done" };
  }
  // An origin that names ANOTHER case moved on to it, and this row is stale.
  const named = positiveInt(
    field(field(originConv, "custom_attributes"), config.caseAttributeKey),
  );
  if (named !== null && named !== caseId) return { outcome: "done" };

  const stillWanted = async () =>
    !(await jobRetired(job, base)) && (await read())?.hold === null;
  // The origin's case number, when the turn that opened the case was withdrawn before writing it:
  // without it, the contact's next file would not find its way here.
  if (named === null && (await stillWanted())) {
    try {
      await client.setConversationCustomAttributes(
        originConversationId,
        { [config.caseAttributeKey]: caseId },
        { stillWanted },
      );
    } catch (err) {
      logger.warn(
        "cross-inbox-case: could not write the case number back on the origin (conv=%d case=%d): %s",
        originConversationId,
        caseId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // The attendance boundary, never later than the case itself: a close after the case opened can move
  // it past files the case is still owed.
  const caseCreated = Number(field(caseConv, "created_at"));
  const attendance =
    config.carryAttachments.mode === "attendance" &&
    state.contactInboxId !== null
      ? async (): Promise<Date | null> => {
          const started = await attendanceStartedAt(
            { checkpointer: await getCheckpointer(), base },
            {
              tenantId,
              instanceId,
              contactInboxId: state.contactInboxId as number,
            },
          );
          if (started === null || !Number.isFinite(caseCreated)) return started;
          return new Date(Math.min(started.getTime(), caseCreated * 1000));
        }
      : undefined;

  const lastAttempt = !jobRetriesAfterFailure({ attempts: job.attempts + 1 });
  const outcome = await carryCaseAttachments(client, {
    config: config.carryAttachments,
    originConversationId,
    originContactId: state.chatwootContactId,
    caseId,
    attendanceStartedAt: attendance,
    stillWanted,
    failureNote: lastAttempt,
  });
  if (!outcome) return { outcome: "done" };
  if (outcome.calledOff) {
    line("info", { caseId, stoodDown: "withdrawn" });
    return { outcome: "done" };
  }
  if (outcome.unread || outcome.failed > 0) {
    const ids = outcome.failedIds ?? [];
    line(
      "warn",
      {
        caseId,
        carried: outcome.carried,
        skipped: outcome.skipped,
        failed: outcome.failed,
        failedAttachments: ids,
        attempt: job.attempts + 1,
        retry: !lastAttempt,
        ...(outcome.unread ? { unread: outcome.unread } : {}),
      },
      outcome.unread
        ? `customer files not carried to case ${caseId}: the ${outcome.unread === "attendance" ? "attendance boundary" : "case"} could not be read`
        : `customer files not carried to case ${caseId}${ids.length > 0 ? ` (attachments ${ids.join(", ")})` : ""}${lastAttempt ? "" : "; trying again"}`,
    );
    return lastAttempt
      ? { outcome: "done" }
      : { outcome: "fail", error: "case carry: files not carried" };
  }
  if (outcome.carried + outcome.skipped > 0 || outcome.truncated) {
    line("info", {
      caseId,
      carried: outcome.carried,
      skipped: outcome.skipped,
      ...(outcome.truncated ? { truncated: true } : {}),
    });
  }
  return { outcome: "done" };
}

let registered = false;
export function registerCaseCarryHandler(): void {
  if (registered) return;
  registerJobHandler("CASE_CARRY", (job, base) => caseCarryHandler(job, base));
  registered = true;
}
