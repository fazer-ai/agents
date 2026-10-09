// What a decided or expired approval request says in its conversation (docs/documents.md, Approval).
// Approved: a proactive turn sends the issued PDF with the agent's message, through every gate a
// proactive turn has (ownership, the 24h window, the spend ceiling). Rejected: nothing to the
// customer, a private note carrying the reviewer's note, and the conversation handed to a person.
// Expired: nothing to the customer, a private note and an alert.

import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type RunAgentNudgeOutcome, runAgentNudge } from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { parseDbId } from "@/lib/db-id";
import { NotFoundError } from "@/lib/errors";
import { runScopedOn } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import {
  parseLiveConversation,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { readDebugModes } from "@/modules/flowlog/debug-mode";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { assignPinnedTarget } from "@/modules/handoff/assign-pinned";
import { readHandoffConfig } from "@/modules/handoff/settings";
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import { formatDocumentNumber } from "./format";
import { getIssuedDocumentPdf, sysCtx } from "./issue";

export interface ApprovalOutcomeDeps {
  makeClient?: RuntimeDeps["makeClient"];
  nudgeDeps?: RuntimeDeps;
  storageDir?: string;
  signal?: AbortSignal;
  // Called once something reached the conversation, so a run that outlives its deadline still has
  // its outcome written and the retry does not repeat the note or the PDF.
  commit?: () => void;
}

type Outcome =
  | "delivered"
  | "noted"
  | "handed"
  | "no-conversation"
  | "no-agent"
  | "retry";

function titleOf(title: string): string {
  return literalForChatwoot(title.replace(/\s+/g, " ").trim());
}

// The conversation a request belongs to, with what a note and a hand-over need: the persona's bot
// token (a note is written as the bot), whether the bot still owns the conversation, and the
// agent's hand-over target.
async function conversationOf(
  tenantId: bigint,
  conversationId: bigint,
  base: PrismaClient,
) {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: {
        chatwootInstanceId: true,
        chatwootConversationId: true,
        threadId: true,
        inboxId: true,
        status: true,
        assigneeType: true,
        assigneeId: true,
        resolvedBy: true,
      },
    });
    if (!conv?.inboxId) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const [agent, bot] = await Promise.all([
      db.agent.findUnique({
        where: { id: inbox.agentId },
        select: { id: true, settings: true },
      }),
      db.chatwootAgentBot.findFirst({
        where: {
          agentId: inbox.agentId,
          chatwootInstanceId: conv.chatwootInstanceId,
        },
        select: { chatwootAgentBotId: true, accessToken: true },
      }),
    ]);
    if (!agent || !bot) return null;
    return {
      conv,
      agentId: agent.id,
      fullDetail: readDebugModes(agent.settings, null).fullDetail,
      handoff: readHandoffConfig(agent.settings),
      botId: bot.chatwootAgentBotId,
      botToken: decryptJson<string>(bot.accessToken),
    };
  });
}

type Target = NonNullable<Awaited<ReturnType<typeof conversationOf>>>;

async function clientFor(
  tenantId: bigint,
  target: Target,
  base: PrismaClient,
  deps: ApprovalOutcomeDeps,
): Promise<ChatwootClient> {
  return loadChatwootClient(tenantId, target.conv.chatwootInstanceId, {
    base,
    makeClient: deps.makeClient,
    botToken: target.botToken,
  });
}

function botOwns(target: Target): boolean {
  return shouldBotHandle(
    {
      assigneeType: target.conv.assigneeType,
      status: target.conv.status,
      assigneeId: target.conv.assigneeId,
      resolvedBy: target.conv.resolvedBy,
    },
    { ourAgentBotId: target.botId },
  );
}

export async function runApprovalOutcome(
  tenantId: bigint,
  requestId: bigint,
  base: PrismaClient = basePrisma,
  deps: ApprovalOutcomeDeps = {},
): Promise<Outcome> {
  const request = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.documentApprovalRequest.findUnique({
      where: { id: requestId },
      select: {
        status: true,
        title: true,
        note: true,
        conversationId: true,
        issuedDocumentId: true,
      },
    }),
  );
  if (!request?.conversationId) return "no-conversation";
  const target = await conversationOf(tenantId, request.conversationId, base);
  if (!target) {
    logger.warn(
      { tenantId: String(tenantId), requestId: String(requestId) },
      "document approval: the request's conversation has no agent bot to answer it",
    );
    return "no-agent";
  }
  const title = titleOf(request.title);
  // An aborted run has been failed and its retry owns the outcome, so it writes nothing more, unless
  // it already wrote something the retry cannot take back: then the outcome is this run's to finish.
  let committed = false;
  const commit = () => {
    committed = true;
    deps.commit?.();
  };
  const note = async (client: ChatwootClient, text: string) => {
    if (deps.signal?.aborted && !committed) return false;
    await client.sendPrivateNote(target.conv.chatwootConversationId, text);
    commit();
    return true;
  };

  if (request.status === "REJECTED") {
    const client = await clientFor(tenantId, target, base, deps);
    const conversationId = target.conv.chatwootConversationId;
    // Asked live, right before the routing writes: the mirror can lag a person who just took or
    // closed the conversation, and a hand-over over them would reopen or reassign it.
    let owned = false;
    if (botOwns(target)) {
      const live = parseLiveConversation(
        await client.getConversation(conversationId).catch(() => null),
      );
      if (!live) return "retry";
      owned = shouldBotHandle(
        {
          assigneeType: live.assigneeType,
          status: live.status,
          assigneeId: live.assigneeId,
          resolvedBy: target.conv.resolvedBy,
        },
        { ourAgentBotId: target.botId },
      );
    }
    if (deps.signal?.aborted) return "retry";
    // NOTE: the hand-over goes before the note, so a failure in it retries with nothing posted, and
    // the note only says what already happened.
    if (owned) {
      await client.toggleStatus(conversationId, "open");
      commit();
      await assignPinnedTarget({
        client,
        conversationId,
        instanceId: target.conv.chatwootInstanceId,
        handoff: target.handoff,
        logLabel: "document approval rejected",
      });
    }
    const reviewerNote = request.note
      ? ` Nota de quem revisou: ${literalForChatwoot(request.note)}`
      : "";
    const noted = await note(
      client,
      `Documento não aprovado pela equipe: ${title}. Nada foi enviado ao cliente.${owned ? " A conversa foi passada para um atendente." : ""}${reviewerNote}`,
    );
    if (!noted) return "retry";
    return owned ? "handed" : "noted";
  }

  if (request.status === "EXPIRED") {
    const client = await clientFor(tenantId, target, base, deps);
    const noted = await note(
      client,
      `O pedido de aprovação do documento ${title} venceu sem resposta da equipe. Nada foi enviado ao cliente.`,
    );
    if (!noted) return "retry";
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: request.conversationId,
        agentId: target.agentId,
        threadId: target.conv.threadId,
        base,
        fullDetail: target.fullDetail,
      },
      {
        stage: "tool",
        level: "warn",
        status: "skipped",
        detail: {
          outcome: "document_approval_expired",
          requestId: String(requestId),
        },
      },
    );
    return "noted";
  }

  if (request.status !== "APPROVED" || request.issuedDocumentId === null) {
    return "no-conversation";
  }
  const issued = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.issuedDocument.findUnique({
      where: { id: request.issuedDocumentId as bigint },
      select: { number: true, numberPrefix: true },
    }),
  );
  const named = issued
    ? `${title} (${formatDocumentNumber(issued.number, issued.numberPrefix)})`
    : title;
  const pdf = await getIssuedDocumentPdf(
    sysCtx(tenantId),
    request.issuedDocumentId,
    base,
    deps.storageDir,
  ).catch((err: unknown) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  const unavailable = `Documento aprovado: ${named}, mas o PDF não está disponível para envio (revogado ou ausente). Nada foi enviado ao cliente.`;
  if (!pdf) {
    const client = await clientFor(tenantId, target, base, deps);
    return (await note(client, unavailable)) ? "noted" : "retry";
  }
  const issuedId = request.issuedDocumentId;
  const outcome: RunAgentNudgeOutcome = await runAgentNudge({
    tenantId,
    threadId: target.conv.threadId,
    signal: deps.signal,
    nudge: {
      source: "document_approval",
      kind: "approved",
      instructions: `A equipe aprovou o documento "${request.title}" que o cliente pediu nesta conversa, e o PDF vai anexado a esta mensagem. Escreva uma frase curta avisando que ele segue anexo. Não repita valores nem o conteúdo do documento.`,
    },
    approvedDocument: {
      bytes: pdf.bytes,
      fileName: pdf.fileName,
      // NOTE: unescaped here: the caption is signed, and the signature escapes it once.
      caption: `Segue o documento ${request.title.replace(/\s+/g, " ").trim()}, aprovado pela equipe.`,
      heldNote: `Documento aprovado: ${named}. A conversa está com um atendente, então nada foi enviado ao cliente.`,
      windowNote: `Documento aprovado: ${named}. A janela de 24h do WhatsApp está fechada, então ele não foi enviado ao cliente e precisa ser enviado por uma pessoa.`,
      revokedNote: unavailable,
      stillValid: async () => {
        const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
          db.issuedDocument.findUnique({
            where: { id: issuedId },
            select: { revoked: true },
          }),
        );
        return row?.revoked === false;
      },
    },
    base,
    deps: { ...deps.nudgeDeps, makeClient: deps.makeClient },
  });
  if (
    outcome === "messaged" ||
    outcome === "noted" ||
    outcome === "noted-window"
  ) {
    commit();
    return outcome === "messaged" ? "delivered" : "noted";
  }
  if (outcome === "live-unavailable") return "retry";
  // Every other end sent nothing (the spend ceiling, an agent switched off, a contact the gate
  // refused): the document is still approved and a person has to send it.
  const client = await clientFor(tenantId, target, base, deps);
  return (await note(
    client,
    `Documento aprovado: ${named}, mas o agente não pôde enviá-lo agora. Ele precisa ser enviado por uma pessoa.`,
  ))
    ? "noted"
    : "retry";
}

async function runOutcomeJob(
  tenantId: bigint,
  payload: unknown,
  base: PrismaClient,
  run?: JobContext,
): Promise<JobResult> {
  const raw = (payload as { requestId?: unknown } | null)?.requestId;
  const requestId = parseDbId(typeof raw === "string" ? raw : null);
  if (requestId === null) return { outcome: "done" };
  const outcome = await runApprovalOutcome(tenantId, requestId, base, {
    signal: run?.signal,
    commit: run?.commit,
  });
  if (outcome === "retry") {
    return { outcome: "fail", error: "conversation ownership unavailable" };
  }
  return { outcome: "done" };
}

let registered = false;
export function registerDocumentApprovalOutcomeHandler(): void {
  if (registered) return;
  registerJobHandler("DOCUMENT_APPROVAL_OUTCOME", (job, base, ctx) =>
    runOutcomeJob(job.tenantId, job.payload, base, ctx),
  );
  registered = true;
}
