import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  bindInbox,
  connectChatwootDeployment,
  disconnectChatwootDeployment,
  reconcileInboxBots,
  reconnectChatwootInstance,
  reconnectInbox,
  removeChatwootInstance,
  removeInbox,
  rotateChatwootDeploymentToken,
  setConnectedAccounts,
  softDisconnectChatwootInstance,
  syncInboxes,
} from "@/modules/chatwoot/management";

// THE CHANNEL-MANAGEMENT FAMILY (issue #395), whose trail was written by the MCP transport and by
// nothing else. The Channels page speaks `chatwoot-admin.controller.ts`, eleven mutating routes, none
// of which contained the string `audit`: connecting a deployment, rotating its token, disconnecting
// it, binding or removing an inbox all left nothing.
//
// Three of those routes had no MCP twin at all and get an action name here:
// `deployment.disconnect`, `instance.reconnect` and `instance.remove`.
//
// The other thing this family carries is the secret. The deployment admin token is one of the two
// documented raw-secret carve-outs (`docs/mcp.md`) and the MCP rows kept metadata only; the console
// path has to redact identically, which is what the fence at the bottom of this file measures over
// every row the file produced.

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

const USER = 9395n;
// The one string that must never reach a row. Distinctive on purpose: the fence greps every row this
// file wrote for it.
const ADMIN_TOKEN = "cw-admin-token-9395-secret";
const ROTATED_TOKEN = "cw-rotated-token-9395-secret";
// TEST-NET-3 (RFC 5737, reserved for documentation): an IP literal keeps the SSRF guard off DNS and
// is public enough to pass its blocked-range check, which loopback is not under the test config.
// Nothing is dialed: every call that would reach the network is injected below.
const BASE_URL = "https://203.0.113.95";

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

// A Chatwoot whose /profile answers with two accounts, which is what connect and rotate probe.
const fetchProfile = async () => ({
  accounts: [
    { id: 1, name: "Conta A" },
    { id: 2, name: "Conta B" },
  ],
});

function stubClient(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const client = {
    getInbox: async (id: number) => {
      calls.push(`getInbox:${id}`);
      return { id };
    },
    listInboxes: async () => {
      calls.push("listInboxes");
      return [];
    },
    setInboxAgentBot: async () => {
      calls.push("setInboxAgentBot");
      return {};
    },
    // Provisioning, which `bindInbox` runs before it persists anything: the bot has to exist in
    // Chatwoot for the binding to mean something.
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
    ...over,
  };
  return { calls, makeClient: async () => client as unknown as ChatwootClient };
}

// A client that lets a CONCURRENT request land in the one window `setConnectedAccounts` cannot see:
// between the snapshot it reads of which accounts are active and the writes it derives from it. Each
// step of that function runs in its own transaction, so the window is real and two overlapping
// requests give it to each other; the hook makes the interleaving deterministic instead of timing-
// dependent.
//
// It fires on the snapshot read and on nothing else: it is the only `chatwootInstance.findMany` on
// this path that asks for `disconnectedAt` (the claims lookup reads `accountId`/`tenantId`, and the
// listing that closes the function runs after the flag is already spent).
function afterSnapshot(
  client: PrismaClient,
  hook: () => Promise<unknown>,
): PrismaClient {
  let fired = false;
  // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "$extends") {
          return (...a: unknown[]) => wrap(t.$extends(...a));
        }
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
            t.$transaction((tx: unknown) => fn(wrap(tx)), ...rest);
        }
        if (prop !== "chatwootInstance") return Reflect.get(t, prop, recv);
        const delegate = Reflect.get(t, prop, recv);
        return new Proxy(delegate, {
          get(d, k, r) {
            const inner = Reflect.get(d, k, r);
            if (k !== "findMany") return inner;
            return async (args: { select?: Record<string, unknown> }) => {
              const res = await (
                inner as (a: unknown) => Promise<unknown>
              ).call(d, args);
              if (!fired && args?.select?.disconnectedAt === true) {
                fired = true;
                await hook();
              }
              return res;
            };
          },
        });
      },
    });
  return wrap(client);
}

async function rows(action?: string) {
  return (
    (await su?.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: { id: "asc" },
    })) ?? []
  );
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

// Everything this file wrote, kept for the redaction fence at the end. The fence is over the WHOLE
// run rather than per test, because a secret leaking into one row of twelve is exactly the shape a
// per-test assertion misses.
const everyRow: unknown[] = [];

async function collect() {
  everyRow.push(...(await rows()));
}

describe.skipIf(!dbUp)("the channel family records its own changes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AUD395", slug: `aud395-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("connecting a deployment records the server, and never the token", async () => {
    await clearAudit();
    const result = await connectChatwootDeployment(
      ctx(),
      { baseUrl: `${BASE_URL}/p${process.pid}`, adminToken: ADMIN_TOKEN },
      { fetchProfile },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("deployment.connect");
    expect(row?.target).toBe(`chatwoot_deployment:${result.deployment.id}`);
    expect(row?.actorId).toBe(USER);
    expect(row?.actorType).toBe("user");
    // The ORIGIN, not the URL as typed: a base URL is operator-entered and the row outlives it. The
    // `/…` is what `redactEndpoint` leaves behind to say a path was dropped rather than absent.
    expect(row?.after).toEqual({
      id: result.deployment.id,
      baseUrl: "https://203.0.113.95/…",
      reachableAccounts: 2,
    });
    await collect();
  });

  test("rotating the token records that it moved, not what it moved to", async () => {
    await clearAudit();
    const updated = await rotateChatwootDeploymentToken(
      ctx(),
      ROTATED_TOKEN,
      { fetchProfile },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("deployment.rotate_token");
    expect(row?.after).toEqual({ id: updated.id, adminTokenRotated: true });
    await collect();
  });

  // `encryptJson` randomizes, so the stored blob differs on every write even for the same token. The
  // comparison has to be on the plaintext, or a retry of a request that timed out reports a rotation
  // that never happened.
  test("re-submitting the token already stored records nothing", async () => {
    await clearAudit();
    await rotateChatwootDeploymentToken(
      ctx(),
      ROTATED_TOKEN,
      { fetchProfile },
      appDb,
    );
    expect(await rows()).toEqual([]);
  });

  // The comparison reads the STORED plaintext, so it is also the first thing to meet a blob that
  // will not decrypt. It refuses, and that is the rule the whole repo follows for these columns: the
  // client loader, the webhook and the disconnect all throw on the same blob, so a connect that
  // swallowed it would report success on a deployment still broken everywhere it is actually used.
  test("a stored token that cannot be decrypted refuses the write instead of overwriting it", async () => {
    await clearAudit();
    const dep = await suDb.chatwootDeployment.findFirstOrThrow({
      where: { tenantId },
      select: { id: true, adminToken: true },
    });
    await suDb.chatwootDeployment.update({
      where: { id: dep.id },
      data: { adminToken: "isto-nao-e-um-blob" },
    });
    expect(
      rotateChatwootDeploymentToken(
        ctx(),
        "cw-outro-token",
        { fetchProfile },
        appDb,
      ),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]);
    await suDb.chatwootDeployment.update({
      where: { id: dep.id },
      data: { adminToken: dep.adminToken },
    });
  });

  test("choosing which accounts are connected records the choice", async () => {
    await clearAudit();
    await setConnectedAccounts(
      ctx(),
      [1, 2],
      { fetchProfile, makeClient: stubClient().makeClient },
      appDb,
    );
    // The choice AND what it did, which are not the same fact: a reader who saw only the choice
    // could not tell which accounts it actually moved. Each account connects in its OWN
    // transaction and records there, so a crash between two of them leaves the account handled
    // with a row saying so. The choice is the row on top.
    const all = await rows();
    expect(all.map((r) => r.action)).toEqual([
      "instance.connect",
      "instance.connect",
      "deployment.set_accounts",
    ]);
    // No `instance.sync_inboxes` between them: the sync runs for each account and this Chatwoot has
    // no inboxes, so it reconciled a mirror that was already correct and changed nothing.
    const row = all[2];
    expect(row?.after).toEqual({ accountIds: [1, 2], connected: 2 });
    await collect();
  });

  // The other half of the same rule, and the one a re-submitted form exercises every day: both loops
  // above skip every account when the selection already matches, so nothing happened and nothing is
  // recorded.
  test("choosing the same accounts again records nothing", async () => {
    await clearAudit();
    await setConnectedAccounts(
      ctx(),
      [1, 2],
      { fetchProfile, makeClient: stubClient().makeClient },
      appDb,
    );
    expect(await rows()).toEqual([]);
  });

  // THE SNAPSHOT IS NOT THE WRITE, and these two tests are the pair that says so. `activeIds` is read
  // once, before either loop, and two overlapping copies of the same request read the SAME one: if
  // the rows were derived from it, the request that lost every race would still record a connect, a
  // disconnect and the choice on top of them.
  test("a connection that landed first is not recorded a second time", async () => {
    await setConnectedAccounts(
      ctx(),
      [1, 2, 3],
      { fetchProfile, makeClient: stubClient().makeClient },
      appDb,
    );
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 3 },
      select: { id: true },
    });
    await softDisconnectChatwootInstance(ctx(), inst.id, appDb);
    await clearAudit();
    // The operator re-submits [1, 2, 3] while another request is already reconnecting account 3.
    await setConnectedAccounts(
      ctx(),
      [1, 2, 3],
      { fetchProfile, makeClient: stubClient().makeClient },
      afterSnapshot(appDb, () =>
        reconnectChatwootInstance(ctx(), inst.id, appDb),
      ),
    );
    const all = await rows();
    // The reconnect that WON is on the trail, once. The sync ran either way (it is idempotent and
    // the operator asked for it) and moved nothing, so it left no row; and neither `instance.connect`
    // nor the choice is recorded, because by the time this request reached the row the account was
    // already being handled.
    expect(all.map((r) => r.action)).toEqual(["instance.reconnect"]);
    expect(await rows("instance.connect")).toEqual([]);
    expect(await rows("deployment.set_accounts")).toEqual([]);
    await collect();
  });

  test("a de-selection that landed first is not recorded a second time", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 3 },
      select: { id: true },
    });
    await clearAudit();
    // The operator drops account 3 while another request is already dropping it.
    await setConnectedAccounts(
      ctx(),
      [1, 2],
      { fetchProfile, makeClient: stubClient().makeClient },
      afterSnapshot(appDb, () =>
        softDisconnectChatwootInstance(ctx(), inst.id, appDb),
      ),
    );
    expect((await rows()).map((r) => r.action)).toEqual([
      "instance.disconnect",
    ]);
    await collect();
    // Back to the two accounts the rest of the file expects.
    await removeChatwootInstance(ctx(), inst.id, appDb);
  });

  test("disconnecting an account records what it was", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true, accountId: true, accountName: true },
    });
    // No injectable client here: the service builds its own and the unbind is best-effort, so the
    // loopback refusal above is exactly the shape it already tolerates.
    await softDisconnectChatwootInstance(ctx(), inst.id, appDb);
    const [row] = await rows();
    expect(row?.action).toBe("instance.disconnect");
    expect(row?.target).toBe(`chatwoot_instance:${inst.id}`);
    expect(row?.before).toMatchObject({ accountId: 2 });
    await collect();
  });

  test("disconnecting an account that is already disconnected records nothing", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true, disconnectedAt: true },
    });
    expect(inst.disconnectedAt).not.toBeNull();
    await softDisconnectChatwootInstance(ctx(), inst.id, appDb);
    expect(await rows()).toEqual([]);
    // And the moment it happened did not move: re-stamping would rewrite when the account stopped
    // being handled.
    const after = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: inst.id },
      select: { disconnectedAt: true },
    });
    expect(after.disconnectedAt).toEqual(inst.disconnectedAt);
  });

  // No MCP twin: the name is invented here, and the console is the only door it has.
  test("reconnecting an account records it, under a name of its own", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true },
    });
    await reconnectChatwootInstance(ctx(), inst.id, appDb);
    const [row] = await rows();
    expect(row?.action).toBe("instance.reconnect");
    expect(row?.target).toBe(`chatwoot_instance:${inst.id}`);
    expect(row?.after).toMatchObject({ accountId: 2, disconnectedAt: null });
    await collect();
  });

  test("reconnecting an account that was never disconnected records nothing", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true, disconnectedAt: true },
    });
    expect(inst.disconnectedAt).toBeNull();
    await reconnectChatwootInstance(ctx(), inst.id, appDb);
    expect(await rows()).toEqual([]);
  });

  test("removing an account records what went with it", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true },
    });
    await removeChatwootInstance(ctx(), inst.id, appDb);
    const [row] = await rows();
    expect(row?.action).toBe("instance.remove");
    expect(row?.target).toBe(`chatwoot_instance:${inst.id}`);
    expect(row?.before).toMatchObject({ accountId: 2 });
    expect(await suDb.chatwootInstance.count({ where: { id: inst.id } })).toBe(
      0,
    );
    await collect();
  });

  test("binding an inbox to an agent records both sides", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 1 },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Atendente", systemPrompt: "x" },
      select: { id: true },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 71,
        name: "WhatsApp",
      },
      select: { id: true },
    });
    await bindInbox(
      ctx(),
      inbox.id,
      agent.id,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("inbox.bind");
    expect(row?.target).toBe(`inbox:${inbox.id}`);
    expect(row?.before).toEqual({ agentId: null });
    expect(row?.after).toEqual({ agentId: String(agent.id) });
    await collect();
  });

  test("binding the same agent again records nothing", async () => {
    await clearAudit();
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: 71 },
      select: { id: true, agentId: true },
    });
    await bindInbox(
      ctx(),
      inbox.id,
      inbox.agentId,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    expect(await rows()).toEqual([]);
  });

  test("unbinding an inbox records the agent it lost", async () => {
    await clearAudit();
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: 71 },
      select: { id: true, agentId: true },
    });
    await reconnectInbox(
      ctx(),
      inbox.id,
      { makeClient: stubClient().makeClient },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("inbox.reconnect");
    expect(row?.target).toBe(`inbox:${inbox.id}`);
    await collect();
  });

  test("removing an inbox records what it was", async () => {
    await clearAudit();
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: 71 },
      select: { id: true },
    });
    await removeInbox(
      ctx(),
      inbox.id,
      {
        makeClient: stubClient({
          // A 404 is how the fork says the inbox is gone, and this path REFUSES to remove a mirror
          // whose inbox still exists, so a generic throw reads as "could not confirm" instead.
          getInbox: async () => {
            throw new ChatwootApiError(404, "GET /inboxes/71");
          },
        }).makeClient,
      },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("inbox.remove");
    expect(row?.target).toBe(`inbox:${inbox.id}`);
    expect(row?.before).toMatchObject({ chatwootInboxId: 71 });
    await collect();
  });

  // The remote list a sync reconciles against, as Chatwoot spells it.
  const remoteInbox = (over: Record<string, unknown> = {}) => [
    {
      id: 77,
      name: "Suporte",
      channel_type: "Channel::Api",
      provider: null,
      ...over,
    },
  ];

  test("syncing an account's inboxes records what the reconcile created", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 1 },
      select: { id: true },
    });
    await syncInboxes(
      ctx(),
      inst.id,
      {
        makeClient: stubClient({ listInboxes: async () => remoteInbox() })
          .makeClient,
      },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("instance.sync_inboxes");
    expect(row?.target).toBe(`chatwoot_instance:${inst.id}`);
    expect(row?.after).toEqual({
      total: 1,
      created: 1,
      updated: 0,
      accountRenamed: false,
    });
    await collect();
  });

  test("a reconcile that finds the mirror already correct records nothing", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 1 },
      select: { id: true },
    });
    await syncInboxes(
      ctx(),
      inst.id,
      {
        makeClient: stubClient({ listInboxes: async () => remoteInbox() })
          .makeClient,
      },
      appDb,
    );
    // This is the every-page-load case, not an exotic one: the Channels page syncs every active
    // account when it opens, so an unconditional row would put one per account per visit into an
    // append-only table nobody asked to grow.
    expect(await rows()).toEqual([]);
  });

  test("a reconcile that finds an inbox renamed upstream records it as a change", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 1 },
      select: { id: true },
    });
    await syncInboxes(
      ctx(),
      inst.id,
      {
        makeClient: stubClient({
          listInboxes: async () => remoteInbox({ name: "Suporte 24h" }),
        }).makeClient,
      },
      appDb,
    );
    const [row] = await rows();
    expect(row?.after).toMatchObject({ total: 1, created: 0, updated: 1 });
    await collect();
    // Back to no mirrored inbox, the way the tests after this one expect the account.
    await suDb.inbox.deleteMany({
      where: { chatwootInstanceId: inst.id, chatwootInboxId: 77 },
    });
  });

  // The one action of the nine that does NOT move down, and the reason is measured rather than
  // stylistic: `reconcileInboxBots` lists inboxes, lists bots, asks Chatwoot which are live and
  // returns a status map. Nothing is written on either side, and its REST twin is a GET. The row the
  // MCP transport used to write was a read on the trail, which is the same call `webhook_test` and
  // `mcp_connection_discover` already answer with silence (#397, #399).
  test("reading which bots are live records nothing", async () => {
    await clearAudit();
    const statuses = await reconcileInboxBots(
      ctx(),
      { makeClient: stubClient().makeClient },
      appDb,
    );
    expect(typeof statuses).toBe("object");
    expect(await rows()).toEqual([]);
  });

  // LAST, and it is destructive on a scale nothing else here is: the deployment cascades every
  // account, inbox, bot and conversation of the tenant, and the contacts are deleted first because no
  // cascade reaches them. Its row is the only thing that survives it.
  test("disconnecting the deployment records what it destroyed", async () => {
    await clearAudit();
    const dep = await suDb.chatwootDeployment.findFirstOrThrow({
      where: { tenantId },
      select: { id: true, baseUrl: true },
    });
    await disconnectChatwootDeployment(ctx(), appDb);
    const [row] = await rows();
    expect(row?.action).toBe("deployment.disconnect");
    expect(row?.target).toBe(`chatwoot_deployment:${dep.id}`);
    expect(row?.before).toEqual({
      id: String(dep.id),
      baseUrl: "https://203.0.113.95/…",
      // The inbox this file created was removed two tests ago, which is the point of counting at
      // the moment of the delete rather than describing the deployment in the abstract.
      accounts: 1,
      inboxes: 0,
      contacts: 0,
    });
    expect(await suDb.chatwootDeployment.count({ where: { tenantId } })).toBe(
      0,
    );
    await collect();
  });

  // The fence, over every row the file wrote. `docs/mcp.md` names the deployment admin token as one
  // of the two raw-secret carve-outs, and the point of moving the row down a layer is that the
  // console now writes it too: a projection that kept the token would put it in an append-only table
  // a tenant admin can read.
  test("no row anywhere in this family carries the token", () => {
    expect(everyRow.length).toBeGreaterThan(8);
    const dumped = JSON.stringify(everyRow, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(dumped).not.toContain(ADMIN_TOKEN);
    expect(dumped).not.toContain(ROTATED_TOKEN);
  });
});
