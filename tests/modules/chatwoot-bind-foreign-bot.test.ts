import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  type ChatwootClient,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import { bindInbox } from "@/modules/chatwoot/management";
import { inboxBind } from "@/modules/mcp/write-channels";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// Binding an agent to an inbox replaces the Agent Bot attached there (`set_agent_bot`), and
// unbinding later sends `agent_bot: null`. A bot from another vendor would be dropped without a word,
// so the bind reads the attached bot first and refuses, naming it, until the caller confirms.

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

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

const FOREIGN_BOT = 555;
const OUR_OTHER_BOT = 88;
const CREATED_BOT = 77;

// Personifies the fork's InboxesController and AgentBotsController: `GET /inboxes/:id/agent_bot`
// renders `{ agent_bot: {...} }`, `{}` inside when no bot is attached; `GET /agent_bots` lists the
// account's bots; `POST /agent_bots` creates one with its token; `set_agent_bot` answers `head :ok`.
// `attached: null` answers `{}`, as the fork does for an inbox with no bot (Jbuilder drops the empty
// key). `attached: "fail"` makes the read answer 500; `"no-route"` answers a body that is not an
// object; `"route-404"` answers the read 404 while the inbox itself
// still answers, as a proxy without the route would.
function fakeChatwoot(
  attached: number | null | "fail" | "no-route" | "route-404",
  names: string[] = [],
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const json = (status: number, body: unknown) =>
    ({
      ok: status < 400,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    }) as unknown as Response;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    if (/\/inboxes\/\d+\/agent_bot$/.test(path) && method === "GET") {
      if (attached === "fail") return json(500, { error: "boom" });
      if (attached === "no-route") return json(200, "<html>");
      if (attached === "route-404") return json(404, { error: "not found" });
      return json(200, {
        ...(attached === null
          ? {}
          : { agent_bot: { id: attached, name: "x" } }),
      });
    }
    if (path.endsWith("/agent_bots") && method === "GET") {
      return json(200, [
        { id: FOREIGN_BOT, name: names[0] ?? "Menu antigo" },
        { id: OUR_OTHER_BOT, name: "Outro" },
      ]);
    }
    if (path.endsWith("/agent_bots") && method === "POST") {
      return json(200, {
        id: CREATED_BOT,
        access_token: "tok-77",
        secret: "sec-77",
      });
    }
    return json(200, undefined);
  }) as unknown as typeof fetch;
  const makeClient = (cfg: ConstructorParameters<typeof ChatwootClient>[0]) =>
    createChatwootClient(cfg, {
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
  const sets = () => calls.filter((c) => c.path.endsWith("/set_agent_bot"));
  return { calls, makeClient, sets };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!dbUp)(
  "binding an inbox that another vendor's bot answers",
  () => {
    let tenant = 0n;
    let instanceId = 0n;
    let agentId = 0n;
    let otherAgentId = 0n;
    let nextInbox = 24300;

    beforeAll(async () => {
      tenant = (
        await suDb.tenant.create({
          data: { name: "T243", slug: `t243-${process.pid}` },
        })
      ).id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId: tenant,
        baseUrl: "https://chat.243.test",
        accountId: 2,
        adminToken: encryptJson("admintok"),
      });
      instanceId = BigInt(inst.id);
      agentId = (
        await suDb.agent.create({
          data: { tenantId: tenant, name: "Sales243", systemPrompt: "x" },
        })
      ).id;
      otherAgentId = (
        await suDb.agent.create({
          data: { tenantId: tenant, name: "Support243", systemPrompt: "x" },
        })
      ).id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          agentId: otherAgentId,
          chatwootAgentBotId: OUR_OTHER_BOT,
          accessToken: encryptJson("tok-88"),
          webhookSecret: encryptJson("sec-88"),
          webhookRouteTokenHash: `hash-243-${process.pid}`,
          name: "Support243",
        },
      });
    });

    afterAll(async () => {
      if (!tenant) return;
      for (const tbl of [
        "audit_logs",
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

    async function seedInbox(boundTo: bigint | null = null) {
      nextInbox += 1;
      return suDb.inbox.create({
        data: {
          tenantId: tenant,
          chatwootInstanceId: instanceId,
          chatwootInboxId: nextInbox,
          name: `Inbox ${nextInbox}`,
          agentId: boundTo,
        },
      });
    }

    async function boundAgent(inboxId: bigint) {
      return (
        await suDb.inbox.findUniqueOrThrow({
          where: { id: inboxId },
          select: { agentId: true },
        })
      ).agentId;
    }

    test("refuses, naming the bot, and leaves Chatwoot and the binding untouched", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot(FOREIGN_BOT);
      const err = await refusal(
        bindInbox(
          ctx(tenant),
          inbox.id,
          agentId,
          { makeClient: cw.makeClient },
          appDb,
        ),
      );
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(409);
      expect(err.translationKey).toBe("errors.inboxHasForeignAgentBot");
      expect(err.translationParams).toEqual({ bot: "Menu antigo" });
      expect(err.field).toBe("replaceForeignBot");
      expect(cw.sets()).toHaveLength(0);
      expect(await boundAgent(inbox.id)).toBeNull();
    });

    test("replaces it once the caller confirms", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot(FOREIGN_BOT);
      const dto = await bindInbox(
        ctx(tenant),
        inbox.id,
        agentId,
        { makeClient: cw.makeClient },
        appDb,
        { replaceForeignBot: true },
      );
      expect(dto.agentId).toBe(String(agentId));
      expect(cw.sets().at(-1)?.body).toEqual({ agent_bot: CREATED_BOT });
    });

    test("a bot named like one of our agents is still another vendor's", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot(FOREIGN_BOT, ["Sales243"]);
      const err = await refusal(
        bindInbox(
          ctx(tenant),
          inbox.id,
          agentId,
          { makeClient: cw.makeClient },
          appDb,
        ),
      );
      expect(err.translationKey).toBe("errors.inboxHasForeignAgentBot");
      expect(cw.sets()).toHaveLength(0);
    });

    test("an inbox with no bot binds without asking", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot(null);
      const dto = await bindInbox(
        ctx(tenant),
        inbox.id,
        agentId,
        { makeClient: cw.makeClient },
        appDb,
      );
      expect(dto.agentId).toBe(String(agentId));
      expect(cw.sets()).toHaveLength(1);
    });

    test("an inbox answered by another of our agents' bots binds without asking", async () => {
      const inbox = await seedInbox(otherAgentId);
      const cw = fakeChatwoot(OUR_OTHER_BOT);
      const dto = await bindInbox(
        ctx(tenant),
        inbox.id,
        agentId,
        { makeClient: cw.makeClient },
        appDb,
      );
      expect(dto.agentId).toBe(String(agentId));
    });

    test("a read that fails refuses as unreadable, never as an empty inbox", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot("fail");
      const err = await refusal(
        bindInbox(
          ctx(tenant),
          inbox.id,
          agentId,
          { makeClient: cw.makeClient },
          appDb,
        ),
      );
      expect(err.statusCode).toBe(409);
      expect(err.translationKey).toBe("errors.inboxAgentBotUnreadable");
      expect(err.field).toBe("replaceForeignBot");
      expect(cw.sets()).toHaveLength(0);
    });

    test("an answer that is not an object is unreadable too, not an empty inbox", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot("no-route");
      const err = await refusal(
        bindInbox(
          ctx(tenant),
          inbox.id,
          agentId,
          { makeClient: cw.makeClient },
          appDb,
        ),
      );
      expect(err.translationKey).toBe("errors.inboxAgentBotUnreadable");
      expect(cw.sets()).toHaveLength(0);
    });

    test("a read that answers 404 for an inbox that still exists is unreadable, not a gone inbox", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot("route-404");
      const err = await refusal(
        bindInbox(
          ctx(tenant),
          inbox.id,
          agentId,
          { makeClient: cw.makeClient },
          appDb,
        ),
      );
      expect(err.translationKey).toBe("errors.inboxAgentBotUnreadable");
      expect(cw.sets()).toHaveLength(0);
    });

    test("the MCP preview names the bot, and the apply needs replace_foreign_bot", async () => {
      const inbox = await seedInbox();
      const cw = fakeChatwoot(FOREIGN_BOT);
      const principal = {
        userId: 1n,
        tenantId: tenant,
        role: "TENANT_ADMIN" as const,
        scopes: ["mcp:read", "mcp:write", "mcp:admin"],
        clientId: "c",
        jti: "j",
      };
      const args = { inbox_id: String(inbox.id), agent_id: String(agentId) };
      const deps = { base: appDb, makeClient: cw.makeClient };

      const preview = await inboxBind(principal, args, deps);
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(preview.data.currentAgentBot).toEqual({
          kind: "foreign",
          botId: FOREIGN_BOT,
          botName: "Menu antigo",
        });
        expect(preview.data.requiresReplaceForeignBot).toBe(true);
        expect(preview.data.warning).toContain('"Menu antigo"');
      }

      const refused = await inboxBind(
        principal,
        { ...args, dry_run: false },
        deps,
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toContain("Menu antigo");
      expect(cw.sets()).toHaveLength(0);

      const applied = await inboxBind(
        principal,
        { ...args, dry_run: false, replace_foreign_bot: true },
        deps,
      );
      expect(applied.ok).toBe(true);
      expect(cw.sets().at(-1)?.body).toEqual({ agent_bot: CREATED_BOT });
    });
  },
);
