import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { outcomeSql } from "@/modules/analytics/filter";
import {
  classifyOutcome,
  RESOLUTION_ORIGINS,
} from "@/modules/conversations/resolution-origin";
import { seedChatwootInstance } from "../utils/chatwoot";

// The dashboard groups conversations by outcome in SQL, and the rule lives in TypeScript
// (`classifyOutcome`). Two spellings of one rule drift, so this fence runs every combination of the
// three inputs through both and requires the same answer.

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
let tenantId = 0n;

const STATUSES = ["open", "pending", "snoozed", "resolved"];
const ASSIGNEES: (string | null)[] = [null, "User", "AgentBot"];
const ORIGINS: (string | null)[] = [null, ...RESOLUTION_ORIGINS];

describe.skipIf(!dbUp)("the outcome in SQL is classifyOutcome", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "OUTCOME-SQL", slug: `outcome-sql-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
  });

  test("for every status, assignee type and origin", async () => {
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 13,
      baseUrl: "https://outcome.chat.example.com",
      adminToken: "enc",
    });
    let n = 0;
    const expected = new Map<string, string>();
    for (const status of STATUSES)
      for (const assigneeType of ASSIGNEES)
        for (const resolvedBy of ORIGINS) {
          n += 1;
          const c = await suDb.conversation.create({
            data: {
              tenantId,
              chatwootInstanceId: inst.id,
              chatwootConversationId: n,
              threadId: `${tenantId}:${inst.id}:${n}`,
              status,
              assigneeType,
              resolvedBy,
            },
          });
          expected.set(
            String(c.id),
            classifyOutcome({ status, assigneeType, resolvedBy }),
          );
        }
    const rows = await suDb.$queryRaw<{ id: bigint; outcome: string }[]>(
      Prisma.sql`SELECT c.id, ${outcomeSql("c")} AS outcome
                   FROM conversations c WHERE c.tenant_id = ${tenantId}`,
    );
    expect(rows).toHaveLength(expected.size);
    for (const r of rows)
      expect(r.outcome).toBe(expected.get(String(r.id)) ?? "missing");
  });
});
