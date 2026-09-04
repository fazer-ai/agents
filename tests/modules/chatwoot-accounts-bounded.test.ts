import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { setConnectedAccounts } from "@/modules/chatwoot/management";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { deploymentSetAccounts } from "@/modules/mcp/write-channels";
import { seedChatwootInstance } from "../utils/chatwoot";

// `deployment_set_accounts` publishes `account_ids: z.array(z.number().int())` with no maximum, and
// `setConnectedAccounts` iterates it: every id not already active gets a row plus a best-effort
// `syncInboxes`, two HTTP calls to the operator's Chatwoot, sequentially. Measured before the bound
// existed (issue #503): one call carrying 40,000 ids created 16,774 `chatwoot_instances` rows in
// about two minutes and was still climbing when it was killed.
//
// The bound is the deployment's own account list, and that it CAN be the bound was measured against
// a real Chatwoot 4.17.0 rather than reasoned: a user access token whose profile reported account 1
// of the server's two got 200 on `/api/v1/accounts/1/inboxes` and 401 "You are not authorized to
// access this account" on `/accounts/2/inboxes`. An id outside the profile is an account the token
// cannot operate at all.
//
// The stubs below therefore describe servers that can exist. A profile reporting [5, 8, 9] means a
// token that reaches exactly those three, and `profileDown` is the probe FAILING — the only window
// the numeric cap covers, kept fail-open so an outage on the operator's Chatwoot does not refuse a
// write whose ids the operator picked deliberately.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

// NOTE: loopback on the discard port, for the reason spelled out in chatwoot-account-uniqueness:
// the best-effort provisioning call inside setConnectedAccounts reaches out with this base URL, and
// only loopback is refused by the SSRF guard immediately and offline.
const SERVER = "https://127.0.0.1:9";
const REPORTED = [
  { id: 5, name: "Acc 5" },
  { id: 8, name: "Acc 8" },
  { id: 9, name: "Acc 9" },
];
const profileOk = { fetchProfile: async () => ({ accounts: REPORTED }) };
const profileDown = {
  fetchProfile: async () => {
    throw new Error("chatwoot unreachable");
  },
};

describe.skipIf(!dbUp)("the accounts a deployment can be asked for", () => {
  let tenantId = 0n;
  const ctx = (): TenantContext => ({
    tenantId,
    userId: 1n,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Bounded", slug: `bounded-${process.pid}` },
    });
    tenantId = t.id;
    await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 5,
      baseUrl: SERVER,
      adminToken: encryptJson("tok"),
    });
  });

  afterAll(async () => {
    await suDb.chatwootInstance.deleteMany({ where: { tenantId } });
    await suDb.chatwootDeployment.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const activeIds = async () =>
    (
      await suDb.chatwootInstance.findMany({
        where: { tenantId, disconnectedAt: null },
        select: { accountId: true },
      })
    )
      .map((r) => r.accountId)
      .sort((a, b) => a - b);

  test("an id the deployment does not report is refused", async () => {
    await expect(
      setConnectedAccounts(ctx(), [5, 4242], profileOk, appDb),
    ).rejects.toThrow(/does not report account/);
    expect(await activeIds()).toEqual([5]);
  });

  // NOTE: the control. Every id the deployment DOES report still goes through, so the test above is
  // measuring membership and not a tool that stopped connecting anything.
  test("the ids it does report are still connected", async () => {
    await setConnectedAccounts(ctx(), [5, 8], profileOk, appDb);
    expect(await activeIds()).toEqual([5, 8]);
    await setConnectedAccounts(ctx(), [5], profileOk, appDb);
    expect(await activeIds()).toEqual([5]);
  });

  test("a large array of ids it does not report is refused before any write", async () => {
    const many = Array.from({ length: 501 }, (_, i) => 20_000 + i);
    await expect(
      setConnectedAccounts(ctx(), many, profileOk, appDb),
    ).rejects.toThrow(/does not report account/);
    expect(await activeIds()).toEqual([5]);
  });

  // NOTE: with the probe down there is no list to check against, so the cap is what is left. Both
  // sides of it, because a cap asserted in one direction is satisfied by a tool that refuses
  // everything.
  test("with the probe down, a plausible selection still goes through", async () => {
    await setConnectedAccounts(ctx(), [5, 9], profileDown, appDb);
    expect(await activeIds()).toEqual([5, 9]);
    await setConnectedAccounts(ctx(), [5], profileDown, appDb);
    expect(await activeIds()).toEqual([5]);
  });

  test("with the probe down, an array past the fallback cap is refused", async () => {
    const many = Array.from({ length: 501 }, (_, i) => 20_000 + i);
    await expect(
      setConnectedAccounts(ctx(), many, profileDown, appDb),
    ).rejects.toThrow(/too many account_ids/);
    expect(await activeIds()).toEqual([5]);
  });

  test("the cap is measured on the DEDUPLICATED array", async () => {
    // NOTE: 600 entries naming 3 accounts is not 600 accounts, and the work either bound exists to
    // limit is per distinct account.
    const repeated = Array.from(
      { length: 600 },
      (_, i) => [5, 8, 9][i % 3] as number,
    );
    await setConnectedAccounts(ctx(), repeated, profileDown, appDb);
    expect(await activeIds()).toEqual([5, 8, 9]);
    await setConnectedAccounts(ctx(), [5], profileDown, appDb);
    expect(await activeIds()).toEqual([5]);
  });

  // NOTE: the rule is the core's, so the preview inherits it rather than restating it (#490).
  test("the preview refuses what the apply refuses", async () => {
    const p: VerifiedToken = {
      userId: 1n,
      tenantId,
      role: "SUPER_ADMIN",
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
      clientId: "c",
      jti: "j",
    };
    const previewed = await deploymentSetAccounts(
      p,
      { account_ids: [5, 4242], dry_run: true },
      { base: appDb, fetchProfile: profileOk.fetchProfile },
    );
    expect(previewed.ok).toBe(false);
    if (!previewed.ok) {
      expect(previewed.error).toContain("does not report account");
    }
    expect(await activeIds()).toEqual([5]);
  });
});
