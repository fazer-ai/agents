import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  connectChatwootDeployment,
  disconnectChatwootDeployment,
  reconnectChatwootInstance,
  softDisconnectChatwootInstance,
} from "@/modules/chatwoot/management";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  deploymentConnect,
  deploymentSetAccounts,
  inboxBind,
  inboxObserve,
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

  test("deployment_connect dry-run refuses a malformed base_url", async () => {
    // NOTE: what is still answerable with NO database. The preview used to approve every base URL
    // and this block previewed a successful connect; it now reads the tenant's current deployment
    // to refuse a server switch (#490), so a successful preview belongs in the DB block below.
    // What survives here is the pure half: a base URL that is not a URL needs nothing to refuse.
    const r = await deploymentConnect(principal({}), {
      base_url: "not-a-url",
      admin_token: "raw-secret-xyz",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("raw-secret-xyz");
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

  // The APPLY's own refusal, which had no test at all until a mutation deleting it from
  // `connectChatwootDeployment` survived the whole suite. Writing it is also what showed that the
  // apply reached the network FIRST and refused the switch afterwards — so this test hung for 30s
  // against a server that is not there, and the operator's admin token had already been sent to a
  // deployment we were always going to reject. The check now runs before that round trip.
  test("deployment_connect refuses a second, different Chatwoot server", async () => {
    const r = await deploymentConnect(
      principal({ tenantId: tenantA }),
      {
        base_url: "https://93.184.216.34",
        admin_token: "cw-token",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("different Chatwoot deployment");
  });

  // The refusal above is asked TWICE on purpose, and this is the second one. The early copy runs
  // outside any transaction so it can save the credential round trip; a deployment created in the
  // window between it and the write would slip past it, and only the copy inside the transaction
  // still answers. Deleting that copy passes every other test in this file, which is why the race
  // is driven here rather than assumed: the hook inserts the competing deployment after the early
  // read has already come back empty.
  test("a deployment created after the early check is still refused", async () => {
    let reads = 0;
    // NOTE: `$transaction` has to be wrapped, not just the delegate. Both reads go through
    // `runScopedOn`, so they are issued on the TRANSACTION handle and a proxy on the client's own
    // `chatwootDeployment` never sees either of them — it counts zero and the test passes for the
    // wrong reason.
    const wrap = (c: object): object =>
      new Proxy(c, {
        get(t, prop, recv) {
          const inner = Reflect.get(t, prop, recv);
          // `runScopedOn` calls `base.$extends(...)` FIRST and issues everything on the client
          // that comes back, so a proxy that only wraps `$transaction` is bypassed entirely and
          // silently — the counter stays at zero and the test passes for the wrong reason.
          if (prop === "$extends") {
            return (...a: unknown[]) =>
              wrap(
                (inner as (...x: unknown[]) => object).apply(t, a) as object,
              );
          }
          if (prop === "$transaction") {
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              (inner as (...a: unknown[]) => unknown).call(
                t,
                (tx: unknown) => fn(wrap(tx as object)),
                ...rest,
              );
          }
          if (prop !== "chatwootDeployment") return inner;
          return new Proxy(inner as object, {
            get(d, k, r) {
              const fn = Reflect.get(d, k, r);
              if (k !== "findFirst") return fn;
              return async (a: unknown) => {
                const res = await (fn as (x: unknown) => Promise<unknown>).call(
                  d,
                  a,
                );
                // Only after the FIRST read — the one outside the transaction — and only once.
                if (++reads === 1) {
                  await suDb.chatwootDeployment.create({
                    data: {
                      tenantId: tenantB,
                      baseUrl: "https://cw-raced.example.com",
                      adminToken: encryptJson("tok"),
                    },
                  });
                }
                return res;
              };
            },
          });
        },
      });
    const racing = wrap(appDb as object) as typeof appDb;

    // The CORE, not the tool: the race lives past the credential probe, and only the core takes a
    // seam for it. Driving the tool would send this at a server that is not there and measure a
    // 30-second timeout instead of the refusal.
    const err = await connectChatwootDeployment(
      { userId: 1n, tenantId: tenantB, role: "TENANT_ADMIN" },
      { baseUrl: "https://93.184.216.34", adminToken: "cw-token" },
      { fetchProfile: async () => ({ id: 1, accounts: [] }) },
      racing,
    ).catch((e: unknown) => e);
    // BEFORE the assertions, not after. The row the hook inserted is this test's, not the
    // fixture's, and leaving it makes tenantB look connected to every test that runs after — so a
    // failure here would take an unrelated test down with it and hide which one actually broke.
    await suDb.$executeRawUnsafe(
      `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tenantB}`,
    );
    expect(reads).toBeGreaterThan(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("different Chatwoot deployment");
  });

  test("deployment_connect dry-run with a raw token previews, creates nothing", async () => {
    // NOTE: tenantB, not tenantA. `tenantA` is seeded with a deployment at chat.example.com, so
    // previewing a connect to a DIFFERENT server is a switch — which the preview now refuses the
    // way the apply always did (#490). This test is about the token and the absent row, so it
    // needs the tenant that has nothing connected.
    const r = await deploymentConnect(
      principal({ tenantId: tenantB }),
      {
        // NOTE: a public IP literal for the same reason as the gate test above — the preview
        // resolves a hostname now, and this test is about the token and the absent row (#490).
        base_url: "https://93.184.216.34",
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
      where: { tenantId: tenantB, baseUrl: "https://93.184.216.34" },
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

  // `InboxObserver` cascades on the inbox's foreign key, so the removal discards bindings the caller
  // never named — and those bindings are what refuse the agent's mode change and its deletion
  // elsewhere. A preview that omits them shows a removal smaller than the one it approves.
  test("inbox_remove dry-run names the observers the cascade will take", async () => {
    const watcher = await suDb.agent.create({
      data: {
        tenantId: tenantA,
        name: "Watcher",
        systemPrompt: "p",
        mode: "monitoring",
      },
      select: { id: true },
    });
    await suDb.inboxObserver.create({
      data: { tenantId: tenantA, inboxId: inboxA, agentId: watcher.id },
    });
    try {
      const cw = fakeChatwoot([]);
      const r = await inboxRemove(
        principal({ tenantId: tenantA }),
        { inbox_id: String(inboxA) },
        { base: appDb, makeClient: cw.makeClient },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.current).toMatchObject({
          observerAgentIds: [String(watcher.id)],
        });
      }
    } finally {
      await suDb.inboxObserver.deleteMany({ where: { inboxId: inboxA } });
      await suDb.agent.delete({ where: { id: watcher.id } });
    }
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
        where: { tenantId: tenantA, action: "inbox.remove" },
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
          action: "inbox.remove",
          target: `inbox:${doomed.id}`,
        },
      }),
    ).toBe(1);
  });

  test("inbox_bind dry-run previews current vs new agent (no network)", async () => {
    // A REAL agent, and it is not decoration: the preview now asks the two questions the write asks
    // past existence — the account is connected, and the agent being bound exists (#510). A literal
    // id that names nothing used to read back "would bind" here, which is the write the apply
    // refuses.
    const target = await suDb.agent.create({
      data: {
        tenantId: tenantA,
        name: "Bindable",
        systemPrompt: "p",
        modelConfig: {},
        settings: {},
      },
    });
    const r = await inboxBind(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inboxA), agent_id: String(target.id) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.currentAgentId).toBeNull();
      expect(r.data.newAgentId).toBe(String(target.id));
    }
  });

  test("inbox_bind dry-run refuses an agent that does not exist", async () => {
    const r = await inboxBind(
      principal({ tenantId: tenantA }),
      { inbox_id: String(inboxA), agent_id: "42" },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/agent not found/i);
  });

  // A PREVIEW ANSWERS WITH THE APPLY'S OWN "no" (issue #476 review, round 25). A dry run that
  // approves an operation the apply then refuses is worse than no preview: the caller reads `ok`
  // and learns the truth from the 422.
  test("inbox_observe and inbox_bind dry runs refuse what their applies refuse", async () => {
    const watcher = await suDb.agent.create({
      data: {
        tenantId: tenantA,
        name: "Vigia",
        systemPrompt: "x",
        mode: "monitoring",
      },
      select: { id: true },
    });
    const answerer = await suDb.agent.create({
      data: {
        tenantId: tenantA,
        name: "Atendente",
        systemPrompt: "x",
        mode: "production",
      },
      select: { id: true },
    });
    const p = principal({ tenantId: tenantA });

    // A monitoring agent on a free inbox: the preview says yes, and it means it.
    const okDry = await inboxObserve(
      p,
      { inbox_id: String(inboxA), agent_id: String(watcher.id) },
      { base: appDb },
    );
    expect(okDry.ok).toBe(true);

    // A production agent cannot observe, and the preview says so without calling Chatwoot.
    const notMonitoring = await inboxObserve(
      p,
      { inbox_id: String(inboxA), agent_id: String(answerer.id) },
      { base: appDb },
    );
    expect(notMonitoring.ok).toBe(false);
    if (!notMonitoring.ok) expect(notMonitoring.error).toMatch(/monitoring/i);

    // An agent that does not exist, likewise.
    const noAgent = await inboxObserve(
      p,
      { inbox_id: String(inboxA), agent_id: "999999999" },
      { base: appDb },
    );
    expect(noAgent.ok).toBe(false);

    // With the watcher observing, an inbox takes no second one — and binding THAT agent as the
    // responder is the refusal `inbox_bind`'s preview owes its caller.
    await suDb.inboxObserver.create({
      data: { tenantId: tenantA, inboxId: inboxA, agentId: watcher.id },
    });
    const second = await inboxObserve(
      p,
      { inbox_id: String(inboxA), agent_id: String(answerer.id) },
      { base: appDb },
    );
    expect(second.ok).toBe(false);
    const bindWatcher = await inboxBind(
      p,
      { inbox_id: String(inboxA), agent_id: String(watcher.id) },
      { base: appDb },
    );
    expect(bindWatcher.ok).toBe(false);
    if (!bindWatcher.ok) expect(bindWatcher.error).toMatch(/observes/i);
    // Another agent is still bindable: the refusal is about the pair, not the inbox.
    const bindOther = await inboxBind(
      p,
      { inbox_id: String(inboxA), agent_id: String(answerer.id) },
      { base: appDb },
    );
    expect(bindOther.ok).toBe(true);
    await suDb.inboxObserver.deleteMany({ where: { inboxId: inboxA } });
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
    // Scoped to THIS instance, not to the tenant: since #395 the row is written by the service, so
    // another test in this file disconnecting another account leaves one too. One row for one apply
    // is still the claim, and the target is what says which apply.
    const audits = await suDb.auditLog.count({
      where: {
        tenantId: tenantA,
        action: "instance.disconnect",
        target: `chatwoot_instance:${victim.id}`,
      },
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
