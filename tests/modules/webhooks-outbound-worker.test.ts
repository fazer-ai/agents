import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  DELIVERY_HEADER,
  LEGACY_DELIVERY_HEADER,
  LEGACY_SIGNATURE_HEADER,
  LEGACY_TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyOutboundSignature,
} from "@/modules/webhooks/outbound/signing";
import { processOutboundBatch } from "@/modules/webhooks/outbound/worker";

// ── integration (real DB) ──
// Uses the non-superuser app role for processOutboundBatch (realistic RLS: the claim runs
// under asSuperAdmin/is_super_admin, outcomes under the tenant scope) and the superuser
// client for fixtures/teardown. Network is stubbed (fetchImpl) and SSRF is bypassed
// (assertSafe) except where a test exercises the real guard.
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

const SECRET = "outbound-signing-secret";
const passthroughSafe = async (u: string) => new URL(u);
const stubFetch = (status: number) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { status } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

let tenantId = 0n;
let signedSubId = 0n;
let unsignedSubId = 0n;
let disabledSubId = 0n;

async function seedDelivery(data: {
  subscriptionId: bigint;
  status?: "PENDING" | "SENDING";
  attempts?: number;
  nextAttemptAt?: Date | null;
}): Promise<bigint> {
  const row = await suDb.outboundWebhookDelivery.create({
    data: {
      tenantId,
      subscriptionId: data.subscriptionId,
      event: "conversion",
      payload: { value: 42 },
      status: data.status ?? "PENDING",
      attempts: data.attempts ?? 0,
      nextAttemptAt: data.nextAttemptAt ?? null,
    },
  });
  return row.id;
}

const readDelivery = (id: bigint) =>
  suDb.outboundWebhookDelivery.findUniqueOrThrow({ where: { id } });

describe.skipIf(!dbUp)("outbound delivery worker", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "WHW", slug: `whw-${process.pid}` },
    });
    tenantId = t.id;
    const whSecret = await suDb.vaultEntry.create({
      data: { tenantId, name: "wh-secret", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const signed = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/signed",
        secretRef: `vault:${whSecret.id}`,
        events: ["conversion"],
        enabled: true,
      },
    });
    signedSubId = signed.id;
    const unsigned = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/unsigned",
        events: ["conversion"],
        enabled: true,
      },
    });
    unsignedSubId = unsigned.id;
    const disabled = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/disabled",
        events: ["conversion"],
        enabled: false,
      },
    });
    disabledSubId = disabled.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM outbound_webhook_deliveries WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM webhook_subscriptions WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("delivers a 2xx response and marks DELIVERED", async () => {
    const id = await seedDelivery({ subscriptionId: unsignedSubId });
    const { fetchImpl } = stubFetch(200);
    const summary = await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(summary.delivered).toBeGreaterThanOrEqual(1);
    const row = await readDelivery(id);
    expect(row.status).toBe("DELIVERED");
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });

  test("signs the request with the per-tenant vault secret", async () => {
    const id = await seedDelivery({ subscriptionId: signedSubId });
    const { fetchImpl, calls } = stubFetch(200);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const call = calls.find(
      (c) =>
        (c.init?.headers as Record<string, string>)?.[DELIVERY_HEADER] ===
        String(id),
    );
    expect(call).toBeDefined();
    const headers = call?.init?.headers as Record<string, string>;
    const body = call?.init?.body as string;
    const ts = Number(headers[TIMESTAMP_HEADER]);
    expect(
      verifyOutboundSignature(
        SECRET,
        ts,
        body,
        headers[SIGNATURE_HEADER] ?? "",
      ),
    ).toBe(true);
    expect(await readDelivery(id)).toMatchObject({ status: "DELIVERED" });
  });

  // Brand rename compatibility window, asserted on what actually leaves the worker: an operator's
  // receiver is keyed on the pre-rename header names and we cannot reach it to reconfigure. Both
  // sets must be on the wire, with identical values. Dropped at 2.0.
  test("puts both the current and the pre-rename header names on the wire", async () => {
    const id = await seedDelivery({ subscriptionId: signedSubId });
    const { fetchImpl, calls } = stubFetch(200);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const call = calls.find(
      (c) =>
        (c.init?.headers as Record<string, string>)?.[DELIVERY_HEADER] ===
        String(id),
    );
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers[LEGACY_DELIVERY_HEADER]).toBe(String(id));
    expect(headers[LEGACY_SIGNATURE_HEADER]).toBe(headers[SIGNATURE_HEADER]);
    expect(headers[LEGACY_TIMESTAMP_HEADER]).toBe(headers[TIMESTAMP_HEADER]);
    // A receiver still verifying under the old names gets a signature that checks out.
    expect(
      verifyOutboundSignature(
        SECRET,
        Number(headers[LEGACY_TIMESTAMP_HEADER]),
        call?.init?.body as string,
        headers[LEGACY_SIGNATURE_HEADER] ?? "",
      ),
    ).toBe(true);
  });

  test("retries a non-2xx response with backoff", async () => {
    const id = await seedDelivery({ subscriptionId: unsignedSubId });
    const { fetchImpl } = stubFetch(500);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const row = await readDelivery(id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.lastError).toContain("500");
  });

  // Issue #243. The remote endpoint's own error message is what lands in `last_error`, and a `text`
  // column refuses a NUL outright. Refused, the whole retry write is refused with it: the row keeps
  // its SENDING claim and its attempt count, so nothing re-drives it and nothing dead-letters it.
  test("retries a transport failure whose message carries a NUL", async () => {
    const id = await seedDelivery({ subscriptionId: unsignedSubId });
    const fetchImpl = (async () => {
      throw new Error(`socket hang up ${String.fromCharCode(0)} (ECONNRESET)`);
    }) as unknown as typeof fetch;
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const row = await readDelivery(id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("socket hang up");
  });

  test("gives up after the maximum attempts (DEAD)", async () => {
    // attempts at MAX-1 (7); one more failure crosses the threshold.
    const id = await seedDelivery({
      subscriptionId: unsignedSubId,
      attempts: 7,
    });
    const { fetchImpl } = stubFetch(503);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    const row = await readDelivery(id);
    expect(row.status).toBe("DEAD");
    expect(row.attempts).toBe(8);
  });

  test("does not claim deliveries of a disabled subscription", async () => {
    const id = await seedDelivery({ subscriptionId: disabledSubId });
    const { fetchImpl, calls } = stubFetch(200);
    await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
    });
    expect(
      calls.some(
        (c) =>
          (c.init?.headers as Record<string, string>)?.[DELIVERY_HEADER] ===
          String(id),
      ),
    ).toBe(false);
    expect(await readDelivery(id)).toMatchObject({ status: "PENDING" });
  });

  test("marks an SSRF-blocked URL DEAD without retrying", async () => {
    const blockedSub = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "http://169.254.169.254/latest/meta-data",
        events: ["conversion"],
        enabled: true,
      },
    });
    const id = await seedDelivery({ subscriptionId: blockedSub.id });
    const { fetchImpl, calls } = stubFetch(200);
    // Real SSRF guard (not the passthrough): the metadata/loopback URL must be rejected.
    await processOutboundBatch({ base: appDb, tenantId, fetchImpl });
    // NOTE: THIS delivery never reached fetch. Asserting on the total instead made the test a
    // stopwatch: the retry test above leaves a PENDING row whose backoff is `Math.random() * 2000`,
    // so once more than that elapses before this line the batch legitimately claims it too, and the
    // count stops being about the blocked URL. Same shape as the disabled-subscription test below.
    expect(
      calls.some(
        (c) =>
          (c.init?.headers as Record<string, string>)?.[DELIVERY_HEADER] ===
          String(id),
      ),
    ).toBe(false);
    const row = await readDelivery(id);
    expect(row.status).toBe("DEAD");
    expect(row.lastError).toContain("Blocked outbound URL");
  });

  test("reaps a stranded SENDING row and redelivers it", async () => {
    const id = await seedDelivery({
      subscriptionId: unsignedSubId,
      status: "SENDING",
    });
    // Backdate updated_at so the reaper considers it stale.
    await suDb.$executeRawUnsafe(
      `UPDATE outbound_webhook_deliveries SET updated_at = now() - interval '5 minutes' WHERE id = ${id}`,
    );
    const { fetchImpl } = stubFetch(200);
    const summary = await processOutboundBatch({
      base: appDb,
      tenantId,
      fetchImpl,
      assertSafe: passthroughSafe,
      staleMs: 60_000,
    });
    expect(summary.reaped).toBeGreaterThanOrEqual(1);
    expect(await readDelivery(id)).toMatchObject({ status: "DELIVERED" });
  });
});
