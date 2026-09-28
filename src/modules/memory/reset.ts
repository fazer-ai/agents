import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// Clearing a contact-inbox's memory, in the one order that fails safely. The summary rows and the
// AgentThread marker live in the caller's transaction; the checkpoint lives on the LangGraph pool, a
// different connection, so this cannot be atomic. Rows first, checkpoint last: a pool timeout then
// rolls the rows back with the checkpoint intact and /reset is a clean retry. Checkpoint first would
// leave summaries the operator was told were cleared, and the next compaction would render them.

export interface MemoryRowStore {
  attendanceSummary: {
    deleteMany(args: {
      where: {
        tenantId: bigint;
        chatwootInstanceId: bigint;
        contactInboxId: number;
      };
    }): Promise<unknown>;
  };
  agentThread: {
    deleteMany(args: {
      where: {
        tenantId: bigint;
        chatwootInstanceId: bigint;
        contactInboxId: number;
      };
    }): Promise<unknown>;
  };
}

export interface ClearContactMemoryParams {
  db: MemoryRowStore;
  checkpointer: Pick<BaseCheckpointSaver, "deleteThread">;
  tenantId: bigint;
  instanceId: bigint;
  contactInboxId: number;
  threadId: string;
}

export async function clearContactMemory(
  p: ClearContactMemoryParams,
): Promise<void> {
  const where = {
    tenantId: p.tenantId,
    chatwootInstanceId: p.instanceId,
    contactInboxId: p.contactInboxId,
  };
  await p.db.attendanceSummary.deleteMany({ where });
  await p.db.agentThread.deleteMany({ where });
  await p.checkpointer.deleteThread(p.threadId);
}
