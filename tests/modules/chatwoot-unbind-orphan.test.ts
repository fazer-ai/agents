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
import {
  bindInbox,
  unbindNeedsNothingRemote,
} from "@/modules/chatwoot/management";
import { seedChatwootInstance } from "../utils/chatwoot";

// #327: an inbox deleted in Chatwoot WHILE an agent was bound could never be unbound. The unbind
// calls set_agent_bot on an inbox that is gone, the call 404s, and the local write is fenced behind
// it — so `Inbox.agentId` keeps naming a persona for an inbox that no longer exists, with no way to
// correct it through the API. Retrying does not help: the failure is deterministic.

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

// Personifies the fork's Api::V1::Accounts::InboxesController (4.16.0). `set_agent_bot` is reached
// through a before_action that does `Current.account.inboxes.find(params[:id])`, so an inbox that is
// gone answers 404 with Rails' own body BEFORE any bot logic runs, and a live one answers `head :ok`
// (200, empty body). Both were measured against the local fork; see the PR body for the transcript.
function fakeChatwoot(live: number[]) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const m = path.match(/\/inboxes\/(\d+)\/set_agent_bot$/);
    if (m && !live.includes(Number(m[1]))) {
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ error: "Resource could not be found" }),
      } as unknown as Response;
    }
    if (path.endsWith("/agent_bots") && init?.method === "POST") {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 77, access_token: "tok-77", secret: "sec-77" }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const makeClient = (cfg: ConstructorParameters<typeof ChatwootClient>[0]) =>
    createChatwootClient(cfg, {
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
  return { calls, makeClient };
}

// The predicate that decides whether the unbind's remote half can be skipped. A table, because the
// DB test can only reach the two rows the fake produces.
describe("unbindNeedsNothingRemote", () => {
  const rows: Array<[string, unknown, boolean]> = [
    [
      "404: the inbox is not there to carry a bot",
      new ChatwootApiError(404, "POST /inboxes/9/set_agent_bot"),
      true,
    ],
    [
      "401: the credential is wrong, the inbox may be live",
      new ChatwootApiError(401, "POST /inboxes/9/set_agent_bot"),
      false,
    ],
    [
      "403: forbidden, says nothing about the inbox",
      new ChatwootApiError(403, "POST /inboxes/9/set_agent_bot"),
      false,
    ],
    [
      "422: Chatwoot refused the change",
      new ChatwootApiError(422, "POST /inboxes/9/set_agent_bot"),
      false,
    ],
    [
      "500: the bot may still be connected",
      new ChatwootApiError(500, "POST /inboxes/9/set_agent_bot"),
      false,
    ],
    [
      "502: gateway, nothing reached Chatwoot",
      new ChatwootApiError(502, "POST /inboxes/9/set_agent_bot"),
      false,
    ],
    [
      "nothing was sent at all",
      new ChatwootMissingTokenError("POST /inboxes/9/set_agent_bot"),
      false,
    ],
    ["a network error, not an answer", new TypeError("fetch failed"), false],
    ["a plain Error", new Error("404"), false],
    ["not an error at all", { status: 404 }, false],
    ["null", null, false],
  ];
  for (const [label, err, expected] of rows) {
    test(`${expected ? "skips" : "keeps"} the remote half — ${label}`, () => {
      expect(unbindNeedsNothingRemote(err)).toBe(expected);
    });
  }
});

describe.skipIf(!dbUp)("#327 unbinding an inbox deleted in Chatwoot", () => {
  let tenant = 0n;
  let instanceId = 0n;
  let agentId = 0n;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "T327", slug: `t327-${process.pid}` },
      })
    ).id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      baseUrl: "https://chat.327.test",
      accountId: 1,
      adminToken: encryptJson("admintok"),
    });
    instanceId = BigInt(inst.id);
    agentId = (
      await suDb.agent.create({
        data: { tenantId: tenant, name: "Sales327", systemPrompt: "x" },
      })
    ).id;
  });

  afterAll(async () => {
    if (!tenant) return;
    for (const tbl of [
      "chatwoot_agent_bots",
      "inboxes",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${tbl} WHERE tenant_id = ${tenant}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
  });

  // Seeds an inbox already bound to the agent (the state an operator is in when the inbox is
  // deleted upstream), with a provisioned bot so the unbind path needs no network to reach.
  async function seedBoundInbox(chatwootInboxId: number) {
    return suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId,
        name: `Inbox ${chatwootInboxId}`,
        agentId,
      },
    });
  }

  test("the binding clears when the inbox is gone upstream", async () => {
    const inbox = await seedBoundInbox(9327);
    const cw = fakeChatwoot([]); // inbox 9327 was deleted: nothing is live
    const dto = await bindInbox(
      ctx(tenant),
      inbox.id,
      null,
      { makeClient: cw.makeClient },
      appDb,
    );
    expect(dto.agentId).toBeNull();
    // the row an operator reads no longer names a persona for an inbox that does not exist
    const row = await suDb.inbox.findUniqueOrThrow({
      where: { id: inbox.id },
      select: { agentId: true },
    });
    expect(row.agentId).toBeNull();
    // and it did try the remote half first — the 404 is an answer, not a reason to skip the call
    // (the seeded base URL carries a per-run path namespace, so match the account-scoped suffix)
    expect(cw.calls).toHaveLength(1);
    expect(cw.calls[0]?.path).toEndWith(
      "/api/v1/accounts/1/inboxes/9327/set_agent_bot",
    );
    expect(cw.calls[0]?.body).toEqual({ agent_bot: null });
  });

  test("a live inbox still unbinds through the remote call", async () => {
    const inbox = await seedBoundInbox(9328);
    const cw = fakeChatwoot([9328]);
    const dto = await bindInbox(
      ctx(tenant),
      inbox.id,
      null,
      { makeClient: cw.makeClient },
      appDb,
    );
    expect(dto.agentId).toBeNull();
    expect(cw.calls[0]?.body).toEqual({ agent_bot: null });
  });

  test("the fence still holds for a failure that is not a 404", async () => {
    const inbox = await seedBoundInbox(9329);
    const cw = {
      makeClient: async () =>
        ({
          setInboxAgentBot: async () => {
            throw new ChatwootApiError(500, "POST /inboxes/9329/set_agent_bot");
          },
        }) as unknown as ChatwootClient,
    };
    await expect(
      bindInbox(ctx(tenant), inbox.id, null, cw, appDb),
    ).rejects.toThrow("could not sync the bot with Chatwoot");
    // the binding is KEPT: a bot may still be connected on the Chatwoot side
    const row = await suDb.inbox.findUniqueOrThrow({
      where: { id: inbox.id },
      select: { agentId: true },
    });
    expect(row.agentId).toBe(agentId);
  });

  test("binding to an inbox that is gone still fails, and persists nothing", async () => {
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 9330,
        name: "Inbox 9330",
      },
    });
    const cw = fakeChatwoot([]);
    await expect(
      bindInbox(
        ctx(tenant),
        inbox.id,
        agentId,
        { makeClient: cw.makeClient },
        appDb,
      ),
    ).rejects.toThrow("could not sync the bot with Chatwoot");
    const row = await suDb.inbox.findUniqueOrThrow({
      where: { id: inbox.id },
      select: { agentId: true },
    });
    expect(row.agentId).toBeNull();
  });

  test("an orphan with no agent bound never reaches the network", async () => {
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 9331,
        name: "Inbox 9331",
      },
    });
    const cw = fakeChatwoot([]);
    const dto = await bindInbox(
      ctx(tenant),
      inbox.id,
      null,
      { makeClient: cw.makeClient },
      appDb,
    );
    expect(dto.agentId).toBeNull();
    expect(cw.calls).toEqual([]);
  });
});
