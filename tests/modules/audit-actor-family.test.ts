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

// THE ACTOR FAMILY (issue #400): revoking a token, changing a role, inviting a user.
//
// The last three groups of #306, and the only ones with no MCP twin at all — every action name here
// is invented rather than moved down, because before this nothing on any transport recorded them.
// They are also the group a compliance reader asks about first: who was invited, who became an
// admin, whose token was revoked.
//
// The question this file exists to hold is WHICH TRAIL each row joins, because these are the
// families whose tables carry no tenant to follow. `users`, `invitations` and `mcp_oauth_*` are all
// global (no RLS), so the row's tenant is a decision and not a consequence, and it is made twice in
// two different directions:
//
//   - the MCP OAuth surface is the DEPLOYMENT's, so its rows are fleet-level (`tenant_id NULL`);
//   - a user's or an invitation's row belongs to the tenant of the SUBJECT, which for a SUPER_ADMIN
//     acting across tenants is never the actor's own.
//
// Getting the second one wrong is invisible from the writing side and total from the reading side:
// the tenant the change happened to would never see it.

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
          `DELETE FROM users WHERE tenant_id = ${id}`,
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
      data: {
        tenantId: of,
        email: `u${uniq()}@aud400.test`,
        passwordHash: "x",
        role,
      },
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
    // The half that used to live in its own statement, outside any transaction: a failure between
    // the two left the access token denylisted and the refresh alive, which is the client minting a
    // fresh access token on the spot.
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
      (await suDb.user.findFirstOrThrow({ where: { id: outsider.id } })).role,
    ).toBe("AGENT");
  });

  test("a cross-tenant id never takes the lock it is about to be refused for", async () => {
    // `users` and `invitations` are global, so an unscoped `FOR UPDATE` by id locks a row the caller
    // has no business touching — BEFORE the scoped read decides it is a 404. A tenant admin could
    // then hold another tenant's user row for the length of their own transaction, and somebody
    // else's role change, deletion or login write waits behind it. Round 1 on #498.
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
      data: {
        tenantId: null,
        email: `keep${uniq()}@aud400.test`,
        passwordHash: "x",
        role: "SUPER_ADMIN",
      },
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

  test("every mutation in the MCP admin module writes inside ONE transaction", async () => {
    const src = await Bun.file("src/modules/mcp/oauth/admin.ts").text();
    // The defect this replaces was structural rather than a missing row: `revokeToken` performed two
    // writes with no transaction at all, and the audit row could only ever have been a third. A
    // mutation is recognised by the writes it makes, and every one of them has to sit inside the
    // module's single transaction opener.
    const bodies = src.split(/\nexport async function /).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      const writes = body.match(
        /\b(?:create|update|updateMany|delete|deleteMany|upsert)\(/g,
      );
      if (!writes) continue;
      expect(`${name}: ${body.includes("asSuperAdminOn(base,")}`).toBe(
        `${name}: true`,
      );
      // No write may reach the base client, which is the one path outside the transaction.
      expect(
        `${name}: ${/\bbase\.\w+\.(create|update|delete|upsert)/.test(body)}`,
      ).toBe(`${name}: false`);
    }
  });

  test("every recorded mutation reads its `before` under the row's own lock", async () => {
    // Per FUNCTION, not per module. A fence that only counts locks across a file passes while one of
    // its mutations has none: measured — removing the lock from `updateUserRole` entirely left the
    // module-wide check green, because `deleteUser` still carried one.
    //
    // The lock is what makes the recorded `before` the value this write actually replaced. Without
    // it two acts on the same row both read the same one, and the trail shows one of the two changes
    // twice and the other not at all.
    const blocks: [string, string][] = [];
    for (const path of [
      "src/api/features/admin/admin.service.ts",
      "src/api/features/invitations/invitation.service.ts",
      "src/modules/mcp/oauth/admin.ts",
    ]) {
      const src = await Bun.file(path).text();
      // One level of indirection is followed, and no more: a module may spell its lock in a helper
      // (`lockUserInScope` carries the tenant fence the lock has to have), and a mutation that calls
      // it has taken the lock as surely as one that writes the SQL. Anything deeper would make the
      // fence agree with a call chain nobody can see from the mutation.
      const lockHelpers = [
        ...src.matchAll(/\nasync function (\w+)\(([\s\S]*?)\n}/g),
      ]
        .filter(([, , body]) => /FOR UPDATE/.test(body ?? ""))
        .map(([, fnName]) => fnName);
      const takesLock = (chunk: string) =>
        /FOR UPDATE/.test(chunk) ||
        lockHelpers.some((fn) => new RegExp(`\\b${fn}\\(`).test(chunk));
      for (const chunk of src.split(/\nexport async function /).slice(1)) {
        const name = `${path.split("/").pop()}:${chunk.slice(0, chunk.indexOf("("))}`;
        // A mutation that records a `before` is the one this is about. A pure create has nothing to
        // compare against and nothing to lock.
        if (/\bbefore:/.test(chunk)) blocks.push([name, `${takesLock(chunk)}`]);
      }
    }
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const [name, locked] of blocks) {
      expect(`${name}: ${locked}`).toBe(`${name}: true`);
    }
  });

  test("the module takes one lock mode and takes it everywhere", async () => {
    const sources = [
      "src/modules/mcp/oauth/admin.ts",
      "src/api/features/admin/admin.service.ts",
      "src/api/features/invitations/invitation.service.ts",
    ];
    for (const path of sources) {
      const src = await Bun.file(path).text();
      const locks = src.match(
        /FOR (?:NO KEY )?UPDATE|FOR KEY SHARE|FOR SHARE/g,
      );
      expect(`${path}: ${locks?.length ?? 0}`).not.toBe(`${path}: 0`);
      // Uniform on purpose: a module that mixes `FOR UPDATE` with `FOR NO KEY UPDATE` deadlocks over
      // a key nobody was changing, and a deadlock has no green test to show it (#395). Nothing
      // references these rows by foreign key, so nothing takes KEY SHARE on them and `FOR UPDATE` is
      // the mode that fits.
      expect(`${path}: ${new Set(locks).size}`).toBe(`${path}: 1`);
      expect(`${path}: ${locks?.[0]}`).toBe(`${path}: FOR UPDATE`);
    }
  });
});
