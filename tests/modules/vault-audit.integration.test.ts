import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { recordAudit } from "@/modules/audit/service";
import {
  createVaultEntry,
  formatVaultRef,
  listVaultInfos,
  resolveVaultEntry,
  resolveVaultSecret,
  tryResolveVaultSecret,
  updateVaultEntry,
  vaultReferences,
} from "@/modules/vault/service";
import { syntheticAction } from "../utils/audit-action";

// Integration test for the Phase 2 primitives (vault round-trip, audit row, entity lock)
// against a real Postgres under a tenant-scoped transaction. Uses its own app-role client
// (TEST_APP_DATABASE_URL) so it is unaffected by the global prisma mock; skips when no DB.

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
let tenantId = 0n;

// Runs fn inside a real tenant-scoped transaction via the library, but bound to this
// test's own client (so the global prisma mock other unit tests install does not apply).
function scoped<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T> {
  return runScopedOn(
    appDb,
    { tenantId, userId: null, role: "TENANT_ADMIN" },
    fn,
  );
}

describe.skipIf(!dbUp)("phase-2 primitives", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "P2", slug: `p2-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("vault: create, resolve, update value and delete a secret", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const { id, ref } = await createVaultEntry(
      ctx,
      { name: "asaas-token", value: "sk_1" },
      undefined,
      undefined,
      appDb,
    );
    const got = await scoped((db) => resolveVaultSecret<string>(db, ref));
    expect(got).toBe("sk_1");

    await updateVaultEntry(ctx, id, { value: "sk_2" }, appDb);
    const updated = await scoped((db) => resolveVaultSecret<string>(db, ref));
    expect(updated).toBe("sk_2");

    // Direct delete via scoped db.
    await scoped((db) => db.vaultEntry.deleteMany({ where: { id } }));
    const gone = await scoped((db) => tryResolveVaultSecret(db, ref));
    expect(gone).toBeNull();
  });

  test("vault: updateVaultEntry keeps the id (refs unaffected) and enforces uniqueness", async () => {
    const ctx = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN" as const,
    };
    const { id } = await createVaultEntry(
      ctx,
      { name: "rename-src", value: "sk_r" },
      undefined,
      undefined,
      appDb,
    );
    await createVaultEntry(
      ctx,
      { name: "rename-taken", value: "sk_t" },
      undefined,
      undefined,
      appDb,
    );

    // Renaming returns the SAME id — the stored `vault:<id>` ref never changes.
    const sameId = await updateVaultEntry(
      ctx,
      id,
      { name: "rename-dst" },
      appDb,
    );
    expect(sameId).toBe(id);

    // The secret still resolves by its (unchanged) ref.
    const got = await scoped((db) =>
      resolveVaultSecret<string>(db, `vault:${id}`),
    );
    expect(got).toBe("sk_r");

    // The entry now lists under the new name; the old name is gone.
    const names = (await scoped((db) => listVaultInfos(db))).map((i) => i.name);
    expect(names).toContain("rename-dst");
    expect(names).not.toContain("rename-src");

    // Renaming onto an existing name is a conflict.
    await expect(
      updateVaultEntry(ctx, id, { name: "rename-taken" }, appDb),
    ).rejects.toThrow();

    // Updating a missing id is a not-found.
    await expect(
      updateVaultEntry(ctx, -1n, { name: "whatever" }, appDb),
    ).rejects.toThrow();
  });

  test("vault: updateVaultEntry can change name and value together", async () => {
    const ctx = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN" as const,
    };
    const { id } = await createVaultEntry(
      ctx,
      { name: "patch-both-src", value: "old-secret" },
      undefined,
      undefined,
      appDb,
    );

    await updateVaultEntry(
      ctx,
      id,
      { name: "patch-both-dst", value: "new-secret" },
      appDb,
    );

    const resolved = await scoped((db) =>
      resolveVaultSecret<string>(db, `vault:${id}`),
    );
    expect(resolved).toBe("new-secret");

    const names = (await scoped((db) => listVaultInfos(db))).map((i) => i.name);
    expect(names).toContain("patch-both-dst");
    expect(names).not.toContain("patch-both-src");
  });

  test("vault: name with spaces and accents is valid", async () => {
    const ctx = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN" as const,
    };
    const { id } = await createVaultEntry(
      ctx,
      "Chave OpenAI produção",
      "sk_prod",
      null,
      appDb,
    );
    const resolved = await scoped((db) =>
      resolveVaultSecret<string>(db, `vault:${id}`),
    );
    expect(resolved).toBe("sk_prod");
    const names = (await scoped((db) => listVaultInfos(db))).map((i) => i.name);
    expect(names).toContain("Chave OpenAI produção");
  });

  test("vault: create 409 on duplicate (name+kind); same name different kinds coexist", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    const { id: id1 } = await createVaultEntry(
      ctx,
      { name: "kind-locked", value: "sk-k1", kind: "openai" },
      undefined,
      undefined,
      appDb,
    );

    // Same name + same kind → 409 conflict.
    await expect(
      createVaultEntry(
        ctx,
        { name: "kind-locked", value: "sk-k2", kind: "openai" },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();

    // Update in place via updateVaultEntry (value rotation keeps same id).
    await updateVaultEntry(ctx, id1, { value: "sk-k2" }, appDb);
    const after = (await scoped((db) => listVaultInfos(db))).find(
      (i) => i.name === "kind-locked" && i.kind === "openai",
    );
    expect(after?.id).toBe(String(id1));

    // Different kind creates a SEPARATE entry (same name, other kind).
    const { id: id2 } = await createVaultEntry(
      ctx,
      { name: "kind-locked", value: "sk-k4", kind: "anthropic" },
      undefined,
      undefined,
      appDb,
    );
    expect(id2).not.toBe(id1);
    const infos = (await scoped((db) => listVaultInfos(db))).filter(
      (i) => i.name === "kind-locked",
    );
    expect(infos).toHaveLength(2);
    expect(infos.map((i) => i.kind).sort()).toEqual(["anthropic", "openai"]);

    // The original openai entry is unchanged (value was rotated to sk-k2).
    const got = await scoped((db) =>
      resolveVaultSecret<string>(db, `vault:${id1}`),
    );
    expect(got).toBe("sk-k2");
  });

  test("vault: name+kind uniqueness — same name different kinds coexist; same name+kind conflicts", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    // (a) Same name, different kinds → both created, no conflict.
    const { id: idA1 } = await createVaultEntry(
      ctx,
      "multi-kind",
      "val-generic",
      null,
      appDb,
    );
    const { id: idA2 } = await createVaultEntry(
      ctx,
      "multi-kind",
      "val-openai",
      "openai",
      appDb,
    );
    expect(idA1).not.toBe(idA2);
    const listed = (await scoped((db) => listVaultInfos(db))).filter(
      (i) => i.name === "multi-kind",
    );
    expect(listed).toHaveLength(2);

    // (b) Same name AND same kind → 409 conflict.
    await expect(
      createVaultEntry(ctx, "multi-kind", "val-dup", null, appDb),
    ).rejects.toThrow();

    // (c) Rename to a name that exists in ANOTHER kind → allowed.
    const { id: idC } = await createVaultEntry(
      ctx,
      "rename-cross-kind-src",
      "val-c",
      "anthropic",
      appDb,
    );
    await createVaultEntry(
      ctx,
      "rename-cross-kind-dst",
      "val-c-dst",
      "openai",
      appDb,
    );
    // "rename-cross-kind-dst" exists but only with kind "openai"; renaming idC (kind "anthropic")
    // to that name is fine because the (name, kind) pair ("rename-cross-kind-dst", "anthropic")
    // is not taken.
    const sameId = await updateVaultEntry(
      ctx,
      idC,
      { name: "rename-cross-kind-dst" },
      appDb,
    );
    expect(sameId).toBe(idC);

    // (d) Rename to name+kind matching another entry → 409.
    const { id: idD1 } = await createVaultEntry(
      ctx,
      "rename-conflict-src",
      "val-d1",
      "openai",
      appDb,
    );
    await createVaultEntry(
      ctx,
      "rename-conflict-dst",
      "val-d2",
      "openai",
      appDb,
    );
    await expect(
      updateVaultEntry(ctx, idD1, { name: "rename-conflict-dst" }, appDb),
    ).rejects.toThrow();
  });

  test("vault: resolving a missing secret throws", async () => {
    await expect(
      scoped((db) => resolveVaultSecret(db, "does-not-exist")),
    ).rejects.toThrow();
  });

  test("vaultReferences: surfaces tenant-settings (embedding/langfuse) usage", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const { id } = await createVaultEntry(
      ctx,
      { name: "refs-tenant", value: "sk_x" },
      undefined,
      undefined,
      appDb,
    );
    const ref = formatVaultRef(id);

    // Unused at first: not referenced anywhere.
    const before = await vaultReferences(ctx, id, appDb);
    expect(before.agents).toEqual([]);

    // Point both tenant-level singletons at this entry (su bypasses RLS).
    await su?.tenant.update({
      where: { id: tenantId },
      data: {
        settings: {
          embedding: { credentialRef: ref },
          langfuse: { credentialRef: ref },
        },
      },
    });

    const after = await vaultReferences(ctx, id, appDb);
    expect(after.tenantSettings).toEqual(["embedding", "langfuse"]);

    // A different (nonexistent) id returns an empty object without throwing.
    const other = await vaultReferences(ctx, -999n, appDb);
    expect(other.toolDefinitions).toEqual([]);
    expect(other.tenantSettings).toEqual([]);
  });

  test("audit: records a row scoped to the tenant", async () => {
    // A synthetic action, because this asserts RLS scoping and nothing about the vocabulary. It used
    // to borrow `tenant.update`, which is Full-only: once `AuditEntry.action` became `AuditAction`,
    // this file stopped compiling in the Free tree while the master tree stayed green -- caught by
    // `bun run build:free`, which is the only check that reads the derived tree.
    const ACTION = syntheticAction("vault_audit.scoped");
    await scoped((db) =>
      recordAudit(db, tenantId, {
        action: ACTION,
        target: "settings",
        after: { demoMode: true },
      }),
    );
    const rows = await scoped((db) =>
      db.auditLog.findMany({ where: { action: ACTION } }),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenantId).toBe(tenantId);
  });

  test("withEntityLock runs the body inside the scoped tx", async () => {
    const { result, lockedId } = await scoped((db) =>
      withEntityLock(db, `tenant:${tenantId}:demo`, async () => {
        // Use db directly (already inside the scoped tx) to avoid a nested transaction.
        const created = await db.vaultEntry.create({
          data: {
            tenantId,
            name: "locked",
            secret: encryptJson({ v: 1 }),
            kind: "generic",
          },
          select: { id: true },
        });
        return { result: "done", lockedId: created.id };
      }),
    );
    expect(result).toBe("done");
    const v = await scoped((db) =>
      resolveVaultSecret<{ v: number }>(db, `vault:${lockedId}`),
    );
    expect(v.v).toBe(1);
  });

  // ── baseUrl / paramName / multi-field (langfuse) tests ──

  test("vault: list returns baseUrl and paramName", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const { id } = await createVaultEntry(
      ctx,
      {
        name: "hdr-key-list",
        value: "secret123",
        kind: "header",
        paramName: "X-My-Key",
        baseUrl: "https://api.example.com/",
      },
      undefined,
      undefined,
      appDb,
    );
    const infos = await scoped((db) => listVaultInfos(db));
    const entry = infos.find((i) => i.id === String(id));
    expect(entry).toBeDefined();
    expect(entry?.paramName).toBe("X-My-Key");
    expect(entry?.baseUrl).toBe("https://api.example.com");
  });

  test("vault: resolveVaultEntry returns secret, kind, baseUrl, paramName", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const { id, ref } = await createVaultEntry(
      ctx,
      {
        name: "resolve-full",
        value: "full-secret",
        kind: "header",
        paramName: "X-Full-Key",
        baseUrl: "https://full.example.com",
      },
      undefined,
      undefined,
      appDb,
    );
    const resolved = await scoped((db) => resolveVaultEntry(db, ref));
    expect(resolved.secret).toBe("full-secret");
    expect(resolved.kind).toBe("header");
    expect(resolved.baseUrl).toBe("https://full.example.com");
    expect(resolved.paramName).toBe("X-Full-Key");
    expect(resolved.name).toBe("resolve-full");

    // Throws for a missing ref.
    await expect(
      scoped((db) => resolveVaultEntry(db, `vault:${id + 999999n}`)),
    ).rejects.toThrow();
  });

  test("vault: paramName is required for header/query kinds", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    await expect(
      createVaultEntry(
        ctx,
        { name: "missing-param", value: "secret", kind: "header" },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();
    await expect(
      createVaultEntry(
        ctx,
        { name: "missing-param-q", value: "secret", kind: "query" },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("vault: paramName with invalid characters is rejected", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    await expect(
      createVaultEntry(
        ctx,
        {
          name: "bad-param",
          value: "secret",
          kind: "header",
          paramName: "X My Header",
        },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("vault: baseUrl is validated and trailing slash is stripped", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    // Invalid URL (not http/https).
    await expect(
      createVaultEntry(
        ctx,
        {
          name: "bad-url",
          value: "secret",
          kind: "bearer_token",
          baseUrl: "ftp://example.com",
        },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();

    // Trailing slash stripped on valid URL.
    const { id } = await createVaultEntry(
      ctx,
      {
        name: "trailing-slash",
        value: "tok",
        kind: "bearer_token",
        baseUrl: "https://api.example.com/v1/",
      },
      undefined,
      undefined,
      appDb,
    );
    const infos = await scoped((db) => listVaultInfos(db));
    const entry = infos.find((i) => i.id === String(id));
    expect(entry?.baseUrl).toBe("https://api.example.com/v1");
  });

  test("vault: updateVaultEntry with baseUrl=null clears the field", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const { id } = await createVaultEntry(
      ctx,
      {
        name: "clear-base",
        value: "tok",
        kind: "bearer_token",
        baseUrl: "https://old.example.com",
      },
      undefined,
      undefined,
      appDb,
    );
    await updateVaultEntry(ctx, id, { baseUrl: null }, appDb);
    const infos = await scoped((db) => listVaultInfos(db));
    const entry = infos.find((i) => i.id === String(id));
    expect(entry?.baseUrl).toBeNull();
  });

  test("vault: langfuse kind requires object {publicKey, secretKey} and rejects a plain string", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    // Valid: object with both required fields.
    const { id } = await createVaultEntry(
      ctx,
      {
        name: "langfuse-cred",
        value: { publicKey: "pk-123", secretKey: "sk-456" },
        kind: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
      },
      undefined,
      undefined,
      appDb,
    );
    const infos = await scoped((db) => listVaultInfos(db));
    expect(infos.find((i) => i.id === String(id))).toBeDefined();

    // Rejects plain string for langfuse.
    await expect(
      createVaultEntry(
        ctx,
        {
          name: "langfuse-bad-string",
          value: "some-string",
          kind: "langfuse",
        },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("vault: generic/bearer kinds reject object value", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    await expect(
      createVaultEntry(
        ctx,
        {
          name: "bad-obj-value",
          value: { key: "val" } as unknown as string,
          kind: "bearer_token",
        },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("vault: requiresBaseUrl kinds reject create without baseUrl", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    await expect(
      createVaultEntry(
        ctx,
        { name: "cw-no-base", value: "tok", kind: "chatwoot_api_token" },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow("baseUrl is required for this credential type");

    await expect(
      createVaultEntry(
        ctx,
        { name: "oc-no-base", value: "tok", kind: "openai_compatible" },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow("baseUrl is required for this credential type");

    await expect(
      createVaultEntry(
        ctx,
        {
          name: "lf-no-base",
          value: { publicKey: "pk-1", secretKey: "sk-1" },
          kind: "langfuse",
        },
        undefined,
        undefined,
        appDb,
      ),
    ).rejects.toThrow("baseUrl is required for this credential type");
  });

  test("vault: requiresBaseUrl kinds accept create with baseUrl", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    const { id: cwId } = await createVaultEntry(
      ctx,
      {
        name: "cw-with-base",
        value: "tok",
        kind: "chatwoot_api_token",
        baseUrl: "https://chat.example.com",
      },
      undefined,
      undefined,
      appDb,
    );
    expect(cwId).toBeDefined();

    const { id: ocId } = await createVaultEntry(
      ctx,
      {
        name: "oc-with-base",
        value: "tok",
        kind: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
      },
      undefined,
      undefined,
      appDb,
    );
    expect(ocId).toBeDefined();

    const { id: lfId } = await createVaultEntry(
      ctx,
      {
        name: "lf-with-base",
        value: { publicKey: "pk-2", secretKey: "sk-2" },
        kind: "langfuse",
        baseUrl: "https://us.cloud.langfuse.com",
      },
      undefined,
      undefined,
      appDb,
    );
    expect(lfId).toBeDefined();
  });

  test("vault: requiresBaseUrl kinds reject update that clears baseUrl", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    const { id } = await createVaultEntry(
      ctx,
      {
        name: "cw-clear-base",
        value: "tok",
        kind: "chatwoot_api_token",
        baseUrl: "https://chat.example.com",
      },
      undefined,
      undefined,
      appDb,
    );

    await expect(
      updateVaultEntry(ctx, id, { baseUrl: null }, appDb),
    ).rejects.toThrow("baseUrl is required for this credential type");

    await expect(
      updateVaultEntry(ctx, id, { baseUrl: "" }, appDb),
    ).rejects.toThrow("baseUrl is required for this credential type");
  });

  test("vault: requiresBaseUrl kinds accept update that changes baseUrl to another URL", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    const { id } = await createVaultEntry(
      ctx,
      {
        name: "oc-change-base",
        value: "tok",
        kind: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
      },
      undefined,
      undefined,
      appDb,
    );

    const sameId = await updateVaultEntry(
      ctx,
      id,
      { baseUrl: "https://api2.example.com/v1" },
      appDb,
    );
    expect(sameId).toBe(id);
  });

  test("vault: non-requiresBaseUrl kinds continue accepting missing/empty baseUrl", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };

    const { id: id1 } = await createVaultEntry(
      ctx,
      { name: "bearer-no-base", value: "tok", kind: "bearer_token" },
      undefined,
      undefined,
      appDb,
    );
    expect(id1).toBeDefined();

    const { id: id2 } = await createVaultEntry(
      ctx,
      { name: "openai-no-base", value: "sk-tok", kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    expect(id2).toBeDefined();

    const sameId = await updateVaultEntry(ctx, id1, { baseUrl: null }, appDb);
    expect(sameId).toBe(id1);
  });
});
