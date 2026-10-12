import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import config from "@/config";
import { chatwootThreadId } from "@/graph/checkpointer";
import type { createChatModel } from "@/graph/models";
import { buildCallbacks, loadAgentConfig } from "@/graph/prepare";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { fitTranscript, summarizeTranscript } from "@/modules/memory/summarize";
import { buildSummaryModel } from "@/modules/memory/summary-model";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { spendCeilingVerdict } from "@/modules/spend-ceiling/service";
import { SUMMARY_MIN_INTERVAL_MS } from "./context";
import { fingerprintMoved, readOtherConversation } from "./read";
import { selectedInboxIds } from "./settings";

// The OTHER_INBOX_SUMMARY job: the summary of one conversation of the contact in another inbox, read
// off Chatwoot and stored for the turns of the same contact elsewhere. Armed by a turn that found the
// conversation too long to hand over whole (./context.ts). Runs outside any turn, so no turn waits
// on it, and it asks the spend ceiling itself right before its one model call.

// What the turn reads of one conversation, so the same size budget as an attendance's memory.

export const OTHER_INBOX_SUMMARY_MAX = 1200;

const SYSTEM_PROMPT = `Você resume uma conversa que um cliente teve com a empresa por um canal, para o atendente que está falando agora com esse mesmo cliente por outro canal.

Escreva um resumo curto da conversa entre as tags de transcrição: o que o cliente pediu ou relatou, o que foi respondido ou combinado, e o que ficou pendente.

Regras:
- Escreva no mesmo idioma da conversa.
- Só registre o que está na transcrição. Não deduza, não complete e não invente nada.
- Se algo ficou ambíguo, diga que ficou ambíguo em vez de escolher uma versão.
- Não escreva saudações, não se dirija ao cliente e não faça perguntas.
- Responda apenas com o resumo, sem preâmbulo e sem formatação de título.`;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface OtherInboxSummaryPayload {
  instanceId: bigint;
  conversationId: number;
  chatwootInboxId: number;
  agentId: bigint;
}

export function parseOtherInboxSummaryPayload(
  payload: Record<string, unknown>,
): OtherInboxSummaryPayload | null {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const instanceId = parseDbId(str(payload.instanceId));
  const agentId = parseDbId(str(payload.agentId));
  const conversationId = Number(payload.conversationId);
  const chatwootInboxId = Number(payload.chatwootInboxId);
  if (
    instanceId === null ||
    agentId === null ||
    !Number.isInteger(conversationId) ||
    conversationId <= 0 ||
    !Number.isInteger(chatwootInboxId) ||
    chatwootInboxId <= 0
  ) {
    return null;
  }
  return { instanceId, conversationId, chatwootInboxId, agentId };
}

export interface OtherInboxSummaryDeps {
  now?: () => number;
  loadClient?: (
    tenantId: bigint,
    instanceId: bigint,
  ) => Promise<ChatwootClient>;
  makeModel?: typeof createChatModel;
  spendCeiling?: typeof spendCeilingVerdict;
  // The scheduler's: aborted when the run's deadline fires, after which its outcome is discarded.
  signal?: AbortSignal;
}

export async function runOtherInboxSummary(
  job: ClaimedJob,
  base: PrismaClient,
  deps: OtherInboxSummaryDeps = {},
): Promise<JobResult> {
  const now = deps.now ?? Date.now;
  const tenantId = job.tenantId;
  const p = parseOtherInboxSummaryPayload(job.payload);
  if (!p) return { outcome: "fail", error: "invalid payload" };
  const key = {
    tenantId_chatwootInstanceId_chatwootConversationId: {
      tenantId,
      chatwootInstanceId: p.instanceId,
      chatwootConversationId: p.conversationId,
    },
  };
  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const cfg = await loadAgentConfig(
      db,
      {
        tenantId,
        instanceId: p.instanceId,
        conversationId: p.conversationId,
        agentId: p.agentId,
        threadId: chatwootThreadId(tenantId, p.instanceId, p.conversationId),
      },
      // NOTE: a summary is not a reply: it must not resolve an experiment variant (that inserts a
      // phantom assignment), and an agent switched to monitoring keeps the setting it was armed under.
      { skipExperiment: true, ignoreMode: true },
    );
    const row = await db.otherInboxSummary.findUnique({
      where: key,
      select: {
        coveredMessageId: true,
        coveredFingerprint: true,
        generatedAt: true,
      },
    });
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootInboxId: p.chatwootInboxId,
        },
      },
      select: { id: true, provider: true },
    });
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.conversationId,
        },
      },
      select: { resetAtMessageId: true },
    });
    return {
      cfg,
      row,
      provider: inbox?.provider ?? null,
      inboxDbId: inbox?.id ?? null,
      resetAtMessageId: conv?.resetAtMessageId ?? null,
    };
  });
  // NOTE: the agent is gone, switched off, or no longer reads this inbox: nothing to summarize for. The
  // selection is asked again here because the operator may have removed the inbox after the arm.
  if (
    !loaded.cfg?.otherInboxesConfig.enabled ||
    !selectedInboxIds(loaded.cfg.otherInboxesConfig, Number(p.instanceId)).has(
      p.chatwootInboxId,
    )
  ) {
    return { outcome: "done" };
  }
  const cfg = loaded.cfg;
  if (loaded.row) {
    const earliest = loaded.row.generatedAt.getTime() + SUMMARY_MIN_INTERVAL_MS;
    if (now() < earliest) {
      return { outcome: "reschedule", runAt: new Date(earliest) };
    }
  }

  const client = await (deps.loadClient ?? loadChatwootClient)(
    tenantId,
    p.instanceId,
  );
  // The inbox the conversation is in NOW, asked before any message is read: the payload's is the one
  // it was armed under, and the selection was checked against that one above.
  const live = (await client.getConversation(p.conversationId)) as {
    inbox_id?: unknown;
  } | null;
  // Moved anywhere, even to another picked inbox, it is not read here: the provider that decides how
  // its outgoing rows are attributed was loaded for the armed inbox, and the next turn arms it again
  // under the inbox it is in now.
  if (Number(live?.inbox_id) !== p.chatwootInboxId) {
    return { outcome: "done" };
  }
  const read = await readOtherConversation({
    client,
    tenantId,
    instanceId: p.instanceId,
    conversationId: p.conversationId,
    provider: loaded.provider,
    stopAfterChars: null,
    timezone: cfg.timezone,
    resetAtMessageId: loaded.resetAtMessageId,
    base,
  });
  // Nothing public the stored summary does not already cover: no call, nothing written.
  if (
    read.newestPublicId === null ||
    (loaded.row &&
      loaded.row.coveredMessageId >= read.newestPublicId &&
      !fingerprintMoved(loaded.row.coveredFingerprint, read.recentFingerprint))
  ) {
    return { outcome: "done" };
  }

  // Built before the ceiling is asked: a model that cannot run fails the job as configuration, and the
  // ceiling is only reported where it is what stopped the call.
  const built = buildSummaryModel(cfg, "other inbox summary", deps.makeModel);
  if (!built.ok) return { outcome: "fail", error: built.error };

  // A `/reset` that landed while the conversation was being read withdrew what was read and retired this
  // job: the boundary is asked again before the ceiling and the call, so no spend goes to a summary the
  // locked write below would drop.
  const boundary = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.conversationId,
        },
      },
      select: { resetAtMessageId: true },
    }),
  );
  if ((boundary?.resetAtMessageId ?? null) !== loaded.resetAtMessageId) {
    return { outcome: "done" };
  }

  // A run past its deadline spends nothing: the scheduler already failed it and will retry.
  if (deps.signal?.aborted) return { outcome: "fail", error: "deadline" };

  // GATED IMMEDIATELY BEFORE THE BILLED CALL (spend-ceiling/coverage.ts names this node).
  const ceiling = await (deps.spendCeiling ?? spendCeilingVerdict)({
    tenantId,
    source: "inbox",
    base,
  });
  if (ceiling.state === "over") {
    logger.info(
      "other-inboxes: summary of conversation %d skipped, tenant past its spend ceiling",
      p.conversationId,
    );
    return { outcome: "done" };
  }

  const result = await summarizeTranscript(
    built.model,
    SYSTEM_PROMPT,
    // The agent's history budget bounds what this model is handed, as it does for compaction.
    fitTranscript(read.renderWithin, cfg.maxHistoryTokens),
    OTHER_INBOX_SUMMARY_MAX,
    // The inbox comes from the payload's inbox row, not the conversation mirror: a conversation only
    // people handle has no mirror, and its summary's cost still belongs to that inbox on the dashboard.
    buildCallbacks(
      { ...cfg, inboxDbId: loaded.inboxDbId ?? cfg.inboxDbId },
      {
        tenantId,
        threadId: chatwootThreadId(tenantId, p.instanceId, p.conversationId),
        node: "other_inbox_summary",
        billedModel: built.mc,
        source: "inbox",
        base,
      },
    ),
    // The agent's own model-call budget, not compaction's 60 s: a provider slow enough to answer a
    // turn answers this too, and no reply waits on it.
    config.agent.modelCallTimeoutMs,
    deps.signal,
  );
  // Nor writes: the retry reads the conversation again and produces the row itself. Asked first,
  // since the abort also ends the call with an error of its own.
  if (deps.signal?.aborted) return { outcome: "fail", error: "deadline" };
  if (result.error) return { outcome: "fail", error: result.error };

  const generatedAt = new Date(now());
  const coveredMessageId = read.newestPublicId;
  const coveredFingerprint = read.recentFingerprint;
  // The `/reset` boundary asked again under the conversation's row lock: a reset that landed during
  // the model call withdrew what this summary read, and its cleanup may already have run.
  const written = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const live = await db.$queryRaw<{ reset_at_message_id: number | null }[]>`
      SELECT reset_at_message_id FROM conversations
      WHERE tenant_id = ${tenantId} AND chatwoot_instance_id = ${p.instanceId}
        AND chatwoot_conversation_id = ${p.conversationId}
      FOR UPDATE`;
    if ((live[0]?.reset_at_message_id ?? null) !== loaded.resetAtMessageId) {
      return false;
    }
    await db.otherInboxSummary.upsert({
      where: key,
      create: {
        tenantId,
        chatwootInstanceId: p.instanceId,
        chatwootConversationId: p.conversationId,
        summary: result.summary,
        coveredMessageId,
        coveredFingerprint,
        generatedAt,
      },
      update: {
        summary: result.summary,
        coveredMessageId,
        coveredFingerprint,
        generatedAt,
      },
    });
    return true;
  });
  if (!written) {
    logger.info(
      "other-inboxes: summary of conversation %d dropped, the conversation was reset during it",
      p.conversationId,
    );
  }
  return { outcome: "done" };
}

let registered = false;

export function registerOtherInboxSummaryHandler(): void {
  if (registered) return;
  registerJobHandler("OTHER_INBOX_SUMMARY", (job, base, ctx) =>
    runOtherInboxSummary(job, base, { signal: ctx?.signal }),
  );
  registered = true;
}
