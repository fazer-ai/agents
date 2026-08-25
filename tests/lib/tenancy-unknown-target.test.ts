import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient as PrismaClientType } from "@/../generated/prisma/client";
import { PrismaClient } from "@/../generated/prisma/client";
import { ActiveTenantNotFoundError, AppError } from "@/lib/errors";
import {
  resolveRequestTenantContext,
  runScopedOn,
  type TenantContext,
} from "@/lib/tenancy";
import {
  getTenantSettings,
  updateLangfuse,
} from "@/modules/tenant-settings/service";

// A SUPER_ADMIN's target tenant is chosen per request, by a selector the browser persists, so it can
// outlive the tenant it names. Unverified, that id was not an error anywhere: RLS scoped the
// transaction to a tenant with no rows, so a READ answered with defaults (a settings screen full of
// empty fields, looking healthy) and a WRITE reached Prisma and failed on the missing row, with no
// AppError to carry a reason to the operator. Issue #223.
//
// The check lives at `runScopedOn` because that is the single boundary a tenant-scoped statement can
// reach the database through, so one gate covers every endpoint rather than the 53 places that ask
// whether a target is present. It is keyed on the ROLE because that is exactly what separates an id
// that came from outside from one this process read from a row: every context built internally (the
// webhook receiver, the scheduler, the graph) carries TENANT_ADMIN.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

// Outside the describe on purpose. Both clients are opened while probing, and a probe that gets the
// first one up and fails on the second never runs a hook inside a skipped describe, so the pool it
// did open would stay open for the rest of the suite.
afterAll(async () => {
  await su?.$disconnect();
  await app?.$disconnect();
});

let liveId = 0n;
let deadId = 0n;

// The context the REST boundary actually builds, rather than one written by hand here: the selector
// is a header string, and what turns it into a tenantId is the function under the endpoint.
function ctxFromSelector(tenantId: bigint): TenantContext {
  const { context } = resolveRequestTenantContext(
    { id: 1n, tenantId: null, role: "SUPER_ADMIN" },
    String(tenantId),
  );
  if (!context) throw new Error("the boundary refused a SUPER_ADMIN principal");
  return context;
}

// Counts the existence check itself, so "the hot path does not pay for this" is measured rather than
// asserted. The scoped extension `runScopedOn` adds sits on top of this one; both hooks run.
function counting(base: PrismaClient) {
  const seen = { tenantFindUnique: 0 };
  const client = base.$extends({
    query: {
      tenant: {
        findUnique({ args, query }) {
          seen.tenantFindUnique += 1;
          return query(args);
        },
      },
    },
  });
  return { client: client as unknown as PrismaClientType, seen };
}

describe.skipIf(!dbUp)("a tenant selector that names no tenant", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "UnknownTarget", slug: `ut-${process.pid}` },
    });
    liveId = t.id;
    const max = await suDb.$queryRaw<
      { m: bigint | null }[]
    >`SELECT MAX(id) AS m FROM tenants`;
    // Well-formed and unused: the shape a stored selection takes after its tenant is deleted.
    deadId = (max[0]?.m ?? 0n) + 1_000_000n;
  });

  afterAll(async () => {
    if (liveId) await suDb.tenant.deleteMany({ where: { id: liveId } });
  });

  test("runScopedOn refuses it, and the callback never runs", async () => {
    let ran = false;
    const err = await runScopedOn(appDb, ctxFromSelector(deadId), async () => {
      ran = true;
    }).catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(err instanceof AppError).toBe(true);
    const app_err = err as AppError;
    expect(app_err.statusCode).toBe(404);
    // The key the MCP selector and GET /v1/tenants/:id already answer with, so the console shows one
    // sentence for one fact whichever transport asked.
    expect(app_err.translationKey).toBe("errors.tenantNotFound");
    // And the class that separates this refusal from those: same status, same key, same sentence,
    // and the only one of the seven that is about the selector the CALLER WAS CARRYING. It names the
    // id it refused so the boundary can put it on the wire for the console to match against what it
    // has stored (src/lib/console-params.ts). Issue #252.
    expect(err instanceof ActiveTenantNotFoundError).toBe(true);
    expect((err as ActiveTenantNotFoundError).rejectedTenantId).toBe(
      String(deadId),
    );
  });

  test("a live target still runs, and pays exactly one statement for the check", async () => {
    const { client, seen } = counting(appDb);
    const out = await runScopedOn(
      client,
      ctxFromSelector(liveId),
      async () => "ok",
    );
    expect(out).toBe("ok");
    expect(seen.tenantFindUnique).toBe(1);
  });

  test("an internally built context is not checked at all", async () => {
    const { client, seen } = counting(appDb);
    // The shape every webhook/scheduler/graph context has: a tenant id this process read from a row.
    const internal: TenantContext = {
      tenantId: deadId,
      userId: null,
      role: "TENANT_ADMIN",
    };
    const out = await runScopedOn(client, internal, async () => "ok");
    expect(out).toBe("ok");
    expect(seen.tenantFindUnique).toBe(0);
  });

  // The issue's own reproduction, on the two endpoints it names. Both halves used to answer without
  // an error: the read looked like a tenant that simply had no settings yet.
  test("the settings read stops answering with defaults", async () => {
    const err = await getTenantSettings(ctxFromSelector(deadId), appDb).catch(
      (e: unknown) => e,
    );
    expect(err instanceof AppError).toBe(true);
    expect((err as AppError).statusCode).toBe(404);
  });

  test("the settings write stops answering 500", async () => {
    const err = await updateLangfuse(
      ctxFromSelector(deadId),
      { enabled: true },
      appDb,
    ).catch((e: unknown) => e);
    // Before: a raw Prisma P2025, which is not an AppError, so `onError` fell through to the generic
    // branch and answered 500 with a plain-text body the console cannot show a reason from.
    expect(err instanceof AppError).toBe(true);
    expect((err as AppError).statusCode).toBe(404);
  });

  test("a live target reads and writes as before", async () => {
    const before = await getTenantSettings(ctxFromSelector(liveId), appDb);
    expect(before.langfuse.enabled).toBe(false);
    const after = await updateLangfuse(
      ctxFromSelector(liveId),
      { enabled: true },
      appDb,
    );
    expect(after.enabled).toBe(true);
  });
});
