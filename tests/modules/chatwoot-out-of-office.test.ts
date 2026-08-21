import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { listOutOfOfficeInboxes } from "@/modules/chatwoot/management";
import { chatwootAutoRepliesOutOfHours } from "@/modules/chatwoot/out-of-office";

// Issue #166. Two products can both answer out of hours on the same inbox, on schedules neither can
// see, and until this reading existed nothing in either console said so.

// ── the rule, as a table ──
//
// Written out rather than derived from the Ruby: the point of a mirrored rule is that it can be
// compared against its source by eye. `present?` is the half that surprises — Rails treats a
// whitespace-only string as blank, so a message field holding a space is configured in Chatwoot's
// console and dead in its runtime.
describe("chatwootAutoRepliesOutOfHours", () => {
  const CASES: Array<[boolean, string | null, boolean]> = [
    // workingHoursEnabled, outOfOfficeMessage, replies?
    [true, "Estamos fechados.", true],
    [true, "", false],
    [true, "   ", false],
    [true, null, false],
    [false, "Estamos fechados.", false],
    [false, "", false],
    [false, null, false],
  ];
  for (const [workingHoursEnabled, outOfOfficeMessage, expected] of CASES) {
    test(`hours=${workingHoursEnabled} message=${JSON.stringify(outOfOfficeMessage)} → ${expected}`, () => {
      expect(
        chatwootAutoRepliesOutOfHours({
          workingHoursEnabled,
          outOfOfficeMessage,
        }),
      ).toBe(expected);
    });
  }
});

// ── the reading, against a real database ──

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

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

const SLUG = `oooff-${process.pid}`;

let tenantA = 0n;
let tenantB = 0n;
let instance1 = 0n;
let instance2 = 0n;
let agent1 = 0n;
let agent2 = 0n;
let agentB = 0n;
// Mirror ids, so the assertions can name the rows rather than the order they came back in.
let ib1 = 0n;
let ib4 = 0n;

// What Chatwoot answers for each account. `1` has four inboxes; `2` has one. Both carry an inbox the
// mirror does not know about, which is the direction that must never widen the result.
const ACCOUNT_1 = {
  payload: [
    {
      id: 101,
      name: "WhatsApp Vendas (Chatwoot)",
      working_hours_enabled: true,
      out_of_office_message: "Estamos fechados.",
    },
    // Working hours on, no message: Chatwoot sends nothing, so neither do we.
    {
      id: 102,
      name: "WhatsApp Suporte",
      working_hours_enabled: true,
      out_of_office_message: "",
    },
    // Armed, but bound to the OTHER agent.
    {
      id: 103,
      name: "Site",
      working_hours_enabled: true,
      out_of_office_message: "Fechado.",
    },
    // Armed, and not in the mirror at all.
    {
      id: 199,
      name: "Never synced",
      working_hours_enabled: true,
      out_of_office_message: "Fechado.",
    },
  ],
};
const ACCOUNT_2 = {
  payload: [
    {
      id: 201,
      name: "Instagram (Chatwoot)",
      working_hours_enabled: true,
      out_of_office_message: "Fechado.",
    },
  ],
};

// Counts the list calls so "one per ACCOUNT, not one per inbox" is an assertion and not a hope: an
// agent bound to four inboxes of one account must cost one round trip.
function fakeChatwoot(byAccount: Record<number, unknown>) {
  const calls: number[] = [];
  const makeClient = async (cfg: { accountId: number }) => {
    const payload = byAccount[cfg.accountId];
    return {
      listInboxes: async () => {
        calls.push(cfg.accountId);
        if (payload === undefined) throw new Error("chatwoot unreachable");
        return payload;
      },
    } as unknown as ChatwootClient;
  };
  return { makeClient, calls };
}

describe.skipIf(!dbUp)("listOutOfOfficeInboxes", () => {
  beforeAll(async () => {
    const tA = await suDb.tenant.create({
      data: { name: `${SLUG}-a`, slug: `${SLUG}-a` },
    });
    const tB = await suDb.tenant.create({
      data: { name: `${SLUG}-b`, slug: `${SLUG}-b` },
    });
    tenantA = tA.id;
    tenantB = tB.id;

    // A real encrypted token, because loadChatwootClient decrypts BEFORE it reaches the injected
    // factory: a placeholder would throw there, land in the catch that swallows an unreachable
    // account, and every assertion below would pass on an empty list for the wrong reason.
    const depA = await suDb.chatwootDeployment.create({
      data: {
        tenantId: tenantA,
        baseUrl: `https://cw-${SLUG}.test.local`,
        adminToken: encryptJson("ADMIN"),
      },
    });
    const depB = await suDb.chatwootDeployment.create({
      data: {
        tenantId: tenantB,
        baseUrl: `https://cw-${SLUG}-b.test.local`,
        adminToken: encryptJson("ADMIN"),
      },
    });
    const i1 = await suDb.chatwootInstance.create({
      data: {
        tenantId: tenantA,
        deploymentId: depA.id,
        accountId: 1,
        serverKey: `cw-${SLUG}.test.local`,
      },
    });
    const i2 = await suDb.chatwootInstance.create({
      data: {
        tenantId: tenantA,
        deploymentId: depA.id,
        accountId: 2,
        serverKey: `cw-${SLUG}.test.local`,
      },
    });
    const iB = await suDb.chatwootInstance.create({
      data: {
        tenantId: tenantB,
        deploymentId: depB.id,
        accountId: 1,
        serverKey: `cw-${SLUG}-b.test.local`,
      },
    });
    instance1 = i1.id;
    instance2 = i2.id;

    const mkAgent = async (tenantId: bigint, name: string) =>
      (await suDb.agent.create({ data: { tenantId, name, systemPrompt: "x" } }))
        .id;
    agent1 = await mkAgent(tenantA, `${SLUG}-1`);
    agent2 = await mkAgent(tenantA, `${SLUG}-2`);
    agentB = await mkAgent(tenantB, `${SLUG}-b`);

    const mkInbox = async (args: {
      tenantId: bigint;
      chatwootInstanceId: bigint;
      chatwootInboxId: number;
      name: string;
      agentId: bigint | null;
    }) => (await suDb.inbox.create({ data: args })).id;

    // The mirror's name is deliberately NOT Chatwoot's: the reading is live, and the inbox the
    // operator has to open is the one named on the other side.
    ib1 = await mkInbox({
      tenantId: tenantA,
      chatwootInstanceId: instance1,
      chatwootInboxId: 101,
      name: "WhatsApp Vendas (stale mirror name)",
      agentId: agent1,
    });
    await mkInbox({
      tenantId: tenantA,
      chatwootInstanceId: instance1,
      chatwootInboxId: 102,
      name: "WhatsApp Suporte",
      agentId: agent1,
    });
    await mkInbox({
      tenantId: tenantA,
      chatwootInstanceId: instance1,
      chatwootInboxId: 103,
      name: "Site",
      agentId: agent2,
    });
    // Bound, armed, and on an account the fake refuses to answer for in one of the tests.
    ib4 = await mkInbox({
      tenantId: tenantA,
      chatwootInstanceId: instance2,
      chatwootInboxId: 201,
      name: "Instagram",
      agentId: agent1,
    });
    // Same agent id would be a cross-tenant hit if the read were not scoped.
    await mkInbox({
      tenantId: tenantB,
      chatwootInstanceId: iB.id,
      chatwootInboxId: 101,
      name: "Outro tenant",
      agentId: agentB,
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const t of [tenantA, tenantB]) {
      if (t) await suDb.tenant.delete({ where: { id: t } }).catch(() => {});
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("names the bound inboxes Chatwoot answers for, by CHATWOOT's name", async () => {
    const { makeClient, calls } = fakeChatwoot({ 1: ACCOUNT_1, 2: ACCOUNT_2 });
    const found = await listOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(found).toEqual([
      { id: String(ib1), name: "WhatsApp Vendas (Chatwoot)" },
      { id: String(ib4), name: "Instagram (Chatwoot)" },
    ]);
    // One call per ACCOUNT: three of this agent's inboxes live on account 1.
    expect(calls.sort()).toEqual([1, 2]);
  });

  test("the other agent's inbox is its own, even on the same account", async () => {
    const { makeClient } = fakeChatwoot({ 1: ACCOUNT_1, 2: ACCOUNT_2 });
    const found = await listOutOfOfficeInboxes(
      ctx(tenantA),
      agent2,
      { makeClient },
      appDb,
    );
    expect(found.map((f) => f.name)).toEqual(["Site"]);
  });

  test("an account that cannot be read says nothing, and does not sink the others", async () => {
    // Account 2 has no payload → its listInboxes throws.
    const { makeClient, calls } = fakeChatwoot({ 1: ACCOUNT_1 });
    const found = await listOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(found).toEqual([
      { id: String(ib1), name: "WhatsApp Vendas (Chatwoot)" },
    ]);
    expect(calls.sort()).toEqual([1, 2]);
  });

  // Review round 1. Every Chatwoot request carries a 15s abort, so reading the accounts one after the
  // other makes an unreachable server cost 15s PER ACCOUNT on a request the editor fires on load.
  //
  // Proved by deadlock, and by a rendezvous both sides announce: each account's list call publishes
  // its own start and then waits for the other's, so a serial drain hangs whichever account it picks
  // first. A one-sided version (only account 2 waits) would pass on a serial implementation that
  // happened to read account 1 first, which is the shape of a temporal test that never goes red.
  test("the accounts are read concurrently, not one timeout after another", async () => {
    const arrive: Record<number, () => void> = {};
    const started = new Map<number, Promise<void>>();
    for (const id of [1, 2]) {
      started.set(
        id,
        new Promise<void>((resolve) => {
          arrive[id] = resolve;
        }),
      );
    }
    const makeClient = async (cfg: { accountId: number }) =>
      ({
        listInboxes: async () => {
          arrive[cfg.accountId]?.();
          await started.get(cfg.accountId === 1 ? 2 : 1);
          return cfg.accountId === 1 ? ACCOUNT_1 : ACCOUNT_2;
        },
      }) as unknown as ChatwootClient;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        listOutOfOfficeInboxes(ctx(tenantA), agent1, { makeClient }, appDb),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("serial: the second account never got to start"),
              ),
            5_000,
          );
        }),
      ]);
      expect(found.map((f) => f.name)).toEqual([
        "WhatsApp Vendas (Chatwoot)",
        "Instagram (Chatwoot)",
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  test("an agent with no bound inbox costs no call at all", async () => {
    const lonely = (
      await suDb.agent.create({
        data: { tenantId: tenantA, name: `${SLUG}-lonely`, systemPrompt: "x" },
      })
    ).id;
    const { makeClient, calls } = fakeChatwoot({ 1: ACCOUNT_1, 2: ACCOUNT_2 });
    expect(
      await listOutOfOfficeInboxes(ctx(tenantA), lonely, { makeClient }, appDb),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });

  // The whole chain refuses another tenant's agent, and this test cannot say WHICH link refused —
  // measured, not assumed: swapping the scoped read for a super-admin one leaves all twelve tests
  // green. The rows come back, and `loadChatwootClient` then does its own scoped read of the
  // instance and throws, which lands in the catch that already exists for an unreachable account.
  // So the scope on the bound-inbox read is the first of two fences and the second is load-bearing
  // today. It stays because it is the read that hands rows to the caller, and because a fence whose
  // only guarantee is a downstream detail is one refactor away from not being a fence at all.
  test("another tenant's context sees nothing, agent id or not", async () => {
    const { makeClient, calls } = fakeChatwoot({ 1: ACCOUNT_1, 2: ACCOUNT_2 });
    expect(
      await listOutOfOfficeInboxes(ctx(tenantB), agent1, { makeClient }, appDb),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});
