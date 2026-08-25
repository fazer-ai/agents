import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { deleteAgent } from "@/modules/agents/service";
import {
  disconnectChatwootDeployment,
  reconnectChatwootInstance,
  removeChatwootInstance,
  softDisconnectChatwootInstance,
} from "@/modules/chatwoot/management";
import {
  invalidateRouteTokenCache,
  readRouteTokenCache,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";
import { seedChatwootInstance } from "../utils/chatwoot";

// WHO CHANGES WHAT A ROUTE TOKEN RESOLVES TO? That is the question this file polices, and the answer
// is a family: connect, reconnect, disconnect, remove the instance, delete the agent. A member that
// forgets to invalidate leaves the receiver authenticating a retired token out of memory, and a
// member that invalidates INSIDE its own transaction leaves a window where an event reads the row it
// is about to change and re-caches the answer that was just replaced. Both failures are silent.
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

const bot = {
  tenantId: 1n,
  instanceId: 2n,
  agentBotId: 9,
  webhookSecret: "enc",
};
const HASH = "warm-hash";
const warm = () => writeRouteTokenCache(HASH, bot);
const warmed = () => readRouteTokenCache(HASH) !== undefined;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("route token cache invalidation family", () => {
  let tenantId = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RTI", slug: `rti-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    invalidateRouteTokenCache();
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function freshInstance(accountId: number) {
    return seedChatwootInstance(suDb, {
      tenantId,
      accountId,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
  }

  test("removing the instance retires the route tokens its bots owned", async () => {
    const inst = await freshInstance(6001);
    warm();
    await removeChatwootInstance(ctx(tenantId), inst.id, appDb);
    expect(warmed()).toBe(false);
  });

  test("deleting the agent retires the route token of the bot it cascades", async () => {
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Persona", systemPrompt: "x" },
    });
    warm();
    await deleteAgent(ctx(tenantId), agent.id, appDb);
    expect(warmed()).toBe(false);
  });

  // Two cascades down (deployment -> instance -> bot). A sweep that asks "who WRITES to
  // chatwootInstance or chatwootAgentBot" misses this entirely, which is how it shipped; the
  // question that finds it is "what deletes CASCADE to ChatwootAgentBot". Own tenant, because
  // this test destroys the deployment the other tests share.
  test("disconnecting the deployment retires every route token under it", async () => {
    const other = await suDb.tenant.create({
      data: { name: "RTI-dep", slug: `rti-dep-${process.pid}` },
    });
    await seedChatwootInstance(suDb, {
      tenantId: other.id,
      accountId: 6004,
      baseUrl: "https://chat.dep.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    warm();
    await disconnectChatwootDeployment(ctx(other.id), appDb);
    expect(warmed()).toBe(false);
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${other.id}`;
  });

  test("soft-disconnecting the instance retires its route tokens", async () => {
    const inst = await freshInstance(6002);
    warm();
    await softDisconnectChatwootInstance(ctx(tenantId), inst.id, appDb);
    expect(warmed()).toBe(false);
  });

  // THE ORDER, not just the fact. `$transaction` is proxied so the cache is read at the moment the
  // callback has returned and the transaction is committing: an invalidation written inside the
  // callback has already run by then, which is the bug (an event arriving in that window still reads
  // the pre-commit row and caches it again, so the reconnect does not land until the entry expires).
  test("reconnect invalidates AFTER its transaction commits, not inside it", async () => {
    const inst = await freshInstance(6003);
    await softDisconnectChatwootInstance(ctx(tenantId), inst.id, appDb);

    const warmDuringCommit: boolean[] = [];
    // `runScopedOn` calls `$extends` first and opens the transaction on the EXTENDED client, so the
    // hook has to follow it there. Wrapping only the base client's `$transaction` records nothing,
    // and a test that records nothing passes for free.
    const wrapTx = (client: unknown): unknown =>
      new Proxy(client as object, {
        get(target, prop, recv) {
          if (prop === "$transaction") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return async (...args: unknown[]) => {
              const out = await orig.apply(target, args);
              warmDuringCommit.push(warmed());
              return out;
            };
          }
          if (prop === "$extends") {
            const orig = Reflect.get(target, prop, recv) as (
              ...a: unknown[]
            ) => unknown;
            return (...args: unknown[]) => wrapTx(orig.apply(target, args));
          }
          return Reflect.get(target, prop, recv);
        },
      });
    const probe = wrapTx(appDb) as PrismaClient;

    warm();
    await reconnectChatwootInstance(ctx(tenantId), inst.id, probe);

    expect(warmDuringCommit.length).toBeGreaterThan(0);
    // Still warm while the write was committing: nothing cleared the cache from inside.
    expect(warmDuringCommit.every(Boolean)).toBe(true);
    // And cleared once the row is durable.
    expect(warmed()).toBe(false);
  });
});
