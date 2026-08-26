import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError, NotFoundError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createIntegrationInstance,
  getIntegrationInstance,
  listIntegrationInstances,
  resolveInboundRouteByToken,
  rotateIntegrationRouteToken,
  updateIntegrationInstance,
} from "@/modules/integrations/service";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// NOTE: The inbound webhook URL is an ADDRESS the operator pastes into the provider's dashboard, so
// it has to stay readable after creation. The token is therefore persisted twice — the SHA-256 hash
// the hot inbound path probes, plus an encrypted copy for the editor — and rotation exists for the
// two cases the stored copy cannot serve: a row created before the column existed, and a leak.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("integration route token", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RT", slug: `rt-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM integration_instances WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("the created token is readable again, and only on the single-instance read", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-read",
      },
      appDb,
    );
    expect(created.routeToken).toBeTruthy();

    const one = await getIntegrationInstance(ctx(), created.id, appDb);
    expect(one.routeToken).toBe(created.routeToken as string);
    expect(one.routeTokenStatus).toBe("present");

    // NOTE: The list backs a screen that shows no URL, so it must not ship N tokens to the browser.
    const many = await listIntegrationInstances(ctx(), appDb);
    const row = many.find((i) => i.id === String(created.id));
    expect(row?.routeToken).toBeNull();
  });

  test("the stored copy is encrypted, never the plaintext", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-enc",
      },
      appDb,
    );
    const raw = await suDb.integrationInstance.findUniqueOrThrow({
      where: { id: created.id },
      select: { routeToken: true, routeTokenHash: true },
    });
    expect(raw.routeToken).not.toBe(created.routeToken);
    expect(raw.routeToken).not.toContain(created.routeToken as string);
    expect(raw.routeTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rotating mints a new token and kills the old address", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-rotate",
      },
      appDb,
    );
    const old = created.routeToken as string;
    expect(await resolveInboundRouteByToken(old, suDb)).not.toBeNull();

    const { routeToken: fresh } = await rotateIntegrationRouteToken(
      ctx(),
      created.id,
      appDb,
    );
    expect(fresh).not.toBe(old);
    // The provider must be updated: the previous URL stops resolving immediately.
    expect(await resolveInboundRouteByToken(old, suDb)).toBeNull();
    const resolved = await resolveInboundRouteByToken(fresh, suDb);
    expect(resolved?.id).toBe(created.id);
    // And the new one is readable, so the operator can copy it without the reveal modal.
    expect(
      (await getIntegrationInstance(ctx(), created.id, appDb)).routeToken,
    ).toBe(fresh);
  });

  test("an instance predating the stored copy reads null and recovers by rotating", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-legacy",
      },
      appDb,
    );
    // NOTE: Exactly the shape of a row created before the column existed: the hash still resolves
    // inbound calls, but nothing can recover the plaintext.
    await suDb.integrationInstance.update({
      where: { id: created.id },
      data: { routeToken: null },
    });
    const legacy = await getIntegrationInstance(ctx(), created.id, appDb);
    expect(legacy.routeToken).toBeNull();
    expect(legacy.routeTokenStatus).toBe("absent");

    const { routeToken } = await rotateIntegrationRouteToken(
      ctx(),
      created.id,
      appDb,
    );
    expect(
      (await getIntegrationInstance(ctx(), created.id, appDb)).routeToken,
    ).toBe(routeToken);
  });

  test("a blob the key cannot read is 'unreadable', never confused with 'absent'", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      { catalogType: "ASAAS", name: "asaas-corrupt" },
      appDb,
    );
    // NOTE: A blob that survives storage but fails authentication — what an ENCRYPTION_KEY rotation
    // leaves behind. Collapsing this into "absent" would tell the operator the row predates the
    // feature and send them hunting in the wrong place; both still recover by rotating.
    await suDb.integrationInstance.update({
      where: { id: created.id },
      data: { routeToken: "bm90LWEtcmVhbC1ibG9i" },
    });
    const broken = await getIntegrationInstance(ctx(), created.id, appDb);
    expect(broken.routeToken).toBeNull();
    expect(broken.routeTokenStatus).toBe("unreadable");

    // The read stays usable — a corrupt blob must not take the whole editor down with it.
    expect(broken.name).toBe("asaas-corrupt");

    const { routeToken } = await rotateIntegrationRouteToken(
      ctx(),
      created.id,
      appDb,
    );
    const healed = await getIntegrationInstance(ctx(), created.id, appDb);
    expect(healed.routeToken).toBe(routeToken);
    expect(healed.routeTokenStatus).toBe("present");
  });

  test("an outbound-only integration has no URL and cannot be rotated", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "GOOGLE_CALENDAR",
        name: "cal",
      },
      appDb,
    );
    expect(created.routeToken).toBeNull();
    expect(
      (await getIntegrationInstance(ctx(), created.id, appDb)).routeToken,
    ).toBeNull();
    await expect(
      rotateIntegrationRouteToken(ctx(), created.id, appDb),
    ).rejects.toBeInstanceOf(AppError);
  });

  // Issue #362. Two of `config`'s keys are read back as HEADER NAMES, and nothing between the
  // operator's JSON and `request.headers.get` asked whether they are ones — so a trailing space
  // answered every delivery 500 instead of the uniform 401, and the provider retried a request that
  // could never succeed. Refused rather than trimmed, the call issue #340 made for vault values:
  // `x tok` has to be refused regardless of trimming, and the operator typing into raw JSON has no
  // other feedback.
  const unusable = [
    "asaas-access-token ",
    " x-tok",
    "x tok",
    "x-tök",
    "x\ntok",
  ];

  for (const value of unusable) {
    test(`create refuses config.authHeader ${JSON.stringify(value)}`, async () => {
      const err = await createIntegrationInstance(
        ctxOf(tenantId),
        {
          catalogType: "ASAAS",
          name: `hdr-${value.length}-${Math.trunc(value.charCodeAt(0))}`,
          config: { authHeader: value },
        },
        appDb,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      // The sentence itself names the key: `AppError.field` does not survive the MCP writer, which
      // sends `e.message` alone.
      expect((err as AppError).message).toContain("config.authHeader");
    });
  }

  test("create refuses config.signatureHeader too, on the same rule", async () => {
    const err = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "hdr-sig",
        config: { signatureHeader: "x-sig " },
      },
      appDb,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain("config.signatureHeader");
  });

  test("update refuses it as well, so an instance cannot be edited into it", async () => {
    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      { catalogType: "ASAAS", name: "hdr-editable" },
      appDb,
    );
    const err = await updateIntegrationInstance(
      ctxOf(tenantId),
      created.id,
      { config: { authHeader: "asaas-access-token " } },
      appDb,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
  });

  // The controls, and they are what say the rule is about the NAME. A legal custom name is the whole
  // reason the field exists (Asaas fixes its own), and the punctuation RFC 7230 allows is not
  // exotic — refusing `x_tok` would break instances that work today.
  test("a legal header name still saves, punctuation included", async () => {
    for (const value of ["asaas-access-token", "x_tok", "x.tok", "x|tok"]) {
      const created = await createIntegrationInstance(
        ctxOf(tenantId),
        {
          catalogType: "ASAAS",
          name: `hdr-ok-${value}`,
          config: { authHeader: value },
        },
        appDb,
      );
      expect(created.id).toBeDefined();
    }
  });

  // A key holding something that is not a string is ignored by the reader, which falls back to the
  // catalog's name and then ours. That is documented behaviour and rows already carry it, so
  // refusing it here would turn an existing instance's next unrelated save into a 400.
  test("a non-string under the same key is left alone, not refused", async () => {
    const objectValued = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "hdr-object",
        config: { authHeader: { a: 1 } },
      },
      appDb,
    );
    expect(objectValued.id).toBeDefined();

    const created = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "hdr-nonstring",
        // `{}` is the case that says the rule reads a STRING rather than whatever String() would
        // make of the value: `[object Object]` has spaces in it, so a guard that coerced instead of
        // narrowing would refuse this one.
        config: { authHeader: 42, signatureHeader: null, extra: { a: 1 } },
      },
      appDb,
    );
    expect(created.id).toBeDefined();
  });

  test("rotating an unknown instance is a 404, not a silent mint", async () => {
    await expect(
      rotateIntegrationRouteToken(ctx(), 999999999n, appDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
