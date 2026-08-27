import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn } from "@/lib/tenancy/multi-tenant";
import { seedChatwootInstance } from "../utils/chatwoot";

// Integration test for the multi-tenant isolation guarantees against a REAL Postgres
// (RLS, fail-closed, cross-tenant write block, asSuperAdmin). It mirrors the mechanism in
// src/lib/tenancy/multi-tenant.ts (closure $extends + transaction-local set_config) but
// uses its own clients so it is unaffected by the global prisma module mock other unit
// tests install. Skips when no DB is reachable (e.g. CI without the dev container).

// NOTE: tests/setup.ts overrides DATABASE_URL with a dummy to keep unit tests off any
// real DB, so the app-role connection comes from TEST_APP_DATABASE_URL instead. Bun
// expands ${POSTGRES_PORT} in .env at load time, so the values arrive resolved.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

function makeClient(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = makeClient(suUrl);
    await su.$queryRaw`SELECT 1`;
    app = makeClient(appUrl);
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

// Non-optional aliases for use inside the (skipped-when-down) describe block, avoiding
// non-null assertions; when dbUp is false the suite is skipped and these are never read.
const appDb = app as PrismaClient;

let t1 = 0n;
let t2 = 0n;

describe.skipIf(!dbUp)("tenancy isolation (RLS)", () => {
  beforeAll(async () => {
    if (!su) return;
    // Superuser bypasses RLS — seed two tenants, an instance each, a conversation each.
    const a = await su.tenant.create({
      data: { name: "ISO-A", slug: `iso-a-${process.pid}` },
    });
    const b = await su.tenant.create({
      data: { name: "ISO-B", slug: `iso-b-${process.pid}` },
    });
    t1 = a.id;
    t2 = b.id;
    for (const t of [a, b]) {
      const inst = await seedChatwootInstance(su, {
        tenantId: t.id,
        accountId: 1,
        // Distinct server per tenant: a Chatwoot account (serverKey + accountId) is globally unique
        // to one tenant, so two tenants can't share the same (server, accountId). RLS isolation —
        // what this suite tests — is unaffected by using separate servers.
        baseUrl: `https://iso-${t.id}.local`,
        adminToken: "enc",
      });
      await su.conversation.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          chatwootConversationId: 100,
          status: "pending",
          threadId: `${t.id}:${inst.id}:100`,
        },
      });
    }
  });

  afterAll(async () => {
    if (su && t1) {
      await su.$executeRawUnsafe(
        `DELETE FROM conversations WHERE tenant_id IN (${t1}, ${t2})`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id IN (${t1}, ${t2})`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN (${t1}, ${t2})`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("fail-closed: app role with no tenant GUC sees zero rows", async () => {
    const rows =
      await appDb.$queryRaw`SELECT count(*)::int AS c FROM conversations`;
    expect((rows as Array<{ c: number }>)[0]?.c).toBe(0);
  });

  test("scoped read returns only the active tenant's rows", async () => {
    const seen = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`;
      return tx.conversation.findMany({ select: { tenantId: true } });
    });
    expect(seen.length).toBe(1);
    expect(seen[0]?.tenantId).toBe(t1);
  });

  test("explicit cross-tenant WHERE is overridden by RLS (zero rows)", async () => {
    const rows = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`;
      return tx.conversation.findMany({ where: { tenantId: t2 } });
    });
    expect(rows.length).toBe(0);
  });

  test("cross-tenant write is blocked by the RLS WITH CHECK", async () => {
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`;
        const inst = await tx.chatwootInstance.findFirstOrThrow({
          select: { id: true },
        });
        // Force a row that belongs to tenant 2 while scoped to tenant 1.
        await tx.$executeRaw`
          INSERT INTO conversations
            (tenant_id, chatwoot_instance_id, chatwoot_conversation_id, status, thread_id, updated_at)
          VALUES (${t2}, ${inst.id}, 999, 'pending', 'x', now())`;
      }),
    ).rejects.toThrow();
  });

  // Through the real helper, not a copy of what it does. It used to hand-roll
  // `set_config('app.is_super_admin', ...)`, which was the same statement the helper issued — until
  // it was not: issue #382 replaced the GUC with a role, and the copy went on passing for a while
  // against a policy that no longer read it.
  test("asSuperAdmin sees every tenant's rows", async () => {
    const rows = await asSuperAdminOn(appDb, (db) =>
      db.conversation.findMany({
        where: { tenantId: { in: [t1, t2] } },
        select: { tenantId: true },
      }),
    );
    expect(rows.length).toBe(2);
  });
});
