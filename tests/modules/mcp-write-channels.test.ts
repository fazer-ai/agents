import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  disconnectChatwootDeployment,
  reconnectChatwootInstance,
  softDisconnectChatwootInstance,
} from "@/modules/chatwoot/management";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  deploymentConnect,
  deploymentSetAccounts,
  inboxBind,
  inboxRemove,
  instanceDisconnect,
} from "@/modules/mcp/write-channels";
import { seedChatwootInstance } from "../utils/chatwoot";

// A Chatwoot that answers the inbox-detail GET the way the fork does: 404 for an inbox that is not
// there, 200 for one that is. `inbox_remove` is the one write whose PREVIEW asks, so the seam has to
// reach the dry run and not only the apply.
function fakeChatwoot(live: number[]) {
  const calls: number[] = [];
  return {
    calls,
    makeClient: async () =>
      ({
        getInbox: async (id: number) => {
          calls.push(id);
          if (!live.includes(id)) {
            throw new ChatwootApiError(404, `GET /inboxes/${id}`);
          }
          return { id };
        },
      }) as unknown as ChatwootClient,
  };
}

// Deployment + account + inbox write tools: gate is DB-free; dry-run, secret-by-reference and DB-only
// apply paths (disconnect) need a real Postgres (skipIf). Network actions (connect probe, set-accounts
// sync, bind apply, reconnect, reconcile) are exercised against the live Chatwoot in Fase 8.

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP channels gate (no DB)", () => {
  test("deployment_connect without mcp:admin → insufficient_scope", async () => {
    // Server/account management is admin-only: a tenant-admin (mcp:write) token is NOT enough.
    const r = await deploymentConnect(
      principal({ scopes: ["mcp:read", "mcp:write"] }),
      {
        base_url: "https://chat.example.com",
        admin_token: "x",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("deployment_connect with empty admin_token → error", async () => {
    const r = await deploymentConnect(principal({}), {
      base_url: "https://chat.example.com",
      admin_token: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("admin_token is required");
  });

  test("deployment_connect dry-run previews without echoing the token", async () => {
    const r = await deploymentConnect(principal({}), {
      base_url: "https://chat.example.com",
      admin_token: "raw-secret-xyz",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      // The raw token is never echoed back, not even in the preview.
      expect(JSON.stringify(r.data)).not.toContain("raw-secret-xyz");
    }
  });

  test("deployment_set_accounts without mcp:admin → insufficient_scope", async () => {
    const r = await deploymentSetAccounts(
      principal({ scopes: ["mcp:read", "mcp:write"] }),
      {
        account_ids: [1, 2],
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("instance_disconnect invalid id → error", async () => {
    const r = await instanceDisconnect(principal({}), { instance_id: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid instance_id");
  });
});

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

describe.skipIf(!dbUp)("MCP channel tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let instanceA = 0n;
  let inboxA = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "CA", slug: `c-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "CB", slug: `c-b-${process.pid}` },
    });
    tenantB = b.id;
    await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "cw-admin",
        kind: "generic",
        secret: encryptJson("cw-token"),
      },
    });
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      baseUrl: "https://chat.example.com",
      accountId: 3,
      adminToken: encryptJson("cw-token"),
    });
    instanceA = inst.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: instanceA,
        chatwootInboxId: 11,
        name: "WhatsApp",
      },
    });
    inboxA = inbox.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM inboxes WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("deployment_connect dry-run with a raw token previews, creates nothing", async () => {
    const r = await deploymentConnect(
      principal({ tenantId: tenantA }),
      {
        base_url: "https://new.example.com",
        admin_token: "cw-token",
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      // The preview never echoes the raw token value.
      expect(JSON.stringify(r.data)).not.toContain("cw-token");
    }
    // No deployment is created for the previewed base URL (the dry-run touches no DB).
    const count = await suDb.chatwootDeployment.count({
      where: { tenantId: tenantA, baseUrl: "https://new.example.com" },
    });
    expect(count).toBe(0);
  });

  test("inbox_remove dry-run asks Chatwoot and removes nothing", async () => {
    const cw = fakeChatwoot([]);
    const r = await inboxRemove(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inboxA) },
      { base: appDb, makeClient: cw.makeClient },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.goneFromChatwoot).toBe(true);
    }
    // It ASKED, and it asked about the Chatwoot id rather than our row id.
    expect(cw.calls).toEqual([11]);
    expect(await suDb.inbox.count({ where: { id: inboxA } })).toBe(1);
  });

  // The reason the preview calls Chatwoot at all: without it this dry run would report a removal
  // that the apply refuses, which is the shape of defect issue #248 removed one layer up.
  test("inbox_remove dry-run says so when the inbox is still live", async () => {
    const cw = fakeChatwoot([11]);
    const r = await inboxRemove(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inboxA) },
      { base: appDb, makeClient: cw.makeClient },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.goneFromChatwoot).toBe(false);
      expect(String(r.data.note)).toMatch(/still exists in Chatwoot/i);
    }
    expect(await suDb.inbox.count({ where: { id: inboxA } })).toBe(1);
  });

  test("inbox_remove apply is refused while the inbox is live, and writes no audit", async () => {
    const cw = fakeChatwoot([11]);
    const r = await inboxRemove(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inboxA), dry_run: false },
      { base: appDb, makeClient: cw.makeClient },
    );
    expect(r.ok).toBe(false);
    expect(await suDb.inbox.count({ where: { id: inboxA } })).toBe(1);
    expect(
      await suDb.auditLog.count({
        where: { tenantId: tenantA, action: "mcp.inbox_remove" },
      }),
    ).toBe(0);
  });

  test("inbox_remove apply removes the mirror and records the audit", async () => {
    const doomed = await suDb.inbox.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: instanceA,
        chatwootInboxId: 12,
        name: "Gone",
      },
    });
    const cw = fakeChatwoot([]);
    const r = await inboxRemove(
      principal({ tenantId: tenantA }),
      { inbox_id: String(doomed.id), dry_run: false },
      { base: appDb, makeClient: cw.makeClient },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
    expect(await suDb.inbox.count({ where: { id: doomed.id } })).toBe(0);
    expect(
      await suDb.auditLog.count({
        where: {
          tenantId: tenantA,
          action: "mcp.inbox_remove",
          target: `inbox:${doomed.id}`,
        },
      }),
    ).toBe(1);
  });

  test("inbox_bind dry-run previews current vs new agent (no network)", async () => {
    const r = await inboxBind(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inboxA), agent_id: "42" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.currentAgentId).toBeNull();
      expect(r.data.newAgentId).toBe("42");
    }
  });

  test("binding an inbox of a disconnected account is refused", async () => {
    const acct = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      baseUrl: "https://chat.example.com",
      accountId: 55,
      adminToken: encryptJson("v"),
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: acct.id,
        chatwootInboxId: 551,
        name: "WA",
      },
    });
    const ctx = {
      tenantId: tenantA,
      userId: null,
      role: "TENANT_ADMIN" as const,
    };
    // No bound inboxes ⇒ soft-disconnect just stamps the flag (no Chatwoot call).
    await softDisconnectChatwootInstance(ctx, acct.id, appDb);
    const r = await inboxBind(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inbox.id), agent_id: "999", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disconnected/i);
    // The binding was not persisted.
    const after = await suDb.inbox.findUnique({ where: { id: inbox.id } });
    expect(after?.agentId).toBeNull();
  });

  test("instance_disconnect dry-run keeps it; apply soft-disconnects it + audits", async () => {
    const victim = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      baseUrl: "https://chat.example.com",
      accountId: 99,
      adminToken: encryptJson("v"),
    });
    const p = principal({ tenantId: tenantA });
    const dry = await instanceDisconnect(
      p,
      { instance_id: String(victim.id) },
      { base: appDb },
    );
    expect(dry.ok).toBe(true);
    if (dry.ok) expect(dry.data.dryRun).toBe(true);
    const before = await suDb.chatwootInstance.findUnique({
      where: { id: victim.id },
    });
    expect(before).not.toBeNull();
    expect(before?.disconnectedAt).toBeNull();

    const applied = await instanceDisconnect(
      p,
      { instance_id: String(victim.id), dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    // Soft-disconnect: the row is KEPT (history/analytics) with disconnectedAt stamped, not deleted.
    const after = await suDb.chatwootInstance.findUnique({
      where: { id: victim.id },
    });
    expect(after).not.toBeNull();
    expect(after?.disconnectedAt).not.toBeNull();
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "mcp.instance_disconnect" },
    });
    expect(audits).toBe(1);
  });

  test("soft-disconnect stamps disconnectedAt (row kept); reconnect clears it", async () => {
    const ctx = {
      tenantId: tenantA,
      userId: null,
      role: "TENANT_ADMIN" as const,
    };
    const victim = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      baseUrl: "https://chat.example.com",
      accountId: 77,
      adminToken: encryptJson("v"),
    });
    // No bound inboxes ⇒ no Chatwoot call; just the disconnect stamp.
    await softDisconnectChatwootInstance(ctx, victim.id, appDb);
    const after = await suDb.chatwootInstance.findUnique({
      where: { id: victim.id },
    });
    expect(after).not.toBeNull();
    expect(after?.disconnectedAt).not.toBeNull();

    const back = await reconnectChatwootInstance(ctx, victim.id, appDb);
    expect(back.disconnectedAt).toBeNull();
    const cleaned = await suDb.chatwootInstance.findUnique({
      where: { id: victim.id },
    });
    expect(cleaned?.disconnectedAt).toBeNull();
  });

  test("disconnect deployment wipes the local mirror (accounts/conversations/contacts)", async () => {
    const tnt = (
      await suDb.tenant.create({
        data: { name: "TD", slug: `td-${process.pid}` },
      })
    ).id;
    const ctx = { tenantId: tnt, userId: null, role: "TENANT_ADMIN" as const };
    const acct = await seedChatwootInstance(suDb, {
      tenantId: tnt,
      baseUrl: "https://chat.example.com",
      accountId: 1,
      adminToken: encryptJson("t"),
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: acct.id,
        tenantId: tnt,
        chatwootContactId: 5,
        name: "C",
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId: tnt,
        chatwootInstanceId: acct.id,
        chatwootConversationId: 9,
        status: "open",
        threadId: `${tnt}:${acct.id}:9`,
        contactId: contact.id,
      },
    });
    await disconnectChatwootDeployment(ctx, appDb);
    // The deployment delete cascades accounts → conversations; contacts are wiped explicitly.
    expect(
      await suDb.chatwootDeployment.count({ where: { tenantId: tnt } }),
    ).toBe(0);
    expect(
      await suDb.chatwootInstance.count({ where: { tenantId: tnt } }),
    ).toBe(0);
    expect(await suDb.conversation.count({ where: { tenantId: tnt } })).toBe(0);
    expect(await suDb.contact.count({ where: { tenantId: tnt } })).toBe(0);
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tnt}`);
  });

  test("instance_disconnect cross-tenant → not found, no write", async () => {
    const r = await instanceDisconnect(
      principal({ tenantId: tenantB }),
      { instance_id: String(instanceA), dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
    expect(
      await suDb.chatwootInstance.findUnique({ where: { id: instanceA } }),
    ).not.toBeNull();
  });
});
