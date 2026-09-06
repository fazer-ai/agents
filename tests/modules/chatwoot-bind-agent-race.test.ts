import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { deleteAgent } from "@/modules/agents/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { bindInbox } from "@/modules/chatwoot/management";
import { seedChatwootInstance } from "../utils/chatwoot";

// #546. `Inbox.agentId` is a plain column with no `@relation`, so no foreign key ever refused a
// binding to an agent that is gone, and `persistBinding` referenced the row without holding any lock
// on it. `deleteAgent` is the writer that fits in the window: it takes the agent `FOR UPDATE`, nulls
// every inbox pointing at it (this one is not yet), deletes it, and the bind then commits the
// dangling reference. The window is not a millisecond either: step 2 of `bindInbox` is the round trip
// to Chatwoot, made deliberately OUTSIDE the transaction.
//
// Sibling of #501, which answered the same shape on `Experiment.agentId`.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Personifies only what `bindInbox` calls on the way to persisting: the bot has to exist in Chatwoot
// and be attached before the row means anything. `onAttach` is the SEAM this file is about, because
// the attach is the last thing that happens outside the transaction.
function stubClient(onAttach?: () => Promise<void>) {
  const calls: string[] = [];
  const client = {
    listAgentBots: async () => {
      calls.push("listAgentBots");
      return [];
    },
    createAgentBot: async () => {
      calls.push("createAgentBot");
      return { id: 900, access_token: "bot-token", secret: "bot-secret" };
    },
    updateAgentBot: async () => {
      calls.push("updateAgentBot");
      return {};
    },
    setInboxAgentBot: async () => {
      calls.push("setInboxAgentBot");
      await onAttach?.();
      return {};
    },
  } as unknown as ChatwootClient;
  return { calls, makeClient: async () => client };
}

describe.skipIf(!dbUp)("#546 binding an agent that is being deleted", () => {
  let instanceId = 0n;
  let nextInbox = 5460;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "BIND546", slug: `bind546-${process.pid}` },
    });
    tenantId = t.id;
    // A real blob, not the seed's "enc" marker: `loadChatwootClient` decrypts the deployment's admin
    // token before it ever reaches `deps.makeClient`, so a stubbed client does not spare the fixture
    // from having a decryptable one.
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 5460,
      accountName: "BIND546",
      adminToken: encryptJson("admin-token"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // A fresh unbound inbox and a fresh agent per test: the binding this file measures is the write,
  // and a fixture shared between tests would carry the previous one's.
  async function pair(label: string) {
    const agent = await suDb.agent.create({
      data: { tenantId, name: `Ag ${label}`, systemPrompt: "x" },
      select: { id: true },
    });
    nextInbox += 1;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: nextInbox,
        name: `Inbox ${label}`,
        agentId: null,
      },
      select: { id: true },
    });
    return { agentId: agent.id, inboxId: inbox.id };
  }

  const boundAgentOf = async (inboxId: bigint) =>
    (
      await suDb.inbox.findUniqueOrThrow({
        where: { id: inboxId },
        select: { agentId: true },
      })
    ).agentId;

  // THE EFFECT, driven through the real write and through the real window: the agent is deleted from
  // inside the Chatwoot call, which is where a concurrent delete actually lands. Nothing here is
  // timed, and nothing simulates the race by reaching into the service.
  test("an agent deleted during the Chatwoot call leaves no binding to it", async () => {
    const { agentId, inboxId } = await pair("deleted");
    const stub = stubClient(async () => {
      await deleteAgent(ctx(), agentId, appDb);
    });

    // The line this leaves behind, because the bot IS attached upstream and the operator reads the
    // log to know what to do about it. A refusal decided inside the transaction is not the state a
    // retry repairs, and saying "retry the bind" here sends them at a loop that cannot close.
    const warn = spyOn(logger, "warn");
    const error = spyOn(logger, "error");
    try {
      await expect(
        bindInbox(
          ctx(),
          inboxId,
          agentId,
          { makeClient: stub.makeClient },
          appDb,
        ),
      ).rejects.toThrow(/agent/i);
      const said = (calls: unknown[][]) =>
        calls.map((c) => String((c as unknown[])[1] ?? ""));
      expect(
        said(warn.mock.calls as unknown[][]).some((m: string) =>
          m.includes("refuses the same way"),
        ),
      ).toBe(true);
      expect(
        said(error.mock.calls as unknown[][]).some((m: string) =>
          m.includes("retry the bind"),
        ),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    // The delete DID happen inside the window: without this the refusal above could be about an
    // agent that was never there, which is a different test passing for the wrong reason.
    expect(stub.calls).toContain("setInboxAgentBot");
    expect(await suDb.agent.count({ where: { tenantId, id: agentId } })).toBe(
      0,
    );
    expect(await boundAgentOf(inboxId)).toBeNull();
  });

  // THE CONTROL for the test above, in the same shape: with nobody deleting anything, the same call
  // binds. Without it, a refusal that came from the stub, from the fixture or from the account would
  // read exactly like the one the rule produces.
  test("the same call with nobody deleting anything binds", async () => {
    const { agentId, inboxId } = await pair("plain");
    const stub = stubClient();
    await bindInbox(
      ctx(),
      inboxId,
      agentId,
      { makeClient: stub.makeClient },
      appDb,
    );
    expect(stub.calls).toContain("setInboxAgentBot");
    expect(await boundAgentOf(inboxId)).toBe(agentId);
  });

  type Holder = { pid: number; release: () => void; done: Promise<unknown> };

  // Takes a lock on the agent and resolves once it HAS it. The mode is the parameter because the
  // point of two of the tests below is which OTHER writer this bind waits for: `FOR UPDATE` is what
  // `deleteAgent` takes, `FOR NO KEY UPDATE` is what an ordinary save takes.
  async function holdAgentLock(
    agentId: bigint,
    mode: "FOR UPDATE" | "FOR NO KEY UPDATE" = "FOR UPDATE",
  ): Promise<Holder> {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let announce!: (pid: number) => void;
    const gotIt = new Promise<number>((r) => {
      announce = r;
    });
    const done = runScopedOn(appDb, ctx(), async (db) => {
      await db.$queryRawUnsafe(
        `SELECT id FROM agents WHERE id = ${agentId} ${mode}`,
      );
      const [me] = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid`;
      announce(me?.pid as number);
      await held;
    });
    // A holder that failed would otherwise hang this on a promise nobody resolves, and the failure
    // would read as a timeout with no cause.
    return {
      pid: await Promise.race([gotIt, done.then(() => -1)]),
      release,
      done,
    };
  }

  // Polls Postgres rather than the clock: on a fast machine it returns in one round trip, and on a
  // slow one it keeps asking instead of concluding.
  async function someoneBlockedBy(pid: number, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const rows = await suDb.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
      if (rows.length > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  // THE MECHANISM, and why the lookup LOCKS instead of reading. Driven through the real write rather
  // than by re-issuing the lock here: a test that takes its own lock proves Postgres works and says
  // nothing about the guard. Nothing is timed: the holder signals its backend pid from inside the
  // transaction, and Postgres is asked who is blocking whom.
  test("the write waits for the agent's own lock", async () => {
    const { agentId, inboxId } = await pair("waits");
    // Provision the bot FIRST, and then re-bind through a client that reports it alive. Otherwise
    // `ensureAgentBot` inserts `chatwoot_agent_bots`, whose foreign key takes KEY SHARE on the agent
    // and blocks against the holder all by itself: the assertion below would be green with no guard
    // in the write at all, which is how this test passed before it was written properly.
    await bindInbox(
      ctx(),
      inboxId,
      agentId,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    await bindInbox(
      ctx(),
      inboxId,
      null,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    const provisioned = stubClient();
    (
      provisioned.makeClient() as unknown as {
        listAgentBots: () => Promise<unknown>;
      }
    ).listAgentBots = async () => [{ id: 900 }];

    const holder = await holdAgentLock(agentId);
    expect(holder.pid).toBeGreaterThan(0);

    let settled = false;
    const stub = provisioned;
    const write = bindInbox(
      ctx(),
      inboxId,
      agentId,
      { makeClient: stub.makeClient },
      appDb,
    ).then(() => {
      settled = true;
    });
    expect(await someoneBlockedBy(holder.pid)).toBe(true);
    expect(settled).toBe(false);

    // The ORDER, which a blocking assertion cannot see and which is what keeps this off a deadlock
    // with `deleteAgent` (it takes the agent, then the inboxes that point at it). Read from the
    // effect: parked on the AGENT, this write has not taken the inbox row, so a second transaction
    // can still take it. Under a statement timeout, because the wrong order makes this WAIT, and a
    // test that hangs reports nothing.
    await runScopedOn(appDb, ctx(), async (db) => {
      await db.$executeRawUnsafe("SET LOCAL statement_timeout = '2000ms'");
      await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR UPDATE`;
    });

    holder.release();
    await holder.done;
    await write;
    expect(settled).toBe(true);
    expect(await boundAgentOf(inboxId)).toBe(agentId);
  });

  // The other half of the mode, and the one a future edit is most likely to break: an ordinary SAVE
  // of the agent must NOT hold the bind up. `FOR KEY SHARE` conflicts with `FOR UPDATE` and with
  // nothing else, so this holds true only while the non-deleting writers take `FOR NO KEY UPDATE`
  // (`updateAgent` and `replaceAgentToolSelections`, weakened for exactly this in #546). If one of
  // them goes back to `FOR UPDATE`, this test does not fail with a message: it HANGS until the
  // runner kills it, which is the loud version of the stall it is about, since a bind that waits
  // here is holding the Chatwoot account row while it does.
  test("an ordinary save of the same agent does not hold the bind up", async () => {
    const { agentId, inboxId } = await pair("saved");
    const holder = await holdAgentLock(agentId, "FOR NO KEY UPDATE");
    expect(holder.pid).toBeGreaterThan(0);
    await bindInbox(
      ctx(),
      inboxId,
      agentId,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    expect(await boundAgentOf(inboxId)).toBe(agentId);
    holder.release();
    await holder.done;
  });

  // An unbind names no agent to lock, and has no dangling reference to make: it must not start
  // waiting on a row it is not going to write.
  test("an unbind does not wait on the agent it is removing", async () => {
    const { agentId, inboxId } = await pair("unbind");
    await bindInbox(
      ctx(),
      inboxId,
      agentId,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    const holder = await holdAgentLock(agentId);
    expect(holder.pid).toBeGreaterThan(0);
    await bindInbox(
      ctx(),
      inboxId,
      null,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    expect(await boundAgentOf(inboxId)).toBeNull();
    holder.release();
    await holder.done;
  });

  // The test above proves the two modes are compatible; this one proves the agents module still
  // SPEAKS the weak one. They are different claims, and only the second survives a writer being
  // added: a new `FOR UPDATE` in some third agent write would stall the bind exactly like the two
  // weakened in #546 did, and the test above would go on passing because it takes its own lock. The
  // delete is the single admissible strong lock, and it is the conflict the bind wants.
  test("only the delete takes a lock on the agent strong enough to stall a bind", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/agents/service.ts", import.meta.url),
    ).text();
    // Comments stripped first, for the reason the same fence in `audit-channel-family` gives: the
    // NOTEs in that file name `FOR UPDATE` while explaining why they do not take it.
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    const strong = [...code.matchAll(/FOR UPDATE/g)].map((m) => m.index);
    const del = code.indexOf("export async function deleteAgent(");
    const next = code.indexOf("\nexport async function", del + 1);
    expect(del).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(del);
    expect(strong).toHaveLength(1);
    expect(strong[0]).toBeGreaterThan(del);
    expect(strong[0]).toBeLessThan(next);
    expect(code.match(/FOR NO KEY UPDATE/g) ?? []).not.toHaveLength(0);
  });
});
