import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { createApiKey } from "@/modules/api-keys/service";
import { auditMutation } from "@/modules/audit/service";
import {
  createBusinessHours,
  deleteBusinessHours,
  updateBusinessHours,
} from "@/modules/business-hours/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  apiKeyRevoke,
  businessHoursCreate,
  businessHoursDelete,
  businessHoursUpdate,
} from "@/modules/mcp/write-settings";
import { countingBase } from "../utils/counting-base";

// The audit trail belongs to the service, not to a transport.
//
// Every one of the 65 audited actions was written by `src/modules/mcp/write*.ts`, after the service
// it called had already committed. Two consequences this file measures rather than argues: a change
// made through any OTHER door left no row at all, and the row that WAS written could not be atomic
// with the mutation it recorded, because it lived in a second transaction.
//
// Business hours is the proving family: three mutations, three REST routes, no external effect and
// no secret in the projection, so what is being tested here is the seam and not the family.

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

const USER = 9091n;

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

const principal = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  userId: USER,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
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

describe.skipIf(!dbUp)("the audit seam records from the service", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "AUD", slug: `aud-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      for (const table of [
        "audit_logs",
        "api_keys",
        "agents",
        "business_hours",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // ── the trail follows the mutation, whichever door it came through ──

  test("creating a schedule through the service writes the row the MCP tool used to write", async () => {
    await clearAudit();
    const created = await createBusinessHours(
      ctx(),
      { name: "front desk", timezone: "America/Sao_Paulo" },
      appDb,
    );
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("business_hours.create");
    expect(row?.target).toBe(`business_hours:${created.id}`);
    expect(row?.actorId).toBe(USER);
    // No transport said so: absent on the context means the cookie session.
    expect(row?.actorType).toBe("user");
    expect(row?.after).toMatchObject({
      name: "front desk",
      timezone: "America/Sao_Paulo",
    });
  });

  test("an update carries what changed, before and after", async () => {
    const created = await createBusinessHours(
      ctx(),
      { name: "before name", timezone: "UTC" },
      appDb,
    );
    await clearAudit();
    await updateBusinessHours(
      ctx(),
      BigInt(created.id),
      { name: "after name" },
      appDb,
    );
    const [row] = await rows();
    expect(row?.action).toBe("business_hours.update");
    expect(row?.before).toMatchObject({ name: "before name" });
    expect(row?.after).toMatchObject({ name: "after name" });
  });

  test("a delete leaves the record of what was deleted", async () => {
    const created = await createBusinessHours(ctx(), { name: "doomed" }, appDb);
    await clearAudit();
    await deleteBusinessHours(ctx(), BigInt(created.id), appDb);
    const [row] = await rows();
    expect(row?.action).toBe("business_hours.delete");
    expect(row?.target).toBe(`business_hours:${created.id}`);
    expect(row?.before).toMatchObject({ name: "doomed" });
  });

  test("a refused mutation writes no row", async () => {
    await clearAudit();
    await expect(
      createBusinessHours(
        ctx(),
        { name: "bad zone", timezone: "Mars/Olympus" },
        appDb,
      ),
    ).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  // ── attribution says which door, and the action no longer does ──

  test("a Bearer API key is attributed as one, not as a browser session", async () => {
    await clearAudit();
    await createBusinessHours(
      ctx({ actorType: "api_key" }),
      { name: "by key" },
      appDb,
    );
    const [row] = await rows();
    expect(row?.actorType).toBe("api_key");
    // The SAME action either way: the action names what changed, the actor names the door.
    expect(row?.action).toBe("business_hours.create");
  });

  test("the MCP tool writes that same action, attributed to the MCP transport", async () => {
    await clearAudit();
    const res = await businessHoursCreate(
      principal(),
      { name: "by mcp", dry_run: false },
      { base: appDb },
    );
    expect(res.ok).toBe(true);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row?.action).toBe("business_hours.create");
    expect(row?.actorType).toBe("mcp");
    expect(row?.actorId).toBe(USER);
  });

  test("a dry run applies nothing and records nothing", async () => {
    await clearAudit();
    await businessHoursCreate(
      principal(),
      { name: "previewed" },
      { base: appDb },
    );
    expect(await rows()).toEqual([]);
  });

  test("the MCP update and delete write the service's actions too", async () => {
    const created = await createBusinessHours(
      ctx(),
      { name: "mcp target" },
      appDb,
    );
    await clearAudit();
    await businessHoursUpdate(
      principal(),
      { business_hours_id: created.id, name: "renamed", dry_run: false },
      { base: appDb },
    );
    await businessHoursDelete(
      principal(),
      { business_hours_id: created.id, dry_run: false },
      { base: appDb },
    );
    expect((await rows()).map((r) => r.action)).toEqual([
      "business_hours.update",
      "business_hours.delete",
    ]);
  });

  // ── the projection is bounded by the seam, not by each caller ──

  test("an oversized projection is cut here, so a service cannot forget to cut it", async () => {
    await clearAudit();
    const long = "x".repeat(9000);
    await runScopedOn(appDb, ctx(), (db) =>
      auditMutation(db, ctx(), {
        action: "business_hours.update",
        target: "business_hours:0",
        before: { nested: [{ summary: long }] },
        after: { nested: [{ summary: long }] },
      }),
    );
    const [row] = await rows();
    const cut = (side: unknown) =>
      (side as { nested: { summary: string }[] }).nested[0]?.summary as string;
    // BOTH sides: an oversized `before` is the one a delete records, and it is as capable of
    // refusing the whole row as an oversized `after`.
    for (const side of [row?.before, row?.after]) {
      expect(cut(side).length).toBeLessThan(long.length);
      expect(cut(side).endsWith("…[truncated]")).toBe(true);
    }
  });

  // ── the row and the mutation share one transaction ──

  test("applying an MCP write opens ONE transaction, so the row cannot outlive a rollback", async () => {
    const { base, total } = countingBase(appDb);
    await businessHoursCreate(
      principal(),
      { name: "one tx", dry_run: false },
      { base },
    );
    // Two before this: the service committed, and only then did the transport open its own
    // transaction for the audit row. A failure in between landed the change with no record of it.
    expect(total()).toBe(1);
  });

  // ── the service that already recorded is not recorded twice ──

  test("revoking an API key through MCP writes one row, not one per layer", async () => {
    const created = await createApiKey(ctx(), { displayName: "dup" }, appDb);
    await clearAudit();
    const res = await apiKeyRevoke(
      principal(),
      { api_key_id: created.apiKey.id, dry_run: false },
      { base: appDb },
    );
    expect(res.ok).toBe(true);
    const all = await rows();
    // `revokeApiKey` has recorded from inside its own transaction since it was written; the tool
    // recorded again on top, so the same revocation appeared twice under two different names.
    expect(all.map((r) => r.action)).toEqual(["api_key.revoke"]);
    expect(all[0]?.actorType).toBe("mcp");
  });
});
