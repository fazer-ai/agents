import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  createPendingVaultEntry,
  createVaultEntry,
  deleteVaultEntry,
  persistRefreshedOAuthSecret,
  updateVaultEntry,
} from "@/modules/vault/service";

// THE VAULT FAMILY (issue #444), where only the CREATION of a credential was audited, and only over
// MCP.
//
// Two of its three routes had no action name anywhere. Replacing the value behind a live reference
// (`PUT /v1/vault/:id`) was invisible on every transport, and deleting a credential was invisible
// while creating one was recorded. Both are named here.
//
// This is also the family where the metadata and the thing that authenticates sit in adjacent
// columns, so the split matters more than usual: `secret` is compared and never carried, `baseUrl`
// is an operator-typed URL and reaches the row as its origin, and the fence in
// `tests/modules/audit-config-families.test.ts` reads `prisma/schema.prisma` so a column added to
// `VaultEntry` later has to be placed rather than forgotten.

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

const USER = 9444n;
// The value that must never reach a row, on either end of an update.
const SECRET = "sk-vault-9444-secret";
const NEW_SECRET = "sk-vault-9444-rotated";

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

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

const everyRow: unknown[] = [];
async function collect() {
  everyRow.push(...(await rows()));
}

const uniq = () => `${process.pid}${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!dbUp)("the vault family records its own changes", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AUD444", slug: `aud444-${process.pid}` },
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

  // THE REFRESH, which is a write to `secret` like any other and must not be recorded like any
  // other. An access token expires hourly and is renewed by USE, not by a decision, so a row per
  // refresh puts machine bookkeeping into an append-only table every hour per credential and drowns
  // the operator's own edits. The line is what MOVED: the access token is a derived, short-lived
  // artifact; the refresh token and the granted scopes are the credential itself.
  // Seeded straight through the superuser client, like `vault/google-oauth.test.ts` does: a
  // `google_oauth` entry declares only the client id and secret at creation, and the tokens are
  // merged in by the OAuth callback afterwards, so `createVaultEntry` refuses a value carrying them.
  async function oauthEntry(name: string, cred: Record<string, unknown>) {
    const row = await suDb.vaultEntry.create({
      data: { tenantId, name, kind: "google_oauth", secret: encryptJson(cred) },
      select: { id: true },
    });
    await clearAudit();
    return row.id;
  }

  const baseCred = {
    clientId: "c",
    clientSecret: "s",
    accessToken: "at-1",
    refreshToken: "rt-1",
    scopes: ["a", "b"],
    expiresAt: 1,
  };

  test("a refresh that only renewed the access token records nothing", async () => {
    const id = await oauthEntry(`ref${uniq()}`, baseCred);
    await persistRefreshedOAuthSecret(
      ctx(),
      id,
      { ...baseCred, accessToken: "at-2", expiresAt: 2 },
      appDb,
    );
    expect(await rows()).toEqual([]);
    // Silent, but not a no-op: the new token IS stored, or the next call refreshes all over again.
    const stored = await suDb.vaultEntry.findFirstOrThrow({
      where: { id },
      select: { secret: true },
    });
    expect(stored.secret).not.toBe("");
  });

  test("a rotated refresh token is a credential change, and is recorded as one", async () => {
    const id = await oauthEntry(`rot${uniq()}`, baseCred);
    await persistRefreshedOAuthSecret(
      ctx(),
      id,
      { ...baseCred, accessToken: "at-2", refreshToken: "rt-2" },
      appDb,
    );
    const [row] = await rows("credential.update");
    expect(row?.target).toBe(`vault:${id}`);
    // The clock rotated it, not the principal whose request happened to notice the expiry.
    expect([row?.actorType, row?.actorId]).toEqual(["system", null]);
    // And the value stays out, on both sides, exactly as the console's own edit does.
    expect(
      JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain("rt-2");
    expect((row?.before as Record<string, unknown>)?.undisclosedChanged).toBe(
      true,
    );
  });

  test("scopes the grant changed upstream are recorded too", async () => {
    const id = await oauthEntry(`sco${uniq()}`, baseCred);
    await persistRefreshedOAuthSecret(
      ctx(),
      id,
      { ...baseCred, scopes: ["a", "b", "c"] },
      appDb,
    );
    expect((await rows("credential.update")).length).toBe(1);
  });

  // The stale-snapshot half, which is what the review round after the first fix found. The gate used
  // to compare with the value the CALLER decrypted, and that snapshot predates a network round trip
  // to the provider: two overlapping refreshes of the same expired credential both saw the old
  // refresh token and both recorded the same rotation. Comparing under the row lock against what is
  // STORED makes the second one a no-op, which is what "a row only when something changed" means
  // when two writers are asking.
  test("two refreshes carrying the same rotation record it once", async () => {
    const id = await oauthEntry(`twice${uniq()}`, baseCred);
    const rotated = { ...baseCred, accessToken: "at-2", refreshToken: "rt-2" };
    await persistRefreshedOAuthSecret(ctx(), id, rotated, appDb);
    await persistRefreshedOAuthSecret(ctx(), id, rotated, appDb);
    expect((await rows("credential.update")).length).toBe(1);
  });

  // A source fence, and the same instrument #395 put on `chatwoot/management.ts`: the lock this
  // module takes on `vault_entries` is what makes "compare, then write" one decision, and a lock
  // that is missing or in a DIFFERENT mode has no failing test to show it. A mixed mode is the
  // deadlock: an INSERT of a row whose foreign key points at a locked row takes `KEY SHARE`, which
  // `FOR UPDATE` conflicts with and `FOR NO KEY UPDATE` does not, so two paths in one module that
  // disagree can wait on each other over a key nobody was changing.
  test("every row lock in the vault service takes the same mode", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/vault/service.ts", import.meta.url),
    ).text();
    // Comments stripped first: this file's own NOTEs name the other mode while explaining it, and a
    // fence that counts prose reports a mode nobody takes.
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    const locks = code.match(/FOR (?:NO KEY )?UPDATE/g) ?? [];
    expect(locks.length).toBeGreaterThanOrEqual(4);
    expect(new Set(locks)).toEqual(new Set(["FOR UPDATE"]));
  });

  test("the same scopes in another order are not a change", async () => {
    const id = await oauthEntry(`ord${uniq()}`, baseCred);
    await persistRefreshedOAuthSecret(
      ctx(),
      id,
      { ...baseCred, scopes: ["b", "a"] },
      appDb,
    );
    expect(await rows()).toEqual([]);
  });

  test("creating a credential records its identity, never its value", async () => {
    await clearAudit();
    const name = `k${uniq()}`;
    const { id, ref } = await createVaultEntry(
      ctx(),
      { name, value: SECRET, kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("credential.create");
    expect(row?.target).toBe(ref);
    expect(row?.actorId).toBe(USER);
    expect(row?.actorType).toBe("user");
    expect(row?.after).toEqual({
      id: String(id),
      name,
      kind: "openai",
      status: "active",
      baseUrl: null,
      paramName: null,
    });
    await collect();
  });

  test("a reference created without a secret records itself as pending", async () => {
    await clearAudit();
    const name = `p${uniq()}`;
    const { id, ref } = await createPendingVaultEntry(
      ctx(),
      { name, kind: "openai", baseUrl: null, paramName: null },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("credential.create");
    expect(row?.target).toBe(ref);
    expect(row?.after).toEqual({
      id: String(id),
      name,
      kind: "openai",
      status: "pending",
      baseUrl: null,
      paramName: null,
    });
    await collect();
  });

  // The action with no name on any transport before this: the only MCP caller of the service is
  // `langfuse.connect`, which records its own action and not this one.
  test("replacing the value behind a live reference is recorded, as a change and not as a value", async () => {
    await clearAudit();
    const name = `u${uniq()}`;
    const { id } = await createVaultEntry(
      ctx(),
      { name, value: SECRET, kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    await clearAudit();
    await updateVaultEntry(ctx(), id, { value: NEW_SECRET }, appDb);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("credential.update");
    expect(row?.target).toBe(`vault:${id}`);
    // The marker on BOTH sides, the way #394 and #397 do it: it says a write moved something the row
    // does not show, which is a fact about the change rather than about either end of it.
    expect(row?.before).toMatchObject({ name, undisclosedChanged: true });
    expect(row?.after).toMatchObject({ name, undisclosedChanged: true });
    await collect();
  });

  test("filling a pending credential records the promotion", async () => {
    await clearAudit();
    const name = `f${uniq()}`;
    const { id } = await createPendingVaultEntry(
      ctx(),
      { name, kind: "openai", baseUrl: null, paramName: null },
      appDb,
    );
    await clearAudit();
    await updateVaultEntry(ctx(), id, { value: SECRET }, appDb);
    const [row] = await rows();
    expect(row?.action).toBe("credential.update");
    expect(row?.before).toMatchObject({ status: "pending" });
    expect(row?.after).toMatchObject({ status: "active" });
    await collect();
  });

  // `encryptJson` randomizes, so the stored blob differs on every write even for an unchanged value.
  // Comparing the column would report a rotation on every save, which is the opposite of what the
  // marker is for.
  test("re-submitting the value already stored records nothing", async () => {
    await clearAudit();
    const name = `s${uniq()}`;
    const { id } = await createVaultEntry(
      ctx(),
      { name, value: SECRET, kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    await clearAudit();
    await updateVaultEntry(ctx(), id, { value: SECRET }, appDb);
    expect(await rows()).toEqual([]);
  });

  test("a rename records both names", async () => {
    await clearAudit();
    const name = `r${uniq()}`;
    const { id } = await createVaultEntry(
      ctx(),
      { name, value: SECRET, kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    await clearAudit();
    const renamed = `${name}-novo`;
    await updateVaultEntry(ctx(), id, { name: renamed }, appDb);
    const [row] = await rows();
    expect(row?.before).toMatchObject({ name });
    expect(row?.after).toMatchObject({ name: renamed });
    // The value did not move, so the marker is absent: it is what tells a reader the secret behind
    // the reference is the one that was already there.
    expect(row?.after).not.toHaveProperty("undisclosedChanged");
    await collect();
  });

  test("a save that moves nothing records nothing", async () => {
    await clearAudit();
    const name = `n${uniq()}`;
    const { id } = await createVaultEntry(
      ctx(),
      { name, value: SECRET, kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    await clearAudit();
    await updateVaultEntry(ctx(), id, { name }, appDb);
    expect(await rows()).toEqual([]);
  });

  test("an operator-typed base URL reaches the row as its origin", async () => {
    await clearAudit();
    const name = `b${uniq()}`;
    const { id } = await createVaultEntry(
      ctx(),
      {
        name,
        value: SECRET,
        kind: "openai_compatible",
        baseUrl: "https://203.0.113.44/v1/tenant-abc",
      },
      undefined,
      undefined,
      appDb,
    );
    const [row] = await rows();
    expect(row?.after).toMatchObject({ baseUrl: "https://203.0.113.44/…" });
    expect(JSON.stringify(row?.after)).not.toContain("tenant-abc");
    await clearAudit();
    await updateVaultEntry(
      ctx(),
      id,
      { baseUrl: "https://203.0.113.45/v1/tenant-abc" },
      appDb,
    );
    const [moved] = await rows();
    // The whole value is COMPARED even though only the origin is carried, so a change that lives in
    // the path is still recorded as a change.
    expect(moved?.action).toBe("credential.update");
    await collect();
  });

  test("deleting a credential records what it was", async () => {
    await clearAudit();
    const name = `d${uniq()}`;
    const { id } = await createVaultEntry(
      ctx(),
      { name, value: SECRET, kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    await clearAudit();
    await deleteVaultEntry(ctx(), id, appDb);
    const [row] = await rows();
    expect(row?.action).toBe("credential.delete");
    expect(row?.target).toBe(`vault:${id}`);
    expect(row?.before).toMatchObject({ name, kind: "openai" });
    expect(await suDb.vaultEntry.count({ where: { id } })).toBe(0);
    await collect();
  });

  test("deleting a credential that is already gone records nothing", async () => {
    await clearAudit();
    await deleteVaultEntry(ctx(), 999_999_999n, appDb);
    expect(await rows()).toEqual([]);
  });

  // The fence, over every row this file produced. This is the family where the projection sits one
  // column away from the credential itself.
  test("no row anywhere in this family carries a secret", () => {
    expect(everyRow.length).toBeGreaterThan(6);
    const dumped = JSON.stringify(everyRow, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(NEW_SECRET);
  });
});
