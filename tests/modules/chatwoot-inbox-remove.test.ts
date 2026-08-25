import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
  ChatwootMissingTokenError,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import { remoteInboxIsGone, removeInbox } from "@/modules/chatwoot/management";
import { seedChatwootInstance } from "../utils/chatwoot";

// #307: an inbox deleted in Chatwoot leaves its mirror behind FOREVER. Sync deliberately never
// prunes (keeping a binding beats pruning one), and the explicit action that comment points at does
// not exist. The removal has to be fenced, and the fence is the whole design: the mirror row is
// recreated by `upsertInbox` for ANY inbox that sends traffic, so deleting the mirror of a LIVE
// inbox is not a removal at all — the next message rebuilds the row with no agent bound and the
// customer lands in `emitUnroutedMessage`. Only an inbox Chatwoot ANSWERS is gone may be removed.

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

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

// Personifies the fork's Api::V1::Accounts::InboxesController#show. `fetch_inbox` resolves it with
// `Current.account.inboxes.find(params[:id])` and only THEN runs `authorize @inbox, :show?`, so a
// missing inbox raises RecordNotFound before any policy check. Measured live against the fork
// (~/dev/chatwoot/main, 2026-08-25): live id → 200 with the inbox JSON, absent id → 404
// {"error":"Resource could not be found"}, no token → 401.
function fakeChatwoot(live: number[]) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path });
    const m = path.match(/\/inboxes\/(\d+)$/);
    if (m && !live.includes(Number(m[1]))) {
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ error: "Resource could not be found" }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: Number(m?.[1] ?? 0), name: "Acme Support" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const makeClient = (cfg: ConstructorParameters<typeof ChatwootClient>[0]) =>
    createChatwootClient(cfg, {
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
  return { calls, makeClient };
}

// The predicate that authorizes DESTROYING a row, so it is deliberately narrower than it looks: a
// table, because the DB test below can only reach the two answers the fake produces.
//
// This shares a body with `unbindNeedsNothingRemote` and is deliberately NOT the same function. That
// one asks "is there nothing left to disconnect?" about a POST to /set_agent_bot; this asks "did
// Chatwoot state this inbox does not exist?" about a GET on the inbox itself. They agree today
// because both routes resolve the inbox through the same `find`, and they would stop agreeing the
// moment either route's 404 semantics changed — at which point one of them must move without the
// other. A false answer here deletes an operator's row; there it only skips a call.
describe("remoteInboxIsGone", () => {
  const rows: Array<[string, unknown, boolean]> = [
    [
      "404: Chatwoot answered that the inbox is not there",
      new ChatwootApiError(404, "GET /inboxes/9"),
      true,
    ],
    [
      "200 never reaches the predicate, but a 2xx-shaped error must not pass",
      new ChatwootApiError(200, "GET /inboxes/9"),
      false,
    ],
    [
      "401: the credential is wrong; the inbox may be live",
      new ChatwootApiError(401, "GET /inboxes/9"),
      false,
    ],
    [
      "403: the inbox EXISTS and the policy refused it (fetch_inbox authorizes after find)",
      new ChatwootApiError(403, "GET /inboxes/9"),
      false,
    ],
    [
      "429: rate limited, no answer about the inbox",
      new ChatwootApiError(429, "GET /inboxes/9"),
      false,
    ],
    [
      "500: Chatwoot broke, it did not answer",
      new ChatwootApiError(500, "GET /inboxes/9"),
      false,
    ],
    [
      "502: the gateway answered, Chatwoot did not",
      new ChatwootApiError(502, "GET /inboxes/9"),
      false,
    ],
    [
      "nothing was sent at all",
      new ChatwootMissingTokenError("GET /inboxes/9"),
      false,
    ],
    ["a network error, not an answer", new TypeError("fetch failed"), false],
    ["a plain Error that merely says 404", new Error("404"), false],
    ["a look-alike that is not our error", { status: 404 }, false],
    ["undefined", undefined, false],
    ["null", null, false],
  ];
  for (const [label, err, expected] of rows) {
    test(`${expected ? "proves gone" : "proves nothing"} — ${label}`, () => {
      expect(remoteInboxIsGone(err)).toBe(expected);
    });
  }
});

describe.skipIf(!dbUp)("#307 removing the mirror of a deleted inbox", () => {
  let tenant = 0n;
  let other = 0n;
  let instanceId = 0n;
  let agentId = 0n;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "T307", slug: `t307-${process.pid}` },
      })
    ).id;
    other = (
      await suDb.tenant.create({
        data: { name: "T307b", slug: `t307b-${process.pid}` },
      })
    ).id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      baseUrl: "https://chat.307.test",
      accountId: 1,
      adminToken: encryptJson("admintok"),
    });
    instanceId = BigInt(inst.id);
    agentId = (
      await suDb.agent.create({
        data: { tenantId: tenant, name: "Sales307", systemPrompt: "x" },
      })
    ).id;
  });

  afterAll(async () => {
    for (const t of [tenant, other]) {
      if (!t) continue;
      for (const tbl of [
        "execution_logs",
        "llm_usage",
        "conversations",
        "chatwoot_agent_bots",
        "inboxes",
        "agents",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${t}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
    }
  });

  async function seedInbox(chatwootInboxId: number, bound = false) {
    return suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId,
        name: `Inbox ${chatwootInboxId}`,
        agentId: bound ? agentId : null,
      },
    });
  }

  const exists = async (id: bigint) =>
    (await suDb.inbox.count({ where: { id } })) === 1;

  test("the mirror goes when Chatwoot answers that the inbox is gone", async () => {
    const inbox = await seedInbox(7301, true);
    const cw = fakeChatwoot([]);
    await removeInbox(
      ctx(tenant),
      inbox.id,
      { makeClient: cw.makeClient },
      appDb,
    );
    expect(await exists(inbox.id)).toBe(false);
    // it PROVED absence before destroying, and it proved it by READING: a removal must never write
    // to Chatwoot, and there is nothing there to write to anyway.
    expect(cw.calls).toHaveLength(1);
    expect(cw.calls[0]?.method).toBe("GET");
    expect(cw.calls[0]?.path).toEndWith("/api/v1/accounts/1/inboxes/7301");
  });

  test("an inbox that still exists in Chatwoot is refused, and the row survives", async () => {
    const inbox = await seedInbox(7302, true);
    const cw = fakeChatwoot([7302]);
    await expect(
      removeInbox(ctx(tenant), inbox.id, { makeClient: cw.makeClient }, appDb),
    ).rejects.toThrow(/still exists in Chatwoot/i);
    expect(await exists(inbox.id)).toBe(true);
    const row = await suDb.inbox.findUniqueOrThrow({
      where: { id: inbox.id },
      select: { agentId: true },
    });
    expect(row.agentId).toBe(agentId);
  });

  test("a credential failure is not proof of absence", async () => {
    const inbox = await seedInbox(7303);
    const deps = {
      makeClient: async () =>
        ({
          getInbox: async () => {
            throw new ChatwootApiError(401, "GET /inboxes/7303");
          },
        }) as unknown as ChatwootClient,
    };
    await expect(
      removeInbox(ctx(tenant), inbox.id, deps, appDb),
    ).rejects.toThrow(/could not confirm with Chatwoot/i);
    expect(await exists(inbox.id)).toBe(true);
  });

  test("a network failure is not proof of absence", async () => {
    const inbox = await seedInbox(7304);
    const deps = {
      makeClient: async () =>
        ({
          getInbox: async () => {
            throw new TypeError("fetch failed");
          },
        }) as unknown as ChatwootClient,
    };
    await expect(
      removeInbox(ctx(tenant), inbox.id, deps, appDb),
    ).rejects.toThrow(/could not confirm with Chatwoot/i);
    expect(await exists(inbox.id)).toBe(true);
  });

  test("an inbox belonging to another tenant is not found, and no network is touched", async () => {
    const inbox = await seedInbox(7305);
    const cw = fakeChatwoot([]);
    await expect(
      removeInbox(ctx(other), inbox.id, { makeClient: cw.makeClient }, appDb),
    ).rejects.toThrow(/inbox not found/i);
    expect(await exists(inbox.id)).toBe(true);
    expect(cw.calls).toEqual([]);
  });

  test("the conversations survive the removal, holding no inbox", async () => {
    const inbox = await seedInbox(7306);
    const conv = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: 73_060,
        status: "resolved",
        threadId: `${tenant}:${instanceId}:73060`,
      },
    });
    const cw = fakeChatwoot([]);
    await removeInbox(
      ctx(tenant),
      inbox.id,
      { makeClient: cw.makeClient },
      appDb,
    );
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { inboxId: true },
    });
    expect(row.inboxId).toBeNull();
  });

  test("the spend and the log lines survive, still naming the inbox that is gone", async () => {
    const inbox = await seedInbox(7307);
    await suDb.llmUsage.create({
      data: {
        tenantId: tenant,
        inboxId: inbox.id,
        model: "gpt-5",
        promptTokens: 10,
        completionTokens: 5,
      },
    });
    await suDb.executionLog.create({
      data: {
        tenantId: tenant,
        turnId: "t-7307",
        inboxId: inbox.id,
        stage: "generate",
      },
    });
    const cw = fakeChatwoot([]);
    await removeInbox(
      ctx(tenant),
      inbox.id,
      { makeClient: cw.makeClient },
      appDb,
    );
    // NEITHER column is a foreign key (schema.prisma: bare BigInt on both), so history is kept and
    // its inbox id is left dangling BY DESIGN. The dashboard already renders that as an unnamed
    // bucket (analytics/service.ts resolves names with `?? null`), which is what the operator trades
    // for the removal. Asserting it here so a later cascade cannot delete an operator's spend record.
    expect(await suDb.llmUsage.count({ where: { inboxId: inbox.id } })).toBe(1);
    expect(
      await suDb.executionLog.count({
        // flowlog-scope: seeded — the subject is the ONE line this test wrote, addressed by an
        // inbox id no other test uses. There is no turn here: the question is whether removing an
        // inbox takes its log lines with it, which is about the row, not about a trail.
        where: { inboxId: inbox.id },
      }),
    ).toBe(1);
  });

  // The row is read, THEN the network is asked, so a second removal can land inside that window. It
  // must not answer a 500: both callers asked for the row to be gone and the row is gone.
  //
  // The window is opened DETERMINISTICALLY, from inside the probe, rather than by firing two real
  // removals and hoping the scheduler interleaves them. Two concurrent flows open four scoped
  // transactions between them, and under a contended pool the loser fails to start one at all — so
  // the concurrent version failed on CI for a reason that has nothing to do with the rule under test
  // (and would have passed locally forever). Injecting the interleaving at the seam asserts the
  // rule itself, and it is what mutating `deleteMany` back to `delete` still trips.
  test("a removal whose row vanished inside the probe window still succeeds", async () => {
    const inbox = await seedInbox(7308);
    const deps = {
      makeClient: async () =>
        ({
          getInbox: async () => {
            // another operator's removal lands while this one is asking Chatwoot
            await suDb.inbox.deleteMany({ where: { id: inbox.id } });
            throw new ChatwootApiError(404, "GET /inboxes/7308");
          },
        }) as unknown as ChatwootClient,
    };
    await removeInbox(ctx(tenant), inbox.id, deps, appDb);
    expect(await exists(inbox.id)).toBe(false);
  });

  test("an inbox that is not there answers 404, not a silent success", async () => {
    const cw = fakeChatwoot([]);
    await expect(
      removeInbox(
        ctx(tenant),
        99_999_307n,
        { makeClient: cw.makeClient },
        appDb,
      ),
    ).rejects.toThrow(/inbox not found/i);
    expect(cw.calls).toEqual([]);
  });
});
