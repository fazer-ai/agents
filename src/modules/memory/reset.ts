import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// Clearing a contact-inbox's memory, in the one order that fails safely.
//
// Three things hold that memory: the summary rows, the AgentThread marker, and the checkpointer
// thread. The first two live on the caller's connection, inside its transaction and under the
// `ingest:<threadId>` advisory lock a compaction also takes; the third lives on the LangGraph pool,
// which is a DIFFERENT connection. Two connections cannot commit atomically, so this does not get to
// be all-or-nothing — what it gets to choose is which partial state a failure leaves behind.
//
// ROWS FIRST, CHECKPOINT LAST. Deleting the checkpoint first meant a slow or exhausted LangGraph pool
// could time out the surrounding transaction AFTER the checkpoint was already gone: the row deletions
// roll back and survive, and the next compaction renders the memory head again from summaries the
// operator had just cleared — with the operator having been told the reset succeeded. Reversed, that
// same timeout rolls the rows back with the checkpoint still intact: nothing was deleted, the step
// reports the failure, and re-running /reset is a clean retry. What remains is the commit itself,
// which is orders of magnitude shorter than a pool wait.
//
// A unit, and not three statements inline, because the ORDER is the whole content of the decision
// and an order nothing asserts is an order that comes back.

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
