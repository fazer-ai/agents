import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  listOutOfOfficeInboxes,
  readOutOfOfficeInboxes,
} from "@/modules/chatwoot/management";
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
  // COUNTED PER BOUND INBOX, not per account, which is the unit the answer is about: the caller asks
  // "did you read the out-of-hours state of this agent's inboxes", and an account is only the place
  // that state comes from. Every case below reports how many of THIS AGENT's inboxes went unread.
  //
  // A 200 whose body is not a list. `parseInboxList` answers that with an empty array on purpose —
  // a shape change must never invent an inbox — and for a caller that REPORTS ITS OWN COVERAGE that
  // default is indistinguishable from an account where nothing is armed.
  test("a body that is not a list leaves that account's inboxes unread", async () => {
    const { makeClient } = fakeChatwoot({
      1: { unexpected: "shape" },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    // Both of this agent's inboxes on account 1; the account said nothing usable about either.
    expect(read.unreadable).toBe(2);
    // And the account that DID answer is still reported: one unreadable server must not decide for
    // the others.
    expect(read.inboxes.length).toBeGreaterThan(0);
  });

  // An entry with no id cannot be matched to a bound inbox at all, so the inboxes it should have
  // described stay unread — while everything the same payload DID describe is still used. That last
  // half is the part an account-wide verdict got wrong: it threw away the readable entries too.
  test("an unreadable entry costs its own inbox, not the account", async () => {
    const { makeClient } = fakeChatwoot({
      1: {
        payload: [
          { name: "no id at all" },
          {
            id: 101,
            name: "WhatsApp Vendas (Chatwoot)",
            working_hours_enabled: true,
            out_of_office_message: "Estamos fechados.",
          },
        ],
      },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    // Inbox 101 was described and IS armed, so it is still reported…
    expect(read.inboxes.map((i) => i.name)).toContain(
      "WhatsApp Vendas (Chatwoot)",
    );
    // …and the bound inbox nothing described is the one that counts as unread.
    expect(read.unreadable).toBe(1);
  });

  // The field half of the same question: an id that parses, with a switch that does not. The parser
  // defaults it to off, which reads as "this inbox answers nothing" — a conclusion nobody may draw
  // from a value they could not read.
  test("an inbox whose out-of-hours fields are unreadable is unread", async () => {
    const { makeClient } = fakeChatwoot({
      1: {
        payload: [
          { id: 101, name: "Vendas", working_hours_enabled: "yes" },
          {
            id: 102,
            name: "WhatsApp Suporte",
            working_hours_enabled: true,
            out_of_office_message: "",
          },
        ],
      },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(read.unreadable).toBe(1);
    // 102 was read and is NOT armed (working hours on, empty message), which is a real answer.
    expect(read.inboxes.map((i) => i.name)).not.toContain("WhatsApp Suporte");
  });

  // The switch alone, with a perfectly good message beside it. Measured: without this case the
  // switch check can be deleted and every other test stays green, because the message check catches
  // the truthy-non-boolean spellings — this is the one that only the switch check sees.
  test("an unreadable switch is unread even when the message is fine", async () => {
    const { makeClient } = fakeChatwoot({
      1: {
        payload: [
          {
            id: 101,
            name: "Vendas",
            working_hours_enabled: "no",
            out_of_office_message: "Estamos fechados.",
          },
          {
            id: 102,
            name: "WhatsApp Suporte",
            working_hours_enabled: true,
            out_of_office_message: "",
          },
        ],
      },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(read.unreadable).toBe(1);
  });

  // An explicit null is the ordinary state of an inbox nobody wrote copy for — the column is
  // nullable and null is its default (measured: six of six inboxes on the local fork). Treating it
  // as unread would fill `unchecked` on almost every real install, which is how a field like this
  // stops being read.
  test("working hours on with a null message is read, not unread", async () => {
    const { makeClient } = fakeChatwoot({
      1: {
        payload: [
          {
            id: 101,
            name: "Vendas",
            working_hours_enabled: true,
            out_of_office_message: null,
          },
          {
            id: 102,
            name: "WhatsApp Suporte",
            working_hours_enabled: true,
            out_of_office_message: "",
          },
        ],
      },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(read.unreadable).toBe(0);
    // And it is read as NOT arming a reply, which is what a null message means.
    expect(read.inboxes.map((i) => i.name)).not.toContain("Vendas");
  });

  // The key ABSENT is still unreadable: nothing said anything about this inbox's copy.
  test("working hours on with no message key at all is unread", async () => {
    const { makeClient } = fakeChatwoot({
      1: {
        payload: [
          { id: 101, name: "Vendas", working_hours_enabled: true },
          {
            id: 102,
            name: "WhatsApp Suporte",
            working_hours_enabled: true,
            out_of_office_message: "",
          },
        ],
      },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(read.unreadable).toBe(1);
  });

  // The switch is on and the message is not a string: same conclusion, other field.
  test("an armed inbox with an unreadable message is unread too", async () => {
    const { makeClient } = fakeChatwoot({
      1: {
        payload: [
          {
            id: 101,
            name: "Vendas",
            working_hours_enabled: true,
            out_of_office_message: { pt: "Fechado" },
          },
          {
            id: 102,
            name: "WhatsApp Suporte",
            working_hours_enabled: true,
            out_of_office_message: "",
          },
        ],
      },
      2: ACCOUNT_2,
    });
    const read = await readOutOfOfficeInboxes(
      ctx(tenantA),
      agent1,
      { makeClient },
      appDb,
    );
    expect(read.unreadable).toBe(1);
  });

  test("another tenant's context sees nothing, agent id or not", async () => {
    const { makeClient, calls } = fakeChatwoot({ 1: ACCOUNT_1, 2: ACCOUNT_2 });
    expect(
      await listOutOfOfficeInboxes(ctx(tenantB), agent1, { makeClient }, appDb),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});
