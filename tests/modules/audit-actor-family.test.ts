import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { deleteUser, updateUserRole } from "@/api/features/admin/admin.service";
import {
  createInvite,
  revokeInvite,
} from "@/api/features/invitations/invitation.service";
import type { TenantContext } from "@/lib/tenancy";
import {
  createClient,
  deleteClient,
  deleteClientApproval,
  revokeToken,
  updateClient,
} from "@/modules/mcp/oauth/admin";
import { disconnectClient } from "@/modules/mcp/oauth/connections";
import { upsertApproval } from "@/modules/mcp/oauth/consent";
import { issueAccessToken } from "@/modules/mcp/oauth/tokens";
import { personData } from "@/tests/utils/person";
import { underConcurrentEdit } from "@/tests/utils/pg-waits";

// THE ACTOR FAMILY: revoking a token, changing a role, inviting a user. The question this file holds
// is WHICH TRAIL each row joins: `users`, `invitations` and `mcp_oauth_*` are global (no RLS), so the
// row's tenant is a decision, made in two directions (docs/api-and-fleet.md, "A row about a person"):
//   - the MCP OAuth surface is the DEPLOYMENT's, so its rows are fleet-level (`tenant_id NULL`);
//   - a user's or an invitation's row belongs to the tenant of the SUBJECT, which for a SUPER_ADMIN
//     acting across tenants is never the actor's own. Keyed wrong, the tenant the change happened to
//     never sees it.

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

// A tenant trail is filtered by its tenant, but the FLEET rows (`tenant_id NULL`) are shared with
// every other file in this database, so they are found by their ACTOR. These two ids belong to this
// file and to nothing else.
const FLEET_ACTOR = 9_400_001n;
const TENANT_ACTOR = 9_400_002n;

let tenantId = 0n;
let otherTenantId = 0n;

const fleetAdmin: TenantContext = {
  tenantId: null,
  userId: FLEET_ACTOR,
  role: "SUPER_ADMIN",
};

const tenantAdmin = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: TENANT_ACTOR,
  role: "TENANT_ADMIN",
  ...over,
});

const uniq = () => `${process.pid}${Math.floor(Math.random() * 1e6)}`;

// The fleet rows this file wrote, newest last. Keyed on the actor rather than on `tenant_id IS NULL`
// so a sibling test file's fleet rows are not read as ours.
async function fleetRows(action?: string) {
  return await suDb.auditLog.findMany({
    where: {
      tenantId: null,
      actorId: FLEET_ACTOR,
      ...(action ? { action } : {}),
    },
    orderBy: { id: "asc" },
  });
}

async function tenantRows(of: bigint, action?: string) {
  return await suDb.auditLog.findMany({
    where: { tenantId: of, ...(action ? { action } : {}) },
    orderBy: { id: "asc" },
  });
}

async function clearAudit() {
  await suDb.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE actor_id IN (${FLEET_ACTOR}, ${TENANT_ACTOR})`,
  );
}

const everyRow: unknown[] = [];
async function collect() {
  everyRow.push(...(await fleetRows()), ...(await tenantRows(tenantId)));
}

describe.skipIf(!dbUp)("the actor family records its own changes", () => {
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AUD400", slug: `aud400-${process.pid}` },
    });
    tenantId = t.id;
    const other = await suDb.tenant.create({
      data: { name: "AUD400B", slug: `aud400b-${process.pid}` },
    });
    otherTenantId = other.id;
    await clearAudit();
  });

  afterAll(async () => {
    for (const clientId of createdClientIds) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_access_tokens WHERE client_id = '${clientId}'`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_refresh_tokens WHERE client_id = '${clientId}'`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_client_approvals WHERE client_id = '${clientId}'`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM mcp_oauth_clients WHERE client_id = '${clientId}'`,
      );
    }
    await clearAudit();
    for (const id of [tenantId, otherTenantId]) {
      if (id) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM users WHERE id IN (SELECT user_id FROM tenant_users WHERE tenant_id = ${id})`,
        );
        await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  async function newClient(name: string, over: Record<string, unknown> = {}) {
    const client = await createClient(
      fleetAdmin,
      {
        name,
        redirectUris: ["https://app.example.com/cb"],
        scopes: ["mcp:read"],
        ...over,
      },
      appDb,
    );
    createdClientIds.push(client.clientId);
    return client;
  }

  async function newUser(
    of: bigint | null,
    role: "AGENT" | "TENANT_ADMIN" | "SUPER_ADMIN" = "AGENT",
  ) {
    return await suDb.user.create({
      data: personData({
        tenantId: of,
        email: `u${uniq()}@aud400.test`,
        passwordHash: "x",
        role,
      }),
      select: { id: true, email: true },
    });
  }

  // ── the MCP OAuth admin surface: fleet-level ──────────────────────────────

  test("registering a client records a fleet row that carries no secret", async () => {
    await clearAudit();
    const client = await newClient("Claude");
    const [row] = await fleetRows();
    expect(row?.action).toBe("mcp_client.create");
    expect(row?.target).toBe(`client:${client.clientId}`);
    // The one that would be wrong in the ordinary way: a SUPER_ADMIN usually has a tenant selected
    // in the console, and keyed on the context this deployment-wide registration would be filed
    // under whichever tenant that header named.
    expect(row?.tenantId).toBeNull();
    expect(row?.actorType).toBe("user");
    expect(row?.after).toMatchObject({
      name: "Claude",
      confidential: false,
      firstParty: false,
      scopes: ["mcp:read"],
    });
    expect(JSON.stringify(row?.after)).not.toContain("SecretHash");
    await collect();
  });

  test("the fleet rows stay fleet-level even with a tenant selected", async () => {
    await clearAudit();
    // The condition that makes the ordinary mistake invisible: a SUPER_ADMIN in the console almost
    // always has a tenant in the header, so a row keyed on the CONTEXT looks perfectly well-formed
    // and is filed under a tenant that has nothing to do with a deployment-wide registration. With
    // `fleetAdmin` alone (tenantId already null) both spellings agree and the test proves nothing.
    const selecting = { ...fleetAdmin, tenantId };
    const client = await createClient(
      selecting,
      { name: "Selected", redirectUris: ["https://sel.example.com/cb"] },
      appDb,
    );
    createdClientIds.push(client.clientId);
    await revokeToken(selecting, "no-such-jti", appDb).catch(() => {});
    expect((await fleetRows("mcp_client.create")).length).toBe(1);
    expect(await tenantRows(tenantId, "mcp_client.create")).toEqual([]);
    await collect();
  });

  test("an edit records what moved, and one that moves nothing records nothing", async () => {
    const client = await newClient("Cursor");
    await clearAudit();
    await updateClient(
      fleetAdmin,
      client.clientId,
      { redirectUris: ["https://cursor.example.com/cb"] },
      appDb,
    );
    const [row] = await fleetRows();
    expect(row?.action).toBe("mcp_client.update");
    expect(row?.before).toMatchObject({
      redirectUris: ["https://app.example.com/cb"],
    });
    expect(row?.after).toMatchObject({
      redirectUris: ["https://cursor.example.com/cb"],
    });
    await collect();

    await clearAudit();
    // Re-submitting the same value is what the console does on every save of a form nobody touched.
    await updateClient(
      fleetAdmin,
      client.clientId,
      { redirectUris: ["https://cursor.example.com/cb"] },
      appDb,
    );
    expect(await fleetRows()).toEqual([]);
  });

  test("deleting a client counts the sessions it just killed", async () => {
    const client = await newClient("Doomed");
    const user = await newUser(tenantId);
    await issueAccessToken({
      clientId: client.clientId,
      userId: user.id,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await clearAudit();
    await deleteClient(fleetAdmin, client.clientId, appDb);
    const [row] = await fleetRows();
    expect(row?.action).toBe("mcp_client.delete");
    expect(row?.tenantId).toBeNull();
    expect(row?.before).toMatchObject({
      name: "Doomed",
      revokedAccessTokens: 1,
    });
    // A registration going away takes every session held under it, and no separate act names them:
    // this row is the only place the count exists.
    expect(
      await suDb.mcpOAuthClient.count({ where: { clientId: client.clientId } }),
    ).toBe(0);
    await collect();
  });

  test("revoking a token kills the refresh family with it, in ONE transaction", async () => {
    const client = await newClient("Revoked");
    const user = await newUser(tenantId);
    const issued = await issueAccessToken({
      clientId: client.clientId,
      userId: user.id,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await suDb.mcpOAuthRefreshToken.create({
      data: {
        tokenHash: `rt-${uniq()}`,
        jti: `rtj-${uniq()}`,
        clientId: client.clientId,
        userId: user.id,
        tenantId,
        scopes: ["mcp:read"],
        familyId: `fam-${uniq()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await clearAudit();
    await revokeToken(fleetAdmin, issued.jti, appDb);

    const access = await suDb.mcpOAuthAccessToken.findFirstOrThrow({
      where: { jti: issued.jti },
      select: { revokedAt: true },
    });
    expect(access.revokedAt).not.toBeNull();
    // NOTE: both revocations share one transaction: a failure between them would leave the access
    // token denylisted and the refresh alive, and the client would mint a fresh access token.
    expect(
      await suDb.mcpOAuthRefreshToken.count({
        where: { clientId: client.clientId, revokedAt: null },
      }),
    ).toBe(0);

    const [row] = await fleetRows();
    expect(row?.action).toBe("mcp_token.revoke");
    expect(row?.target).toBe(`mcp_token:${issued.jti}`);
    expect(row?.tenantId).toBeNull();
    expect(row?.before).toMatchObject({
      clientId: client.clientId,
      alreadyRevoked: false,
    });
    expect(row?.after).toMatchObject({ revokedRefreshTokens: 1 });
    await collect();
  });

  test("revoking an already-revoked token still records, and says so", async () => {
    const client = await newClient("Twice");
    const user = await newUser(tenantId);
    const issued = await issueAccessToken({
      clientId: client.clientId,
      userId: user.id,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await revokeToken(fleetAdmin, issued.jti, appDb);
    await clearAudit();
    await revokeToken(fleetAdmin, issued.jti, appDb);
    const [row] = await fleetRows();
    // Revoking is an operator reaching for a live session, not a form being saved. "Already revoked"
    // is the answer to the act, not a reason to leave the act off the trail.
    expect(row?.action).toBe("mcp_token.revoke");
    expect(row?.before).toMatchObject({ alreadyRevoked: true });
    await collect();
  });

  test("an admin forgetting somebody's consent records whose it was", async () => {
    const client = await newClient("Approved");
    const user = await newUser(tenantId);
    await upsertApproval(user.id, client.clientId, ["mcp:read"], appDb);
    const approval = await suDb.mcpOAuthClientApproval.findFirstOrThrow({
      where: { userId: user.id, clientId: client.clientId },
      select: { id: true },
    });
    await clearAudit();
    await deleteClientApproval(fleetAdmin, approval.id, appDb);
    const [row] = await fleetRows();
    expect(row?.action).toBe("mcp_approval.revoke");
    expect(row?.target).toBe(`mcp_approval:${approval.id}`);
    expect(row?.before).toMatchObject({
      userId: String(user.id),
      clientId: client.clientId,
      scopes: ["mcp:read"],
    });
    await collect();
  });

  // ── the self-service disconnect: the ACTOR's own trail ────────────────────

  test("a user disconnecting an app records it in their OWN tenant's trail", async () => {
    const client = await newClient("Mine");
    const user = await newUser(tenantId);
    await upsertApproval(user.id, client.clientId, ["mcp:read"], appDb);
    await issueAccessToken({
      clientId: client.clientId,
      userId: user.id,
      tenantId,
      role: "AGENT",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await clearAudit();
    const ctx = { ...tenantAdmin(), userId: user.id };
    await disconnectClient(ctx, client.clientId, appDb);
    const [row] = await tenantRows(tenantId, "mcp_client.disconnect");
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.actorId).toBe(user.id);
    expect(row?.after).toMatchObject({
      clientId: client.clientId,
      removedApproval: true,
      revokedAccessTokens: 1,
    });
    // Idempotent: the console offers the button on a connection the user may already have dropped,
    // so a second click must not append a row saying nothing happened.
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
    );
    await disconnectClient(ctx, client.clientId, appDb);
    expect(await tenantRows(tenantId, "mcp_client.disconnect")).toEqual([]);
  });

  test("a SUPER_ADMIN's own disconnect is fleet-level, not filed under the selected tenant", async () => {
    const client = await newClient("FleetMine");
    await upsertApproval(FLEET_ACTOR, client.clientId, ["mcp:read"], appDb);
    await clearAudit();
    // A fleet admin browsing the console carries whichever tenant they had selected. They belong to
    // none of them, so the row must not join a trail that had nothing to do with the act.
    await disconnectClient(
      { ...fleetAdmin, tenantId, userId: FLEET_ACTOR },
      client.clientId,
      appDb,
    );
    const [row] = await fleetRows("mcp_client.disconnect");
    expect(row?.tenantId).toBeNull();
    expect(await tenantRows(tenantId, "mcp_client.disconnect")).toEqual([]);
    await collect();
  });

  // ── users and invitations: the SUBJECT's trail ────────────────────────────

  test("a role change is filed under the TARGET's tenant, never the actor's", async () => {
    const user = await newUser(tenantId, "AGENT");
    await clearAudit();
    // The fleet admin re-roles somebody in a tenant they do not belong to. Keyed on the actor, this
    // row would be fleet-level and the tenant it happened to could never read it.
    await updateUserRole(fleetAdmin, user.id, { role: "TENANT_ADMIN" }, appDb);
    const [row] = await tenantRows(tenantId, "user.role_set");
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.actorId).toBe(FLEET_ACTOR);
    expect(row?.target).toBe(`user:${user.id}`);
    expect(row?.before).toMatchObject({ role: "AGENT", email: user.email });
    expect(row?.after).toMatchObject({ role: "TENANT_ADMIN" });
    expect(await fleetRows("user.role_set")).toEqual([]);
  });

  test("re-applying the role somebody already has records nothing", async () => {
    const user = await newUser(tenantId, "AGENT");
    await clearAudit();
    await updateUserRole(fleetAdmin, user.id, { role: "AGENT" }, appDb);
    expect(await tenantRows(tenantId, "user.role_set")).toEqual([]);
  });

  test("a tenant admin cannot re-role outside their own tenant", async () => {
    const outsider = await newUser(otherTenantId, "AGENT");
    await expect(
      updateUserRole(
        tenantAdmin(),
        outsider.id,
        { role: "TENANT_ADMIN" },
        appDb,
      ),
    ).rejects.toThrow();
    expect(
      (
        await suDb.tenantUser.findFirstOrThrow({
          where: { userId: outsider.id },
        })
      ).role,
    ).toBe("AGENT");
  });

  test("a cross-tenant id never takes the lock it is about to be refused for", async () => {
    // `users` and `invitations` are global, so an unscoped `FOR UPDATE` by id locks a row the
    // caller has no business touching, BEFORE the scoped read decides it is a 404. A tenant admin could
    // then hold another tenant's user row for the length of their own transaction, and somebody
    // else's role change, deletion or login write waits behind it.
    //
    // Asserted as an ORDER and not as a duration: the refusal has to arrive while the lock is still
    // held by somebody else. Unscoped, the call blocks until the holder commits, so `released` would
    // already be true by the time it returned.
    const outsider = await newUser(otherTenantId, "AGENT");
    const invite = await createInvite(
      { ...fleetAdmin },
      {
        tenantId: otherTenantId,
        email: `lock${uniq()}@aud400.test`,
        role: "AGENT",
      },
      appDb,
    );
    await clearAudit();

    for (const attempt of [
      () =>
        updateUserRole(
          tenantAdmin(),
          outsider.id,
          { role: "TENANT_ADMIN" },
          appDb,
        ),
      () => deleteUser(tenantAdmin(), outsider.id, appDb),
      () => revokeInvite(tenantAdmin(), invite.id, appDb),
    ]) {
      let released = false;
      const holder = suDb.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${outsider.id} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM invitations WHERE id = ${invite.id} FOR UPDATE`;
          await new Promise((r) => setTimeout(r, 2_000));
          released = true;
        },
        { timeout: 15_000 },
      );
      await new Promise((r) => setTimeout(r, 250));
      await expect(attempt()).rejects.toThrow();
      expect(released).toBe(false);
      await holder;
    }
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${otherTenantId}`,
    );
  }, 30_000);

  test("a deleted user's row outlives them, and is the only place their identity survives", async () => {
    const user = await newUser(tenantId, "AGENT");
    await clearAudit();
    await deleteUser(fleetAdmin, user.id, appDb);
    expect(await suDb.user.count({ where: { id: user.id } })).toBe(0);
    const [row] = await tenantRows(tenantId, "user.delete");
    expect(row?.tenantId).toBe(tenantId);
    // `audit_logs` has no foreign key to `users`, which is what lets this row answer for an account
    // that no longer exists.
    expect(row?.before).toMatchObject({ email: user.email, role: "AGENT" });
  });

  test("a SUPER_ADMIN's deletion is fleet-level, because they belong to no tenant", async () => {
    await suDb.user.create({
      data: personData({
        tenantId: null,
        email: `keep${uniq()}@aud400.test`,
        passwordHash: "x",
        role: "SUPER_ADMIN",
      }),
    });
    const doomed = await newUser(null, "SUPER_ADMIN");
    await clearAudit();
    await deleteUser(fleetAdmin, doomed.id, appDb);
    const [row] = await fleetRows("user.delete");
    expect(row?.tenantId).toBeNull();
    expect(row?.before).toMatchObject({ email: doomed.email, tenantId: null });
    await collect();
  });

  test("an invitation is filed under the tenant it invites INTO", async () => {
    await clearAudit();
    const email = `join${uniq()}@aud400.test`;
    // The `POST /v1/tenants` shape: a fleet admin issuing the first TENANT_ADMIN invite of a tenant
    // they have nothing to do with.
    const invite = await createInvite(
      fleetAdmin,
      { tenantId: otherTenantId, email, role: "TENANT_ADMIN" },
      appDb,
    );
    const [row] = await tenantRows(otherTenantId, "invitation.create");
    expect(row?.tenantId).toBe(otherTenantId);
    expect(row?.actorId).toBe(FLEET_ACTOR);
    expect(row?.after).toMatchObject({ email, role: "TENANT_ADMIN" });
    // The token is the credential the invitation IS. Neither it nor its hash may reach a row the
    // tenant's own admins read.
    const dumped = JSON.stringify(row, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(dumped).not.toContain(invite.token);
    expect(dumped).not.toContain("tokenHash");

    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${otherTenantId}`,
    );
    await revokeInvite(fleetAdmin, invite.id, appDb);
    const [revoked] = await tenantRows(otherTenantId, "invitation.revoke");
    expect(revoked?.tenantId).toBe(otherTenantId);
    expect(revoked?.before).toMatchObject({ email });
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${otherTenantId}`,
    );
  });

  test("a re-invite records again, because it rotated a live token", async () => {
    const email = `again${uniq()}@aud400.test`;
    await createInvite(
      tenantAdmin(),
      { tenantId, email, role: "AGENT" },
      appDb,
    );
    await clearAudit();
    const second = await createInvite(
      tenantAdmin(),
      { tenantId, email, role: "AGENT" },
      appDb,
    );
    // Nothing about the row moved, and it is still recorded: the act minted a token and invalidated
    // the one somebody may already be holding.
    const rows = await tenantRows(tenantId, "invitation.create");
    expect(rows.length).toBe(1);
    expect(rows[0]?.after).toMatchObject({ email });
    await revokeInvite(tenantAdmin(), second.id, appDb);
    await collect();
  });

  test("an api-key principal is recorded as one", async () => {
    const user = await newUser(tenantId, "AGENT");
    await clearAudit();
    await updateUserRole(
      { ...fleetAdmin, actorType: "api_key" },
      user.id,
      { role: "TENANT_ADMIN" },
      appDb,
    );
    const [row] = await tenantRows(tenantId, "user.role_set");
    // The action names what changed; `actorType` names the door. A fleet API key re-roling somebody
    // and an admin doing it at the console are the same change, told apart only here.
    expect(row?.actorType).toBe("api_key");
  });

  // ── the fences ────────────────────────────────────────────────────────────

  test("no row anywhere in this family carries a credential", async () => {
    expect(everyRow.length).toBeGreaterThan(6);
    const dumped = JSON.stringify(everyRow, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    for (const forbidden of [
      "tokenHash",
      "clientSecretHash",
      "passwordHash",
      "SecretHash",
    ]) {
      expect(dumped).not.toContain(forbidden);
    }
  });

  // A failed audit write has to take the change down with it. A function in the MCP admin module that
  // wrote outside its transaction (or with no transaction at all) commits the change and loses the
  // row that records it. The refusal is a trigger on this file's own actor and one action, so no other
  // writer in the database is touched.
  async function withAuditRefused(action: string, act: () => Promise<unknown>) {
    const fn = `refuse_audit_${process.pid}`;
    await suDb.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit insert refused'; END $$`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.actor_id = ${FLEET_ACTOR} AND NEW.action = '${action}') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await expect(act()).rejects.toThrow();
    } finally {
      await suDb.$executeRawUnsafe(`DROP TRIGGER ${fn} ON audit_logs`);
      await suDb.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  }

  test("every mutation in the MCP admin module rolls back when its audit row cannot be written", async () => {
    const name = `NeverRegistered${uniq()}`;
    await withAuditRefused("mcp_client.create", () => newClient(name));
    expect(await suDb.mcpOAuthClient.count({ where: { name } })).toBe(0);

    const client = await newClient("Atomic");
    await withAuditRefused("mcp_client.update", () =>
      updateClient(
        fleetAdmin,
        client.clientId,
        { redirectUris: ["https://moved.example.com/cb"] },
        appDb,
      ),
    );
    expect(
      (
        await suDb.mcpOAuthClient.findUniqueOrThrow({
          where: { clientId: client.clientId },
        })
      ).redirectUris,
    ).toEqual(["https://app.example.com/cb"]);

    const user = await newUser(tenantId);
    const issued = await issueAccessToken({
      clientId: client.clientId,
      userId: user.id,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await suDb.mcpOAuthRefreshToken.create({
      data: {
        tokenHash: `rt-${uniq()}`,
        jti: `rtj-${uniq()}`,
        clientId: client.clientId,
        userId: user.id,
        tenantId,
        scopes: ["mcp:read"],
        familyId: `fam-${uniq()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await withAuditRefused("mcp_token.revoke", () =>
      revokeToken(fleetAdmin, issued.jti, appDb),
    );
    const live = async () => [
      (
        await suDb.mcpOAuthAccessToken.findFirstOrThrow({
          where: { jti: issued.jti },
        })
      ).revokedAt,
      await suDb.mcpOAuthRefreshToken.count({
        where: { clientId: client.clientId, revokedAt: null },
      }),
    ];
    expect(await live()).toEqual([null, 1]);

    await upsertApproval(user.id, client.clientId, ["mcp:read"], appDb);
    const approval = await suDb.mcpOAuthClientApproval.findFirstOrThrow({
      where: { userId: user.id, clientId: client.clientId },
      select: { id: true },
    });
    await withAuditRefused("mcp_approval.revoke", () =>
      deleteClientApproval(fleetAdmin, approval.id, appDb),
    );
    expect(
      await suDb.mcpOAuthClientApproval.count({ where: { id: approval.id } }),
    ).toBe(1);

    await withAuditRefused("mcp_client.delete", () =>
      deleteClient(fleetAdmin, client.clientId, appDb),
    );
    expect(
      await suDb.mcpOAuthClient.count({ where: { clientId: client.clientId } }),
    ).toBe(1);
    expect(await live()).toEqual([null, 1]);
  });

  // The lock is what makes the recorded `before` the value this write actually replaced. Without it
  // two acts on the same row both read the same one, and the trail shows one of the two changes twice
  // and the other not at all. Each case changes the row in a superuser transaction, starts the act,
  // waits until a backend is parked on a row lock, and only then commits: an act that read under the
  // lock records the committed change, one that read first records the value the change replaced.
  const underEdit = (
    edit: Parameters<typeof underConcurrentEdit>[1],
    act: () => Promise<unknown>,
  ) => underConcurrentEdit(suDb, edit, act);

  test("every recorded mutation reads its `before` under the row's own lock", async () => {
    const client = await newClient("Locked");
    await clearAudit();
    await underEdit(
      (tx) =>
        tx.mcpOAuthClient.update({
          where: { clientId: client.clientId },
          data: { name: "Renamed meanwhile" },
        }),
      () =>
        updateClient(
          fleetAdmin,
          client.clientId,
          { redirectUris: ["https://locked.example.com/cb"] },
          appDb,
        ),
    );
    expect((await fleetRows("mcp_client.update"))[0]?.before).toMatchObject({
      name: "Renamed meanwhile",
    });

    const user = await newUser(tenantId);
    const issued = await issueAccessToken({
      clientId: client.clientId,
      userId: user.id,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      base: appDb,
    });
    await underEdit(
      (tx) =>
        tx.mcpOAuthAccessToken.updateMany({
          where: { jti: issued.jti },
          data: { revokedAt: new Date() },
        }),
      () => revokeToken(fleetAdmin, issued.jti, appDb),
    );
    expect((await fleetRows("mcp_token.revoke"))[0]?.before).toMatchObject({
      alreadyRevoked: true,
    });

    await upsertApproval(user.id, client.clientId, ["mcp:read"], appDb);
    const approval = await suDb.mcpOAuthClientApproval.findFirstOrThrow({
      where: { userId: user.id, clientId: client.clientId },
      select: { id: true },
    });
    await underEdit(
      (tx) =>
        tx.mcpOAuthClientApproval.update({
          where: { id: approval.id },
          data: { scopes: ["mcp:read", "mcp:write"] },
        }),
      () => deleteClientApproval(fleetAdmin, approval.id, appDb),
    );
    expect((await fleetRows("mcp_approval.revoke"))[0]?.before).toMatchObject({
      scopes: ["mcp:read", "mcp:write"],
    });

    await underEdit(
      (tx) =>
        tx.mcpOAuthClient.update({
          where: { clientId: client.clientId },
          data: { name: "Renamed again" },
        }),
      () => deleteClient(fleetAdmin, client.clientId, appDb),
    );
    expect((await fleetRows("mcp_client.delete"))[0]?.before).toMatchObject({
      name: "Renamed again",
    });

    // A re-role to the role the concurrent edit already gave records nothing: read before the lock,
    // the act would record the transition the edit made as its own.
    const member = await newUser(tenantId, "AGENT");
    await underEdit(
      (tx) =>
        tx.tenantUser.update({
          where: { tenantId_userId: { tenantId, userId: member.id } },
          data: { role: "TENANT_ADMIN" },
        }),
      () =>
        updateUserRole(
          tenantAdmin(),
          member.id,
          { role: "TENANT_ADMIN" },
          appDb,
        ),
    );
    expect(await tenantRows(tenantId, "user.role_set")).toEqual([]);

    await newUser(tenantId, "TENANT_ADMIN");
    const leaving = await newUser(tenantId, "AGENT");
    await underEdit(
      (tx) =>
        tx.tenantUser.update({
          where: { tenantId_userId: { tenantId, userId: leaving.id } },
          data: { role: "TENANT_ADMIN" },
        }),
      () => deleteUser(tenantAdmin(), leaving.id, appDb),
    );
    expect(
      (await tenantRows(tenantId, "user.delete"))[0]?.before,
    ).toMatchObject({ role: "TENANT_ADMIN" });

    const invite = await createInvite(
      tenantAdmin(),
      { tenantId, email: `race${uniq()}@aud400.test`, role: "AGENT" },
      appDb,
    );
    await underEdit(
      (tx) =>
        tx.invitation.update({
          where: { id: invite.id },
          data: { role: "TENANT_ADMIN" },
        }),
      () => revokeInvite(tenantAdmin(), invite.id, appDb),
    );
    expect(
      (await tenantRows(tenantId, "invitation.revoke"))[0]?.before,
    ).toMatchObject({ role: "TENANT_ADMIN" });
  });
});
