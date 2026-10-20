// The inbox options a dashboard's pickers offer, when connected Chatwoot accounts have inboxes of the
// same name: each repeated one says its account, and a name only one inbox has stays alone.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getFilterOptions } from "@/modules/analytics/options";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

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

describe.skipIf(!dbUp)("inbox options across accounts (DB)", () => {
  const tenants: bigint[] = [];
  const ids: Record<string, string> = {};

  const ctx = (tenantId: bigint): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  async function tenantWith(
    slug: string,
    accounts: { accountId: number; accountName: string | null }[],
    inboxes: [
      key: string,
      account: number,
      chatwootInboxId: number,
      name: string,
    ][],
  ) {
    const tenant = (
      await suDb.tenant.create({
        data: { name: slug, slug: `${slug}-${process.pid}` },
      })
    ).id;
    tenants.push(tenant);
    const instances = new Map<number, bigint>();
    for (const a of accounts) {
      instances.set(
        a.accountId,
        (
          await seedChatwootInstance(suDb, {
            tenantId: tenant,
            accountId: a.accountId,
            accountName: a.accountName,
            baseUrl: `https://${slug}.test`,
          })
        ).id,
      );
    }
    for (const [key, account, chatwootInboxId, name] of inboxes) {
      ids[key] = String(
        (
          await suDb.inbox.create({
            data: {
              tenantId: tenant,
              chatwootInstanceId: instances.get(account) as bigint,
              chatwootInboxId,
              name,
            },
          })
        ).id,
      );
    }
    return tenant;
  }

  let two = 0n;
  let three = 0n;
  let distinct = 0n;

  beforeAll(async () => {
    two = await tenantWith(
      "optacc-two",
      [
        { accountId: 1, accountName: "Main brand" },
        { accountId: 7, accountName: null },
      ],
      [
        ["mainSac", 1, 2, "SAC WhatsApp"],
        ["otherSac", 7, 2, "SAC WhatsApp"],
        ["mail", 1, 19, "E-mail"],
      ],
    );
    three = await tenantWith(
      "optacc-three",
      [
        { accountId: 1, accountName: "North" },
        { accountId: 2, accountName: "South" },
        { accountId: 3, accountName: "East" },
      ],
      [
        ["n", 1, 2, "SAC WhatsApp"],
        ["s", 2, 2, "SAC WhatsApp"],
        ["e", 3, 2, "SAC WhatsApp"],
      ],
    );
    distinct = await tenantWith(
      "optacc-distinct",
      [
        { accountId: 1, accountName: "North" },
        { accountId: 2, accountName: "South" },
      ],
      [
        ["a", 1, 2, "SAC North"],
        ["b", 2, 2, "SAC South"],
      ],
    );
  });

  afterAll(async () => {
    for (const tenant of tenants) {
      for (const table of [
        "inboxes",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenant}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("two inboxes of one name each carry their account; a unique name carries none", async () => {
    const { inboxes } = await getFilterOptions(ctx(two), appDb);
    const byId = new Map(inboxes.map((i) => [i.id, i]));
    expect(byId.get(ids.mainSac as string)).toEqual({
      id: ids.mainSac as string,
      name: "SAC WhatsApp",
      account: { id: 1, name: "Main brand" },
    });
    expect(byId.get(ids.otherSac as string)).toEqual({
      id: ids.otherSac as string,
      name: "SAC WhatsApp",
      account: { id: 7, name: null },
    });
    expect(byId.get(ids.mail as string)).toEqual({
      id: ids.mail as string,
      name: "E-mail",
    });
  });

  test("a name three accounts share names the account on all three", async () => {
    const { inboxes } = await getFilterOptions(ctx(three), appDb);
    expect(inboxes.map((i) => i.account?.name).sort()).toEqual([
      "East",
      "North",
      "South",
    ]);
  });

  test("a tenant with no repeated name gets no account on any option", async () => {
    const { inboxes } = await getFilterOptions(ctx(distinct), appDb);
    expect(inboxes).toHaveLength(2);
    expect(inboxes.every((i) => i.account === undefined)).toBe(true);
  });
});
