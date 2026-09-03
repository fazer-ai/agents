import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  bindInbox,
  connectChatwootDeployment,
  disconnectChatwootDeployment,
  normalizeChatwootBaseUrl,
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
import { routeTokenCacheGeneration } from "@/modules/chatwoot/route-token-cache";

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

// A hook that fires INSIDE the disconnect's transaction, right after it stamps the account: the
// account row is locked, the inboxes are already unbound, and nothing is committed yet. That is the
// exact window a concurrent bind lives in, and firing here is what makes the interleaving staged
// rather than raced. AWAITED, so the caller can hold this transaction open until the concurrent work
// has reached the point being tested — a hook that only kicks something off gives the two chains
// back to the scheduler and tests whichever order the machine happened to produce. Forwards to the
// REAL delegate of the transaction it is handed, never to a client from out here: under RLS an
// out-of-scope statement matches zero rows and the failure would look like a success.
function afterStamp(
  client: PrismaClient,
  hook: () => Promise<void>,
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
            if (k !== "updateMany") return inner;
            return async (args: unknown) => {
              const res = await (
                inner as (a: unknown) => Promise<unknown>
              ).call(d, args);
              if (!fired) {
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

// A client whose audit INSERT throws for ONE action, so the summary fails while the per-account
// writes it summarises are already committed. Forwards to the REAL delegate of the transaction it is
// handed, never to a client from out here: under RLS an out-of-scope statement matches zero rows and
// the failure would look like a success.
function auditFailingOn(client: PrismaClient, action: string): PrismaClient {
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
        if (prop !== "auditLog") return Reflect.get(t, prop, recv);
        const delegate = Reflect.get(t, prop, recv);
        return new Proxy(delegate, {
          get(d, k, r) {
            const inner = Reflect.get(d, k, r);
            if (k !== "create") return inner;
            return async (args: { data?: { action?: string } }) => {
              if (args?.data?.action === action) {
                throw new Error(`audit write failed for ${action}`);
              }
              return (inner as (a: unknown) => Promise<unknown>).call(d, args);
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
    // A label the winner of the race is the one who set: this deployment's /profile only knows
    // accounts 1 and 2, so the request below carries `null` for account 3.
    await suDb.chatwootInstance.update({
      where: { id: inst.id },
      data: { accountName: "Conta C" },
    });
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
    // And it moved nothing on the way past. The metadata refresh used to sit OUTSIDE the condition,
    // so the request that lost the race still overwrote the label — a change with no row anywhere,
    // and one the next sync could not report either, because by then the column already held it.
    expect(
      (
        await suDb.chatwootInstance.findUniqueOrThrow({
          where: { id: inst.id },
          select: { accountName: true },
        })
      ).accountName,
    ).toBe("Conta C");
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

  // The one row in this family written outside the transaction of the write it records, because the
  // writes it summarises are N transactions by design. By the time it runs the selection HAS been
  // applied, so failing the request over the summary would report a change that happened as a
  // failure, and the retry would be a no-op that never writes the row anyway.
  test("a selection that was applied is not failed by the summary that could not be written", async () => {
    await clearAudit();
    const before = await suDb.chatwootInstance.count({
      where: { tenantId, accountId: 3, disconnectedAt: null },
    });
    expect(before).toBe(0);
    await setConnectedAccounts(
      ctx(),
      [1, 2, 3],
      { fetchProfile, makeClient: stubClient().makeClient },
      auditFailingOn(appDb, "deployment.set_accounts"),
    );
    // The effect landed, and so did the row for the account that moved. Only the choice is missing.
    expect(
      await suDb.chatwootInstance.count({
        where: { tenantId, accountId: 3, disconnectedAt: null },
      }),
    ).toBe(1);
    expect((await rows()).map((r) => r.action)).toEqual(["instance.connect"]);
    await collect();
    // Back to the two accounts the rest of the file expects.
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 3 },
      select: { id: true },
    });
    await removeChatwootInstance(ctx(), inst.id, appDb);
    await clearAudit();
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
    expect(row?.before).toMatchObject({
      accountId: 2,
      // Both halves of what a disconnect does, and this account had no bound inbox to unbind.
      unboundInboxes: 0,
      stamped: true,
    });
    await collect();
  });

  // The unbind is a mutation of its own, and a bind can pass its instance check while a disconnect
  // is committing: the binding lands on an account already marked disconnected, and the retry that
  // clears it finds the stamp already there. Without the OR below, that retry finishes the
  // disconnect and leaves nothing on the trail.
  test("clearing a binding left on a disconnected account is recorded, stamp or no stamp", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true, disconnectedAt: true },
    });
    expect(inst.disconnectedAt).not.toBeNull();
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Perdido", systemPrompt: "x" },
      select: { id: true },
    });
    const stray = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 4242,
        name: "Órfã",
        agentId: agent.id,
      },
      select: { id: true },
    });
    await clearAudit();
    await softDisconnectChatwootInstance(ctx(), inst.id, appDb, {
      makeClient: stubClient().makeClient,
    });
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("instance.disconnect");
    expect(row?.before).toMatchObject({ unboundInboxes: 1, stamped: false });
    expect(
      (
        await suDb.inbox.findUniqueOrThrow({
          where: { id: stray.id },
          select: { agentId: true },
        })
      ).agentId,
    ).toBeNull();
    await collect();
    await suDb.inbox.delete({ where: { id: stray.id } });
    await suDb.agent.delete({ where: { id: agent.id } });
  });

  // The bots are detached in CHATWOOT, which no transaction of ours can roll back. Done before the
  // local writes, an audit row that cannot be written takes the unbind and the stamp down with it
  // and leaves the account connected and bound HERE while Chatwoot has already stopped delivering to
  // it: live on the page, answering nothing, and an operator who was told the disconnect failed.
  test("a disconnect that could not be recorded does not detach the bots in Chatwoot", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Preservado", systemPrompt: "x" },
      select: { id: true },
    });
    const bound = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 4343,
        name: "Ainda ligada",
        agentId: agent.id,
      },
      select: { id: true },
    });
    await clearAudit();
    const stub = stubClient();
    await expect(
      softDisconnectChatwootInstance(
        ctx(),
        inst.id,
        auditFailingOn(appDb, "instance.disconnect"),
        { makeClient: stub.makeClient },
      ),
    ).rejects.toThrow();
    expect(stub.calls).toEqual([]);
    expect(
      (
        await suDb.inbox.findUniqueOrThrow({
          where: { id: bound.id },
          select: { agentId: true },
        })
      ).agentId,
    ).toBe(agent.id);
    expect(await rows()).toEqual([]);
    await suDb.inbox.delete({ where: { id: bound.id } });
    await suDb.agent.delete({ where: { id: agent.id } });
  });

  // A CONNECTED account of its own, with one inbox and one agent, so the two tests below do not
  // depend on which state the sequence above left the shared accounts in. `bound` decides whether
  // the inbox starts attached to the agent (the disconnect has something to detach) or free (a bind
  // is what would attach it).
  async function connectedFixture(
    accountId: number,
    label: string,
    opts: { bound?: boolean } = {},
  ) {
    const dep = await suDb.chatwootDeployment.findFirstOrThrow({
      where: { tenantId },
      select: { id: true, baseUrl: true },
    });
    const agent = await suDb.agent.create({
      data: { tenantId, name: `Ag ${label}`, systemPrompt: "x" },
      select: { id: true },
    });
    const inst = await suDb.chatwootInstance.create({
      data: {
        tenantId,
        deploymentId: dep.id,
        accountId,
        serverKey: normalizeChatwootBaseUrl(dep.baseUrl),
        accountName: label,
      },
      select: { id: true },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: accountId,
        name: label,
        agentId: opts.bound === false ? null : agent.id,
      },
      select: { id: true },
    });
    await clearAudit();
    return {
      instanceId: inst.id,
      inboxId: inbox.id,
      agentId: agent.id,
      cleanup: async () => {
        await collect();
        await suDb.inbox.deleteMany({ where: { chatwootInstanceId: inst.id } });
        await suDb.chatwootInstance.delete({ where: { id: inst.id } });
        await suDb.agent.delete({ where: { id: agent.id } });
      },
    };
  }

  // The positive cache says "this route token resolves to a live bot", and it is what authenticates
  // an incoming webhook. The detach after the commit is best-effort and can take as long as an
  // unreachable Chatwoot takes to time out; every warm entry keeps admitting traffic for an already
  // disconnected account for that whole span. So the cache goes the moment the disconnect is
  // durable, which is before the first network call and not after the last.
  test("the route-token cache is dropped before the detach waits on Chatwoot", async () => {
    const fx = await connectedFixture(4444, "Cache");
    let generationAtNetwork = -1;
    const before = routeTokenCacheGeneration();
    const stub: ReturnType<typeof stubClient> = stubClient({
      setInboxAgentBot: async () => {
        generationAtNetwork = routeTokenCacheGeneration();
        stub.calls.push("setInboxAgentBot");
        return {};
      },
    });
    try {
      await softDisconnectChatwootInstance(ctx(), fx.instanceId, appDb, {
        makeClient: stub.makeClient,
      });
      expect(stub.calls).toEqual(["setInboxAgentBot"]);
      expect(generationAtNetwork).toBeGreaterThan(before);
    } finally {
      // Always, because this fixture adds an account the deployment-wide tests below COUNT: a
      // failure here would otherwise be reported twice, once truly and once as a wrong total.
      await fx.cleanup();
    }
  });

  // A bind reads "the account is active", talks to Chatwoot, and only then persists — so a disconnect
  // fits entirely inside its window. Without the account lock on the persist, the disconnect unbinds
  // every inbox bound AT THAT MOMENT (not this one, which is still null), commits, and its own
  // best-effort detach then pulls the bot this bind had just attached. What survives is an inbox
  // bound here with no bot in Chatwoot, on an account that reconnects looking healthy, and binding
  // the same agent again is a no-op because the binding is already there.
  test("a bind that lands while the disconnect commits is refused, not persisted", async () => {
    const fx = await connectedFixture(4445, "Corrida", { bound: false });
    // The bind is released exactly as far as its FIRST Chatwoot call: by then it has passed its own
    // active check against an account this transaction has stamped and not committed, which is the
    // window under test, and it has not yet inserted the bot row. Not one step further, because that
    // insert carries a foreign key to the account and an FK insert takes a KEY SHARE lock on the
    // parent — it would block on the FOR UPDATE this very transaction is holding, while this
    // transaction waits for it. Staged this way the test does not depend on which of the two chains
    // the scheduler resumes first.
    let asked: () => void = () => {};
    const reachedChatwoot = new Promise<void>((res) => {
      asked = res;
    });
    const binding = stubClient({
      createAgentBot: async () => {
        asked();
        return { id: 901, access_token: "bot-token", secret: "bot-secret" };
      },
    });
    let bind: Promise<unknown> = Promise.resolve(null);
    const staged = afterStamp(appDb, async () => {
      bind = bindInbox(
        ctx(),
        fx.inboxId,
        fx.agentId,
        { makeClient: binding.makeClient },
        appDb,
      ).then(
        () => "bound",
        (e) => e,
      );
      await reachedChatwoot;
    });
    try {
      await softDisconnectChatwootInstance(ctx(), fx.instanceId, staged, {
        makeClient: stubClient().makeClient,
      });
      const outcome = await bind;
      // The binding is what the account is judged by, so the assertion that matters is the column: a
      // bind that persisted here leaves an inbox pointing at an agent whose bot the disconnect has
      // already pulled, and re-binding the same agent later is a no-op that fixes nothing.
      expect(
        (
          await suDb.inbox.findUniqueOrThrow({
            where: { id: fx.inboxId },
            select: { agentId: true },
          })
        ).agentId,
      ).toBeNull();
      expect(outcome).toBeInstanceOf(AppError);
      expect((outcome as AppError).statusCode).toBe(409);
      expect((outcome as AppError).translationKey).toBe(
        "errors.chatwootAccountDisconnected",
      );
    } finally {
      // Awaited before the cleanup either way: the bind is still holding a connection and would
      // otherwise write onto rows this is about to delete.
      await bind;
      await fx.cleanup();
    }
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

  // Two syncs of the SAME account, overlapping for real. The Channels page auto-syncs on load while
  // the operator can press the button, so this is the ordinary case rather than an exotic one, and a
  // `FOR UPDATE` on the inbox row cannot cover it: the row does not exist yet, and locking an absent
  // row locks nothing. The account row is the one lock both of them can take.
  test("two syncs racing on a first-time inbox record one creation, not two", async () => {
    await clearAudit();
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 1 },
      select: { id: true },
    });
    const deps = {
      makeClient: stubClient({
        listInboxes: async () => remoteInbox({ id: 88 }),
      }).makeClient,
    };
    await Promise.all([
      syncInboxes(ctx(), inst.id, deps, appDb),
      syncInboxes(ctx(), inst.id, deps, appDb),
    ]);
    const all = await rows();
    expect(all.map((r) => r.action)).toEqual(["instance.sync_inboxes"]);
    expect(all[0]?.after).toMatchObject({ created: 1, updated: 0 });
    await collect();
    await suDb.inbox.deleteMany({
      where: { chatwootInstanceId: inst.id, chatwootInboxId: 88 },
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

  // A LOCK-ORDER fence, and it is a source fence because the failure it guards has no green test:
  // two transactions that take the same two rows in opposite orders deadlock only when they
  // interleave, so a runtime test for it is a coin flip. `syncInboxes` takes the account row and
  // then the inboxes under it; `softDisconnectChatwootInstance` unbinds those inboxes and then
  // stamps the account, which is the same pair backwards, and both are ordinary operations (the
  // page auto-syncs when it opens and a disconnect is one click).
  test("every path that takes more than one of the three locks takes them outermost first", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/management.ts", import.meta.url),
    ).text();
    // Deployment, then the accounts under it, then their inboxes. One order for the whole module.
    const LEVELS: [string, RegExp][] = [
      ["deployment", /FROM chatwoot_deployments/],
      [
        "account",
        /FROM chatwoot_instances|db\.chatwootInstance\.(create|update|updateMany|delete|deleteMany)/,
      ],
      [
        "inbox",
        /db\.inbox\.(update|updateMany|upsert|delete|deleteMany)|(?:FROM|UPDATE) inboxes/,
      ],
    ];
    // Function bodies, split on the top-level declarations this file is written with.
    const parts = src.split(/\n(?=(?:export )?async function )/);
    let checked = 0;
    for (const body of parts) {
      const name = body.match(/async function (\w+)/)?.[1] ?? "?";
      const at = LEVELS.map(([, re]) => body.search(re)).map((i) =>
        i === -1 ? Number.POSITIVE_INFINITY : i,
      );
      // Only the levels this function actually takes, in level order: a path that never touches the
      // deployment is not out of order for starting at the account.
      const present = at.filter((i) => Number.isFinite(i));
      if (present.length < 2) continue;
      checked++;
      const ordered = present.every(
        (v, i) => i === 0 || (present[i - 1] as number) < v,
      );
      expect([name, ordered]).toEqual([name, true]);
    }
    // The fence is worthless if it matched nothing, which is how a refactor that renames the lock
    // turns it green forever.
    expect(checked).toBeGreaterThanOrEqual(3);
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
