import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { ingestMessageIntoThread } from "@/graph/ingest";
import { seedChatwootInstance } from "../utils/chatwoot";
import { countingBase } from "../utils/counting-base";

// THE POOL INVERSION (issue #225).
//
// The checkpointer is a SEPARATE Postgres pool from Prisma's. The `ingest:<threadId>` critical
// section used to run inside a Prisma transaction, so a connection from pool A sat idle-in-
// transaction for the length of two or three round-trips to pool B (one of them rewriting the whole
// thread channel). Under load pool A drained and every unrelated query in the process, the Chatwoot
// webhook ack included, waited out `maxWait` and failed. That is what took the bot off conversations
// it was about to answer correctly.
//
// The property is structural, so the test is too: count transactions that are OPEN at the moment the
// checkpointer is touched. Timing assertions would be flaky and would pass for the wrong reason on a
// fast machine.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;

// A checkpointer that samples the transaction counter on every call the ingestion makes.
class SamplingSaver extends MemorySaver {
  readonly samples: Array<{ call: string; open: number }> = [];
  constructor(private readonly openTx: () => number) {
    super();
  }
  // biome-ignore lint/suspicious/noExplicitAny: matching the saver's own signatures
  override async getTuple(...args: any[]): Promise<any> {
    this.samples.push({ call: "getTuple", open: this.openTx() });
    // biome-ignore lint/suspicious/noExplicitAny: same
    return (MemorySaver.prototype.getTuple as any).apply(this, args);
  }
  // biome-ignore lint/suspicious/noExplicitAny: same
  override async put(...args: any[]): Promise<any> {
    this.samples.push({ call: "put", open: this.openTx() });
    // biome-ignore lint/suspicious/noExplicitAny: same
    return (MemorySaver.prototype.put as any).apply(this, args);
  }
}

describe.skipIf(!dbUp)("no Prisma transaction spans the checkpointer", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PI", slug: `pi-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["agent_threads", "chatwoot_instances"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("ingestion reads and writes the thread channel with no transaction held", async () => {
    const contactInboxId = 7301;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const counting = countingBase(appDb);
    const saver = new SamplingSaver(counting.open);

    // Two messages on one thread: the first opens the attendance (divider + marker), the second goes
    // through the dedupe read. Between them they exercise every checkpointer call the section makes.
    for (const [messageId, text] of [
      [1, "primeira dúvida"],
      [2, "segunda dúvida"],
    ] as const) {
      const outcome = await ingestMessageIntoThread({
        tenantId,
        instanceId,
        conversationId: 7880,
        contactInboxId,
        graphThreadId,
        base: counting.base,
        checkpointer: saver,
        role: "customer",
        messageId,
        text,
      });
      expect(outcome).toBe("ingested");
    }

    // The section really did touch the checkpointer, or the assertion below would be vacuous.
    expect(saver.samples.length).toBeGreaterThan(0);
    expect(saver.samples.some((s) => s.call === "put")).toBe(true);
    expect(saver.samples.filter((s) => s.open !== 0)).toEqual([]);
    // And it left nothing open behind it.
    expect(counting.open()).toBe(0);
  });
});
