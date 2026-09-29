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

// A SUPER_ADMIN's target tenant comes from a selector the browser persists, so it can outlive the
// tenant it names. Unchecked, RLS scopes to a tenant with no rows: a read answers with defaults and a
// write fails in Prisma with no AppError. The check sits at `runScopedOn`, the one boundary every
// tenant-scoped statement crosses, rather than at each endpoint that asks for a target. It is keyed
// on the ROLE: every internally built context (webhook, scheduler, graph) carries TENANT_ADMIN.

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
    // NOTE: well-formed and unused: the shape a stored selection takes after its tenant is deleted.
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
    // NOTE: the key the MCP selector and GET /v1/tenants/:id answer with, so the console shows one
    // sentence for one fact whichever transport asked.
    expect(app_err.translationKey).toBe("errors.tenantNotFound");
    // NOTE: the class is what separates this refusal from the others with the same key: it is about
    // the selector the CALLER carried, and names the refused id so the console can match it against
    // what it stored (src/lib/console-params.ts).
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
    // NOTE: the shape every webhook/scheduler/graph context has: a tenant id this process read from a row.
    const internal: TenantContext = {
      tenantId: deadId,
      userId: null,
      role: "TENANT_ADMIN",
    };
    const out = await runScopedOn(client, internal, async () => "ok");
    expect(out).toBe("ok");
    expect(seen.tenantFindUnique).toBe(0);
  });

  // NOTE: without the check, the read looks like a tenant that simply has no settings yet.
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
    // NOTE: a raw Prisma P2025 is not an AppError, so `onError` would answer 500 with a plain-text
    // body the console cannot show a reason from.
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
