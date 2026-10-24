import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getKpis } from "@/modules/analytics/service";
import { listConversations } from "@/modules/conversations/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A conversation only the occurrences sweep knows of (docs/occurrences.md, "Inboxes no agent
// receives") is no agent's: the conversation list and the analytics leave it out (the dashboard
// panels too, in dashboards-sweep-only.test.ts), and the moment a webhook makes it an agent's queues
// its kept day.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const HOUR = 3_600_000;
const NOW = new Date(Date.now() - 2 * HOUR);

describe.skipIf(!dbUp)("conversations only the sweep knows of", () => {
  let tenant = 0n;
  let instance = 0n;
  let inbox = 0n;
  const ctx = (): TenantContext => ({
    tenantId: tenant,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const conversation = async (
    cw: number,
    sweepOnly: boolean,
    createdAt: Date,
  ) =>
    (
      await suDb.conversation.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instance,
          inboxId: inbox,
          chatwootConversationId: cw,
          status: "open",
          threadId: `${tenant}:${instance}:${cw}`,
          lastInboundAt: createdAt,
          sweepOnly,
          createdAt,
        },
      })
    ).id;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "SweepFences", slug: `sweep-fences-${process.pid}` },
      })
    ).id;
    instance = (
      await seedChatwootInstance(suDb, { tenantId: tenant, accountId: 38401 })
    ).id;
    inbox = (
      await suDb.inbox.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instance,
          chatwootInboxId: 4,
          name: "Só gente",
        },
      })
    ).id;
    await conversation(1, false, new Date(NOW.getTime() - HOUR));
    await conversation(2, true, new Date(NOW.getTime() - HOUR));
  });

  afterAll(async () => {
    for (const table of [
      "dashboard_dirty",
      "conversations",
      "inboxes",
      "chatwoot_instances",
      "chatwoot_deployments",
    ])
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenant}`,
      );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the conversation list leaves it out", async () => {
    const page = await listConversations(ctx(), {}, appDb);
    expect(page.items.map((c) => c.chatwootConversationId)).toEqual([1]);
  });

  test("the analytics count only the agents' conversation", async () => {
    const window = {
      since: new Date(NOW.getTime() - 24 * HOUR),
      until: NOW,
    };
    expect((await getKpis(ctx(), window, appDb)).totalConversations).toBe(1);
  });

  test("a webhook making an old swept conversation an agent's queues its kept day", async () => {
    const old = await conversation(
      3,
      true,
      new Date(NOW.getTime() - 72 * HOUR),
    );
    await suDb.$executeRaw`DELETE FROM dashboard_dirty WHERE tenant_id = ${tenant}`;
    await suDb.conversation.update({
      where: { id: old },
      data: { sweepOnly: false },
    });
    const [row] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_dirty
       WHERE tenant_id = ${tenant} AND conversation_id = ${old}`;
    expect(row?.n).toBe(1);
  });
});
