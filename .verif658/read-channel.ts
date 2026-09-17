// Verificador #658 — leitura APENAS: o canal de um thread pelo checkpointer do repo, mais a linha de
// claim em agent_threads.
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PrismaPg } from "@prisma/adapter-pg";
import type { BaseMessage } from "@langchain/core/messages";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildThreadStateGraph } from "@/graph/thread-state";

const threadId = process.env.V_THREAD as string;
const tenantId = BigInt(process.env.V_TENANT as string);
const instanceId = BigInt(process.env.V_INSTANCE as string);
const contactInboxRaw = process.env.V_CONTACT_INBOX ?? "";

const pool = new Pool({
  connectionString: process.env.LANGGRAPH_DATABASE_URL as string,
  max: 4,
});
const saver = new PostgresSaver(pool, undefined, { schema: "langgraph" });
await saver.setup();
const state = await buildThreadStateGraph(saver).getState({
  configurable: { thread_id: threadId },
});
const messages = ((state.values as { messages?: BaseMessage[] })?.messages ??
  []) as BaseMessage[];
const channel = messages.map((m) => [
  m.getType(),
  typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  JSON.stringify(m.additional_kwargs ?? {}),
]);

let claim: unknown = null;
if (contactInboxRaw !== "") {
  const su = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.MIGRATION_DATABASE_URL as string,
    }),
  });
  const row = await su.agentThread.findFirst({
    where: {
      tenantId,
      chatwootInstanceId: instanceId,
      contactInboxId: Number(contactInboxRaw),
    },
    select: {
      turnHolders: true,
      turnHeldUntil: true,
      turnEpoch: true,
      lastConversationId: true,
      ingestWriteUntil: true,
    },
  });
  claim = row
    ? {
        turnHolders: row.turnHolders,
        turnHeldUntil: row.turnHeldUntil?.toISOString() ?? null,
        turnEpoch: String(row.turnEpoch),
        lastConversationId: row.lastConversationId,
        ingestWriteUntil: row.ingestWriteUntil?.toISOString() ?? null,
      }
    : null;
  await su.$disconnect();
}

console.log(`__V658__${JSON.stringify({ threadId, channel, claim })}`);
await pool.end();
process.exit(0);
