import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  reconnectChatwootInstance,
  removeChatwootInstance,
} from "@/modules/chatwoot/management";
import {
  readRouteTokenCache,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// REMOVING AN ACCOUNT HAS TO WORK AT THE SIZE A REAL ACCOUNT REACHES. The removal is the only way
// to free an account for another tenant, and each statement of it is held to the request's budget.
// Each test seeds an account in bulk and removes it through the real function on the app role, so a
// removal that only works on the handful of rows the other suites seed fails here.
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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "SUPER_ADMIN" };
}

// The account in bulk, straight in SQL: contacts, conversations spread over them and over the
// account's inboxes, and webhook deliveries. Ids come from the sequences, so seeding never collides
// with what other suites wrote in the same database.
async function seedVolume(
  tenantId: bigint,
  instanceId: bigint,
  n: { contacts: number; conversations: number; deliveries: number },
) {
  const tag = `${instanceId}`;
  await suDb.$executeRaw`
    INSERT INTO inboxes (tenant_id, chatwoot_instance_id, chatwoot_inbox_id, name, updated_at)
    SELECT ${tenantId}, ${instanceId}, g, 'inbox ' || g, now() FROM generate_series(1, 3) g`;
  await suDb.$executeRaw`
    INSERT INTO contacts (tenant_id, chatwoot_instance_id, chatwoot_contact_id, updated_at)
    SELECT ${tenantId}, ${instanceId}, g, now() FROM generate_series(1, ${n.contacts}::int) g`;
  await suDb.$executeRaw`
    WITH c AS (SELECT array_agg(id) a FROM contacts WHERE chatwoot_instance_id = ${instanceId}),
         i AS (SELECT array_agg(id) a FROM inboxes WHERE chatwoot_instance_id = ${instanceId})
    INSERT INTO conversations
      (tenant_id, chatwoot_instance_id, inbox_id, contact_id, chatwoot_conversation_id, status, thread_id, updated_at)
    SELECT ${tenantId}, ${instanceId}, i.a[1 + g % 3], c.a[1 + g % array_length(c.a, 1)], g, 'open',
           ${tag} || '-' || g, now()
      FROM generate_series(1, ${n.conversations}::int) g, c, i`;
  // Already processed: a pending row is work, and a delivery worker still running from another file
  // in the same process claims it and locks its conversation while the removal waits on it.
  await suDb.$executeRaw`
    INSERT INTO chatwoot_webhook_deliveries
      (tenant_id, chatwoot_instance_id, delivery_id, event, status, processed_at)
    SELECT ${tenantId}, ${instanceId}, ${tag} || '-' || g, 'message_created', 'PROCESSED', now()
      FROM generate_series(1, ${n.deliveries}::int) g`;
  // Analyzed, as a table that has held an account for a while is: straight after a bulk load the
  // statistics still read the tenant as empty, and every plan that filters by it, row-level security
  // included, then walks the whole account for each batch.
  await suDb.$executeRawUnsafe(
    "ANALYZE inboxes, contacts, conversations, chatwoot_webhook_deliveries",
  );
}

async function rowsOf(instanceId: bigint) {
  const [row] = await suDb.$queryRaw<
    {
      instances: bigint;
      contacts: bigint;
      conversations: bigint;
      deliveries: bigint;
      inboxes: bigint;
      orphaned: bigint;
    }[]
  >`
    SELECT (SELECT count(*) FROM chatwoot_instances WHERE id = ${instanceId}) AS instances,
           (SELECT count(*) FROM contacts WHERE chatwoot_instance_id = ${instanceId}) AS contacts,
           (SELECT count(*) FROM conversations WHERE chatwoot_instance_id = ${instanceId}) AS conversations,
           (SELECT count(*) FROM chatwoot_webhook_deliveries WHERE chatwoot_instance_id = ${instanceId}) AS deliveries,
           (SELECT count(*) FROM inboxes WHERE chatwoot_instance_id = ${instanceId}) AS inboxes,
           (SELECT count(*) FROM conversations
             WHERE chatwoot_instance_id = ${instanceId} AND (contact_id IS NULL OR inbox_id IS NULL)) AS orphaned`;
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]),
  );
}

// The audit rows a removal of this account wrote, by action, in order.
async function auditOf(instanceId: bigint) {
  const rows = await suDb.$queryRaw<{ action: string }[]>`
    SELECT action FROM audit_logs WHERE target = ${`chatwoot_instance:${instanceId}`} ORDER BY id`;
  return rows.map((r) => r.action);
}

// A Chatwoot that records which bots the removal takes off which inboxes, answering everything else.
function detachingChatwoot() {
  const calls: string[] = [];
  const client = {
    setInboxAgentBot: async (inbox: number, bot: number | null) => {
      calls.push(`agent_bot ${inbox} ${bot}`);
      return {};
    },
    removeInboxObserver: async (inbox: number, bot: number) => {
      calls.push(`observer ${inbox} ${bot}`);
      return {};
    },
  };
  return {
    calls,
    makeClient: (async () =>
      client) as unknown as () => Promise<ChatwootClient>,
  };
}

// The app client with a hook in front of the N-th scoped transaction it opens: the removal is a
// sequence of them (disconnect, the read of the inboxes whose calls go off, then one per batch), so
// this is where "between two of them" is.
function beforeTransaction(n: number, hook: () => Promise<void>) {
  let scoped = 0;
  return new Proxy(appDb, {
    get(target, prop, receiver) {
      if (prop !== "$extends") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const ext = (
          target as unknown as { $extends: (...a: unknown[]) => object }
        ).$extends(...args);
        return new Proxy(ext, {
          get(et, ep, er) {
            if (ep !== "$transaction") return Reflect.get(et, ep, er);
            return async (...targs: unknown[]) => {
              scoped++;
              if (scoped === n) await hook();
              return (
                et as unknown as {
                  $transaction: (...a: unknown[]) => Promise<unknown>;
                }
              ).$transaction(...targs);
            };
          },
        });
      };
    },
  });
}

describe.skipIf(!dbUp)("removing a large Chatwoot account", () => {
  let tenantId = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Large removal", slug: `large-removal-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    await suDb.$executeRaw`DELETE FROM chatwoot_webhook_deliveries WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function account(accountId: number) {
    return seedChatwootInstance(suDb, {
      tenantId,
      accountId,
      accountName: `Account ${accountId}`,
      baseUrl: "https://chat.large-removal.example.com",
      adminToken: encryptJson("ADMIN"),
    });
  }

  // The production failure: every deleted contact nulls `conversations.contact_id` through its
  // foreign key, and with that column unindexed each one walked the whole conversations table, a
  // billion rows for the account in the issue. Here a smaller account still takes the base past the
  // default five-second budget; the neighbour shows nothing outside the account moved.
  test("an account whose contacts carry its conversations is removed within the default budget", async () => {
    const big = await account(15311);
    const neighbour = await account(15312);
    await seedVolume(tenantId, big.id, {
      contacts: 6_000,
      conversations: 60_000,
      deliveries: 20_000,
    });
    await seedVolume(tenantId, neighbour.id, {
      contacts: 50,
      conversations: 200,
      deliveries: 100,
    });

    await removeChatwootInstance(ctx(tenantId), big.id, appDb);

    expect(await rowsOf(big.id)).toEqual({
      instances: 0,
      contacts: 0,
      conversations: 0,
      deliveries: 0,
      inboxes: 0,
      orphaned: 0,
    });
    expect(await rowsOf(neighbour.id)).toEqual({
      instances: 1,
      contacts: 50,
      conversations: 200,
      deliveries: 100,
      inboxes: 3,
      orphaned: 0,
    });
  }, 120_000);

  // The batches empty an account's conversations before its contacts, so the removal above passes on
  // its own even without the index. The index is for every other place a contact goes while other
  // conversations stay: a batch of contacts beside a neighbour's 100k conversations, a deployment
  // disconnected (`contact.deleteMany` over the tenant), a tenant deleted. Each deleted contact then
  // looks its conversations up, and that lookup has to be an index, valid, led by the column.
  test("a deleted contact finds its conversations through an index on the column", async () => {
    const rows = await suDb.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = 'conversations'::regclass
         AND a.attname = 'contact_id'
         AND i.indisvalid
         AND i.indpred IS NULL`;
    expect(rows.map((r) => r.name)).toEqual(["conversations_contact_id_idx"]);
  });

  // How big an account gets is not bounded, and the request's budget applies to each statement: a
  // removal that deletes the webhook log in one statement fails once the log outgrows the budget,
  // whatever the indexes. Timing that here would measure this machine's load, so the test counts
  // instead: a statement-level trigger on each large table refuses any single statement, the
  // cascade's internal ones included, that deletes more of this tenant's rows than the cap.
  test("no statement of the removal deletes more than a bounded number of rows", async () => {
    const big = await account(15313);
    await seedVolume(tenantId, big.id, {
      contacts: 6_000,
      conversations: 12_000,
      deliveries: 12_000,
    });
    await suDb.$executeRaw`
      INSERT INTO other_inbox_summaries
        (tenant_id, chatwoot_instance_id, chatwoot_conversation_id, summary, covered_message_id,
         covered_fingerprint, generated_at, updated_at)
      SELECT ${tenantId}, ${big.id}, g, 'summary', g, 'f', now(), now()
        FROM generate_series(1, 12000) g`;
    const tables = [
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "other_inbox_summaries",
    ];
    await suDb.$executeRawUnsafe(`
      CREATE FUNCTION test_1531_statement_cap() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE n bigint;
      BEGIN
        SELECT count(*) INTO n FROM old_rows WHERE tenant_id = ${tenantId};
        IF n > 5000 THEN
          RAISE EXCEPTION 'one statement deleted % rows of %', n, TG_TABLE_NAME;
        END IF;
        RETURN NULL;
      END $$`);
    try {
      for (const table of tables) {
        await suDb.$executeRawUnsafe(
          `CREATE TRIGGER test_1531_statement_cap AFTER DELETE ON ${table}
             REFERENCING OLD TABLE AS old_rows
             FOR EACH STATEMENT EXECUTE FUNCTION test_1531_statement_cap()`,
        );
      }

      await removeChatwootInstance(ctx(tenantId), big.id, appDb);
    } finally {
      for (const table of tables) {
        await suDb.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS test_1531_statement_cap ON ${table}`,
        );
      }
      await suDb.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS test_1531_statement_cap()",
      );
    }

    expect(await rowsOf(big.id)).toMatchObject({
      instances: 0,
      contacts: 0,
      conversations: 0,
      deliveries: 0,
    });
    const [left] = await suDb.$queryRaw<[{ n: bigint }]>`
      SELECT count(*) AS n FROM other_inbox_summaries WHERE chatwoot_instance_id = ${big.id}`;
    expect(Number(left.n)).toBe(0);
  }, 120_000);

  // The removal is many transactions, so it can stop between them: the process dies, the database
  // drops the connection. What it leaves has to be an account that takes no traffic (a half-emptied
  // mirror that kept answering would rebuild conversations under a removal in progress), and the
  // operator's only move, running the same removal again, has to finish it.
  test("a removal stopped halfway leaves the account disconnected, and running it again finishes", async () => {
    const big = await account(15314);
    await seedVolume(tenantId, big.id, {
      contacts: 500,
      conversations: 3_000,
      deliveries: 3_000,
    });
    // An agent answering one of its inboxes and observing another: a follow-up or a nudge sends
    // through the binding, and neither asks whether the account is disconnected.
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Bound to a removed account", systemPrompt: "x" },
    });
    const inboxes = await suDb.inbox.findMany({
      where: { chatwootInstanceId: big.id },
      select: { id: true, chatwootInboxId: true },
      orderBy: { id: "asc" },
    });
    await suDb.inbox.update({
      where: { id: inboxes[0]?.id },
      data: { agentId: agent.id },
    });
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: inboxes[1]?.id as bigint, agentId: agent.id },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: big.id,
        agentId: agent.id,
        chatwootAgentBotId: 931,
        name: "Bound to a removed account",
        accessToken: "enc",
        webhookSecret: "enc",
        webhookRouteTokenHash: `large-removal-bot-${process.pid}`,
      },
    });
    const chatwoot = detachingChatwoot();
    // In order: the disconnect, the read of the inboxes whose calls go off, the client's load, the
    // two checks before each detach, and then the batches; the seventh is the second batch of the log.
    const dying = beforeTransaction(7, async () => {
      throw new Error("connection lost");
    });
    // A route token the receiver cached before the removal: through the batches it would keep
    // authenticating the account's webhooks out of memory, disconnected or not.
    writeRouteTokenCache("large-removal-hash", {
      tenantId,
      instanceId: big.id,
      agentBotId: 1,
      webhookSecret: "enc",
    });
    await expect(
      removeChatwootInstance(ctx(tenantId), big.id, dying, chatwoot),
    ).rejects.toThrow("connection lost");
    expect(readRouteTokenCache("large-removal-hash")).toBeUndefined();
    // Taken off in Chatwoot too, before the batches: reconnected from here, the account would
    // otherwise keep delivering through bots that no binding here holds.
    expect(chatwoot.calls).toEqual([
      `agent_bot ${inboxes[0]?.chatwootInboxId} null`,
      `observer ${inboxes[1]?.chatwootInboxId} 931`,
    ]);
    const halfway = await suDb.chatwootInstance.findUnique({
      where: { id: big.id },
      select: { disconnectedAt: true },
    });
    expect(halfway?.disconnectedAt).not.toBeNull();
    expect(
      await suDb.inbox.count({
        where: { chatwootInstanceId: big.id, agentId: { not: null } },
      }),
    ).toBe(0);
    expect(
      await suDb.inboxObserver.count({ where: { agentId: agent.id } }),
    ).toBe(0);
    expect((await rowsOf(big.id)).deliveries).toBe(2_000);
    // Disconnected, not removed: the trail says exactly that until the delete happens.
    expect(await auditOf(big.id)).toEqual(["instance.disconnect"]);

    await removeChatwootInstance(ctx(tenantId), big.id, appDb, chatwoot);
    // The retry finds nothing left to disconnect, so the trail gains the removal and nothing else.
    expect(await auditOf(big.id)).toEqual([
      "instance.disconnect",
      "instance.remove",
    ]);
    expect(await rowsOf(big.id)).toMatchObject({
      instances: 0,
      contacts: 0,
      conversations: 0,
      deliveries: 0,
    });
  }, 120_000);

  // Two clicks on "Remove account" are two removals of the same account running together. Neither
  // may fail on the row the other one already deleted; the one that arrives after the account is
  // gone may say so (404), which is what the console shows for an account that no longer exists.
  test("two removals of the same account at once both end without an error other than not found", async () => {
    const big = await account(15315);
    await seedVolume(tenantId, big.id, {
      contacts: 1_000,
      conversations: 6_000,
      deliveries: 6_000,
    });

    const results = await Promise.allSettled([
      removeChatwootInstance(ctx(tenantId), big.id, appDb),
      removeChatwootInstance(ctx(tenantId), big.id, appDb),
    ]);

    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toBeInstanceOf(NotFoundError);
    }
    expect(await rowsOf(big.id)).toMatchObject({
      instances: 0,
      contacts: 0,
      conversations: 0,
      deliveries: 0,
    });
  }, 120_000);

  // Reconnecting is the other door to an account under removal: the operator can reconnect it from
  // the console while the batches run. From then on it takes traffic again, so the removal has to
  // stop at the next batch rather than keep erasing it, and never delete the row at the end.
  test("an account reconnected in the middle of its removal stops the removal and survives", async () => {
    const big = await account(15316);
    await seedVolume(tenantId, big.id, {
      contacts: 500,
      conversations: 3_000,
      deliveries: 3_000,
    });
    const reconnecting = beforeTransaction(4, async () => {
      await reconnectChatwootInstance(ctx(tenantId), big.id, appDb);
    });

    await expect(
      removeChatwootInstance(ctx(tenantId), big.id, reconnecting),
    ).rejects.toBeInstanceOf(ConflictError);

    const after = await suDb.chatwootInstance.findUnique({
      where: { id: big.id },
      select: { disconnectedAt: true },
    });
    expect(after).toEqual({ disconnectedAt: null });
    expect(await rowsOf(big.id)).toMatchObject({
      instances: 1,
      contacts: 500,
      conversations: 3_000,
      deliveries: 2_000,
    });
    expect(await auditOf(big.id)).not.toContain("instance.remove");
  }, 120_000);

  // Disconnected again right after the reconnect, the account carries a timestamp once more, but
  // not the one the removal opened with: the operator brought it back in between, so the removal
  // that began before still has to stop rather than erase it.
  test("an account reconnected and disconnected again in the middle of its removal still stops it", async () => {
    const big = await account(15317);
    await seedVolume(tenantId, big.id, {
      contacts: 500,
      conversations: 3_000,
      deliveries: 3_000,
    });
    const flipping = beforeTransaction(4, async () => {
      await reconnectChatwootInstance(ctx(tenantId), big.id, appDb);
      await suDb.chatwootInstance.update({
        where: { id: big.id },
        data: { disconnectedAt: new Date() },
      });
    });

    await expect(
      removeChatwootInstance(ctx(tenantId), big.id, flipping),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await rowsOf(big.id)).toMatchObject({
      instances: 1,
      contacts: 500,
      conversations: 3_000,
      deliveries: 2_000,
    });
    expect(await auditOf(big.id)).not.toContain("instance.remove");
  }, 120_000);

  // A soft-disconnected account has no responder left but keeps its observers, and the removal
  // deletes them. That is a change of its own, so the trail has to show it even when the flag and
  // the bindings were already as the removal leaves them.
  test("removing a soft-disconnected account records the observers it takes", async () => {
    const big = await account(15318);
    await seedVolume(tenantId, big.id, {
      contacts: 100,
      conversations: 300,
      deliveries: 300,
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Observer of a disconnected account",
        systemPrompt: "x",
      },
    });
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { chatwootInstanceId: big.id },
      select: { id: true },
    });
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: inbox.id, agentId: agent.id },
    });
    await suDb.chatwootInstance.update({
      where: { id: big.id },
      data: { disconnectedAt: new Date() },
    });
    const dying = beforeTransaction(2, async () => {
      throw new Error("connection lost");
    });

    await expect(
      removeChatwootInstance(ctx(tenantId), big.id, dying),
    ).rejects.toThrow("connection lost");

    const [row] = await suDb.$queryRaw<{ action: string; before: unknown }[]>`
      SELECT action, before FROM audit_logs
       WHERE target = ${`chatwoot_instance:${big.id}`} ORDER BY id`;
    expect(row?.action).toBe("instance.disconnect");
    expect(row?.before).toMatchObject({ removedObservers: 1, stamped: false });
  }, 120_000);
});
