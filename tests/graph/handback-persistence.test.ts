import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { getCheckpointer } from "@/graph/checkpointer";
import { owesHandbackNote } from "@/graph/handback";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { HANDOFF_DONE_PREFIX, HANDOFF_TOOL_NAME } from "@/graph/tools/catalog";

// THE DECISION READS A PERSISTED MESSAGE, not the one it was handed. `owesHandbackNote` matches the
// tool NAME as well as the result's prefix, and the name is a constructor field that must survive
// the checkpointer's serialization to be there when the NEXT turn loads the thread. `MemorySaver`
// keeps the object graph in memory and proves nothing about that: a serde that dropped the field
// would turn the decision quietly false in production while every other test stays green.
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
if (appUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

describe.skipIf(!dbUp)(
  "the handoff result survives the real checkpointer",
  () => {
    test("a handoff written and loaded back still owes a note", async () => {
      const checkpointer = await getCheckpointer();
      const threadId = `hb-persist-${process.pid}-${Date.now()}`;
      await buildThreadStateGraph(checkpointer).updateState(
        { configurable: { thread_id: threadId } },
        {
          messages: [
            new AIMessage({
              content: "",
              tool_calls: [{ name: HANDOFF_TOOL_NAME, args: {}, id: "h1" }],
            }),
            new ToolMessage({
              content: `${HANDOFF_DONE_PREFIX} (status set to open).`,
              tool_call_id: "h1",
              name: HANDOFF_TOOL_NAME,
            }),
          ],
        },
        THREAD_STATE_NODE,
      );
      const cp = await checkpointer.get({
        configurable: { thread_id: threadId },
      });
      const messages = ((cp?.channel_values as { messages?: BaseMessage[] })
        ?.messages ?? []) as BaseMessage[];
      // The name is asserted on its own too: without it the decision below would still be true (the
      // prefix alone matches), so the round trip would look proved while the identity check had
      // quietly stopped working.
      const result = messages.find((m) => m.getType() === "tool");
      expect(result?.name).toBe(HANDOFF_TOOL_NAME);
      expect(owesHandbackNote(messages)).toBe(true);
      await checkpointer.deleteThread(threadId);
    });
  },
);
