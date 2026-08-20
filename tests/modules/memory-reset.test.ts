import { describe, expect, test } from "bun:test";
import { clearContactMemory } from "@/modules/memory/reset";

// The order is the whole content of this unit, so it is what the tests assert. Fakes on both sides:
// the rows live on the caller's transaction and the checkpoint on a different pool, and what is
// under test is which one goes last — not either store.

function harness(opts: { failCheckpoint?: boolean } = {}) {
  const order: string[] = [];
  const db = {
    attendanceSummary: {
      deleteMany: async () => {
        order.push("summaries");
      },
    },
    agentThread: {
      deleteMany: async () => {
        order.push("thread-row");
      },
    },
  };
  const checkpointer = {
    deleteThread: async () => {
      order.push("checkpoint");
      if (opts.failCheckpoint) throw new Error("injected: pool exhausted");
    },
  };
  const run = () =>
    clearContactMemory({
      db,
      checkpointer,
      tenantId: 1n,
      instanceId: 2n,
      contactInboxId: 301,
      threadId: "1:2:ci:301",
    });
  return { order, run };
}

describe("clearContactMemory", () => {
  test("deletes the rows first and the checkpoint last", async () => {
    const h = harness();
    await h.run();
    expect(h.order).toEqual(["summaries", "thread-row", "checkpoint"]);
  });

  // THE REASON FOR THE ORDER. The checkpoint is on a different connection, so a failure there cannot
  // roll back with the rows. Going last, it fails with the rows still only deleted INSIDE the
  // caller's transaction — which then rolls back, leaving nothing deleted and a clean retry. Going
  // first, the same failure left the checkpoint gone and the rows alive, and the next compaction
  // rendered the memory head again from summaries the operator had been told were cleared.
  test("a failing checkpoint delete leaves the row deletions to roll back", async () => {
    const h = harness({ failCheckpoint: true });
    await expect(h.run()).rejects.toThrow("pool exhausted");
    // It threw only after both row deletions had run, so they are inside the caller's transaction
    // and go back with it.
    expect(h.order).toEqual(["summaries", "thread-row", "checkpoint"]);
  });
});
