import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { createIntegrationInstance } from "@/modules/integrations/service";
import {
  DEFAULT_SIGNATURE_HEADER,
  DEFAULT_STATIC_HEADER,
  verifyInboundAuth,
} from "@/modules/webhooks/inbound/auth";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import {
  processInboundDelivery,
  receiveInbound,
} from "@/modules/webhooks/inbound/service";

// ── route token (unit) ──
describe("inbound route token", () => {
  test("generates a unique token with a stable sha256 hash", () => {
    const a = generateRouteToken();
    const b = generateRouteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashRouteToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── auth strategies (unit) ──
describe("inbound auth", () => {
  const body = '{"a":1}';
  test("NONE always passes", () => {
    expect(
      verifyInboundAuth({
        strategy: "NONE",
        secret: null,
        rawBody: body,
        getHeader: () => null,
      }),
    ).toBe(true);
  });
  test("STATIC_HEADER matches the vault secret", () => {
    const headers: Record<string, string> = {
      [DEFAULT_STATIC_HEADER]: "s3cr3t",
    };
    const make = (s: string | null, secret: string) =>
      verifyInboundAuth({
        strategy: "STATIC_HEADER",
        secret,
        rawBody: body,
        getHeader: (n) => (s === null ? null : (headers[n] ?? null)),
      });
    expect(make("x", "s3cr3t")).toBe(true);
    expect(make("x", "wrong")).toBe(false);
    expect(
      verifyInboundAuth({
        strategy: "STATIC_HEADER",
        secret: "s3cr3t",
        rawBody: body,
        getHeader: () => null,
      }),
    ).toBe(false);
  });
  test("HMAC_SHA256 verifies the signature over the raw body", () => {
    const secret = "hmac-secret";
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const check = (provided: string | null) =>
      verifyInboundAuth({
        strategy: "HMAC_SHA256",
        secret,
        rawBody: body,
        getHeader: (n) => (n === DEFAULT_SIGNATURE_HEADER ? provided : null),
      });
    expect(check(sig)).toBe(true);
    expect(check(`sha256=${sig}`)).toBe(true);
    expect(check("deadbeef")).toBe(false);
    expect(check(null)).toBe(false);
  });
});

// ── receptor pipeline (real DB) ──
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
const headersFrom = (h: Record<string, string>) => (name: string) =>
  h[name.toLowerCase()] ?? null;

describe.skipIf(!dbUp)("inbound receptor", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "INB", slug: `inb-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "conversion_events",
        "inbound_deliveries",
        "integration_external_refs",
        "integration_instances",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("rejects an unknown route token with 401", async () => {
    await expect(
      receiveInbound({
        routeToken: "nope-not-a-real-token",
        rawBody: "{}",
        getHeader: () => null,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("queues, correlates and records a conversion end to end", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-conv",
        inboundAuthStrategy: "NONE",
        // notifyOnPayment off: this test asserts the conversion record, not the customer nudge.
        config: { notifyOnPayment: false },
      },
      appDb,
    );
    // Outbound side created the correlation ref linking externalReference → thread.
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId: "pay_123",
        threadId: "1:1:42",
        kind: "payment",
      },
    });

    const body = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_123",
        value: 250.5,
        status: "RECEIVED",
        externalReference: "pay_123",
      },
    });
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    expect(r.deliveryId).toBeDefined();

    const proc = await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
    });
    expect(proc).toBe("processed");

    const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId as bigint },
    });
    expect(delivery.status).toBe("PROCESSED");
    expect(delivery.processedAt).not.toBeNull();

    const conv = await suDb.conversionEvent.findFirst({
      where: { tenantId, threadId: "1:1:42", source: "ASAAS" },
    });
    expect(conv).not.toBeNull();
    expect(conv?.value?.toString()).toBe("250.5");
    expect(conv?.currency).toBe("BRL");
  });

  test("notifies the customer on a confirmed payment (default on), on the SAME thread (no bleed)", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-notify-on",
        inboundAuthStrategy: "NONE",
      },
      appDb,
    );
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId: "corr_notify",
        threadId: "1:1:99",
        kind: "asaas_payment",
      },
    });
    const body = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_n1",
        value: 100,
        status: "RECEIVED",
        externalReference: "corr_notify",
      },
    });
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");

    const nudges: Array<{ threadId: string; nudge: unknown }> = [];
    const proc = await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
      deps: {
        runNudge: async (args) => {
          nudges.push({ threadId: args.threadId, nudge: args.nudge });
          return "messaged";
        },
      },
    });
    expect(proc).toBe("processed");
    // The nudge ran on the exact thread the charge was created on (correlation by PK, not LLM).
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.threadId).toBe("1:1:99");
    expect(nudges[0]?.nudge).toMatchObject({
      kind: "agent_nudge",
      source: "ASAAS",
      value: 100,
    });

    // The conversion is still recorded (durable barrier) and the delivery ends PROCESSED.
    const conv = await suDb.conversionEvent.findFirst({
      where: { tenantId, threadId: "1:1:99", source: "ASAAS" },
    });
    expect(conv).not.toBeNull();
    const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId as bigint },
    });
    expect(delivery.status).toBe("PROCESSED");
  });

  test("does not notify when notifyOnPayment is false (silent conversion)", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-notify-off",
        inboundAuthStrategy: "NONE",
        config: { notifyOnPayment: false },
      },
      appDb,
    );
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId: "corr_silent",
        threadId: "1:1:98",
        kind: "asaas_payment",
      },
    });
    const body = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_s1",
        value: 50,
        status: "RECEIVED",
        externalReference: "corr_silent",
      },
    });
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });

    let nudged = false;
    const proc = await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
      deps: {
        runNudge: async () => {
          nudged = true;
          return "silent";
        },
      },
    });
    expect(proc).toBe("processed");
    expect(nudged).toBe(false);
    // Conversion still recorded — only the customer-facing nudge is suppressed.
    const conv = await suDb.conversionEvent.findFirst({
      where: { tenantId, threadId: "1:1:98", source: "ASAAS" },
    });
    expect(conv).not.toBeNull();
  });

  test("is idempotent on dedupeKey (no second delivery, safe reprocess)", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      tenantId,
      { catalogType: "ASAAS", name: "asaas-idem", inboundAuthStrategy: "NONE" },
      appDb,
    );
    // Uncorrelated PAYMENT_RECEIVED (no external ref): the conversion is dropped after dedupe,
    // a purely DB path with a stable dedupeKey of `${event}:${payment.id}`.
    const body = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      payment: { id: "evt_idem", status: "RECEIVED" },
    });
    const first = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    const second = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("duplicate");
    expect(second.deliveryId).toBe(first.deliveryId as bigint);

    const count = await suDb.inboundDelivery.count({
      where: {
        integrationInstanceId: instanceId,
        dedupeKey: "PAYMENT_RECEIVED:evt_idem",
      },
    });
    expect(count).toBe(1);

    // Second processing is a no-op (status CAS).
    await processInboundDelivery({
      deliveryId: first.deliveryId as bigint,
      tenantId,
      base: appDb,
    });
    expect(
      await processInboundDelivery({
        deliveryId: first.deliveryId as bigint,
        tenantId,
        base: appDb,
      }),
    ).toBe("skipped");
  });

  test("enforces STATIC_HEADER auth after resolving the tenant", async () => {
    const { id: staticTokenId } = await suDb.vaultEntry.create({
      data: { tenantId, name: "static-token", secret: encryptJson("T0KEN") },
      select: { id: true },
    });
    const { routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-static",
        inboundAuthStrategy: "STATIC_HEADER",
        inboundSecretRef: `vault:${staticTokenId}`,
      },
      appDb,
    );
    const body = JSON.stringify({
      event: "PAYMENT_OVERDUE",
      payment: { id: "n1", status: "OVERDUE" },
    });

    await expect(
      receiveInbound({
        routeToken: routeToken as string,
        rawBody: body,
        getHeader: headersFrom({ [DEFAULT_STATIC_HEADER]: "WRONG" }),
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    const ok = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: headersFrom({ [DEFAULT_STATIC_HEADER]: "T0KEN" }),
      base: appDb,
    });
    expect(ok.outcome).toBe("queued");
  });

  test("queues and converts the real Asaas direct-charge payload (paymentLink null) end to end", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-direct",
        inboundAuthStrategy: "NONE",
        config: { notifyOnPayment: false },
      },
      appDb,
    );
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId: "9faca7601d502c54f1bd53ac26370bb1",
        threadId: "1:1:97",
        kind: "asaas_payment",
      },
    });
    // The exact body Asaas sends for a paid DIRECT (non-link) PIX charge: `paymentLink` is
    // present with value null. Regression for the schema-rejects-null bug that turned real
    // payments into a silent `outcome: "ignored"`.
    const body = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      payment: {
        id: "pay_yuq2ko5t8vaioizq",
        value: 500.0,
        status: "RECEIVED",
        externalReference: "9faca7601d502c54f1bd53ac26370bb1",
        checkoutSession: null,
        paymentLink: null,
      },
    });
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId as bigint },
    });
    expect(delivery.externalId).toBe("9faca7601d502c54f1bd53ac26370bb1");
    expect(delivery.status).toBe("PENDING");

    const proc = await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
    });
    expect(proc).toBe("processed");
    const conv = await suDb.conversionEvent.findFirst({
      where: { tenantId, threadId: "1:1:97", source: "ASAAS" },
    });
    expect(conv).not.toBeNull();
    expect(conv?.value?.toString()).toBe("500");
  });

  test("records an unparseable payload as invalid (durable FAILED delivery)", async () => {
    const { routeToken } = await createIntegrationInstance(
      tenantId,
      { catalogType: "ASAAS", name: "asaas-bad", inboundAuthStrategy: "NONE" },
      appDb,
    );
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: JSON.stringify({ not: "a known shape" }),
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("invalid");
    expect(r.deliveryId).toBeDefined();
    const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId as bigint },
    });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.payload).toMatchObject({ reason: "invalid" });
  });

  test("invalid deliveries dedupe on the raw-body hash", async () => {
    const { routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-bad-idem",
        inboundAuthStrategy: "NONE",
      },
      appDb,
    );
    const body = JSON.stringify({ not: "a known shape", n: 2 });
    const first = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    const second = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    expect(first.outcome).toBe("invalid");
    expect(second.outcome).toBe("invalid");
    expect(second.deliveryId).toBe(first.deliveryId as bigint);
  });

  test("still ignores a parseable but unmapped lifecycle event (no delivery)", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      tenantId,
      {
        catalogType: "ASAAS",
        name: "asaas-lifecycle",
        inboundAuthStrategy: "NONE",
      },
      appDb,
    );
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: JSON.stringify({
        event: "PAYMENT_CREATED",
        payment: { id: "pay_lc" },
      }),
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("ignored");
    expect(r.deliveryId).toBeUndefined();
    expect(
      await suDb.inboundDelivery.count({
        where: { integrationInstanceId: instanceId },
      }),
    ).toBe(0);
  });
});
