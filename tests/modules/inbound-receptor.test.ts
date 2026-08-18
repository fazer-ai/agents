import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  type InboundAuthStrategy,
  PrismaClient,
} from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { createIntegrationInstance } from "@/modules/integrations/service";
import {
  DEFAULT_SIGNATURE_HEADER,
  DEFAULT_STATIC_HEADER,
  type InboundAuthOutcome,
  type InboundSecretResolution,
  resolveInboundAuthConfig,
  verifyInboundAuth,
} from "@/modules/webhooks/inbound/auth";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import {
  processInboundDelivery,
  type ReceiveParams,
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

// The header Asaas fixes on its side; the operator cannot change it in the Asaas panel.
const ASAAS_STATIC_HEADER = "asaas-access-token";

// ── which header carries the token (unit, decision table) ──
// Precedence, most specific first: the operator's per-instance override, then the provider's own
// convention from the catalog, then our generic default. The catalog layer is what issue #107 was
// missing: Asaas fixes `asaas-access-token` on its side and the operator cannot change it there, so
// without it every Asaas delivery was compared against a header Asaas never sends.
describe("inbound auth header resolution", () => {
  const cases: Array<{
    name: string;
    catalogType: string;
    config: Record<string, unknown>;
    authHeader: string;
    signatureHeader: string;
  }> = [
    {
      name: "Asaas falls back to the header Asaas actually sends",
      catalogType: "ASAAS",
      config: {},
      authHeader: "asaas-access-token",
      signatureHeader: DEFAULT_SIGNATURE_HEADER,
    },
    {
      name: "a per-instance override beats the catalog convention",
      catalogType: "ASAAS",
      config: { authHeader: "x-custom" },
      authHeader: "x-custom",
      signatureHeader: DEFAULT_SIGNATURE_HEADER,
    },
    {
      name: "a catalog entry without a convention keeps the generic default",
      catalogType: "GOOGLE_CALENDAR",
      config: {},
      authHeader: DEFAULT_STATIC_HEADER,
      signatureHeader: DEFAULT_SIGNATURE_HEADER,
    },
    {
      name: "an unknown catalogType keeps the generic default",
      catalogType: "NOT_IN_THE_CATALOG",
      config: {},
      authHeader: DEFAULT_STATIC_HEADER,
      signatureHeader: DEFAULT_SIGNATURE_HEADER,
    },
    {
      name: "a non-string override is ignored rather than trusted",
      catalogType: "ASAAS",
      config: { authHeader: 42 },
      authHeader: "asaas-access-token",
      signatureHeader: DEFAULT_SIGNATURE_HEADER,
    },
    {
      name: "the signature header is overridable per instance too",
      catalogType: "ASAAS",
      config: { signatureHeader: "x-sig" },
      authHeader: "asaas-access-token",
      signatureHeader: "x-sig",
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(resolveInboundAuthConfig(c.catalogType, c.config)).toEqual({
        authHeader: c.authHeader,
        signatureHeader: c.signatureHeader,
      });
    });
  }
});

// ── auth strategies (unit) ──
// One table, because this is one decision. Every row names the REASON, not pass/fail: the reason is
// what issue #124 asked for, and a boolean cannot carry it: the four ways a secret fails to arrive
// used to be the same `false` as a genuinely wrong token.
describe("inbound auth", () => {
  const body = '{"a":1}';
  const token = "s3cr3t";
  const sig = createHmac("sha256", token).update(body).digest("hex");
  const filled = (value: unknown): InboundSecretResolution => ({
    state: "filled",
    value,
  });
  const hdr =
    (h: Record<string, string>) =>
    (n: string): string | null =>
      h[n] ?? null;
  const none = (): string | null => null;

  const cases: Array<{
    name: string;
    strategy: InboundAuthStrategy;
    secret: InboundSecretResolution;
    getHeader: (name: string) => string | null;
    expected: InboundAuthOutcome;
  }> = [
    // NONE never consults the secret, in any state.
    {
      name: "NONE passes with no secret configured",
      strategy: "NONE",
      secret: null,
      getHeader: none,
      expected: { ok: true },
    },
    {
      name: "NONE passes even when the ref resolves to nothing",
      strategy: "NONE",
      secret: { state: "not_found" },
      getHeader: none,
      expected: { ok: true },
    },

    // The four ways the secret never becomes usable. Each is a different thing for the operator to
    // do, and all four were indistinguishable before.
    {
      name: "STATIC_HEADER without a secret ref on the instance",
      strategy: "STATIC_HEADER",
      secret: null,
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: token }),
      expected: { ok: false, reason: "secret_not_configured" },
    },
    {
      name: "STATIC_HEADER whose ref matches no vault entry",
      strategy: "STATIC_HEADER",
      secret: { state: "not_found" },
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: token }),
      expected: { ok: false, reason: "secret_ref_unresolved" },
    },
    {
      name: "STATIC_HEADER whose entry was never filled",
      strategy: "STATIC_HEADER",
      secret: { state: "pending" },
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: token }),
      expected: { ok: false, reason: "secret_pending" },
    },
    {
      // A multi-field credential (langfuse, google_oauth) decrypts to a Record. It is truthy, so it
      // used to sail past the null check and die in Buffer.from, a 500 where every other refusal
      // is a 401, which is both a crash and an oracle.
      name: "STATIC_HEADER wired to a multi-field credential",
      strategy: "STATIC_HEADER",
      secret: filled({ publicKey: "pk", secretKey: "sk" }),
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: token }),
      expected: { ok: false, reason: "secret_unusable" },
    },
    {
      // The shipped guard was `if (!secret)`, which caught "" and null together. Splitting the
      // states splits that guard, and an empty secret has to stay fail-closed.
      name: "STATIC_HEADER wired to an empty secret, against an empty header",
      strategy: "STATIC_HEADER",
      secret: filled(""),
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: "" }),
      expected: { ok: false, reason: "secret_unusable" },
    },

    // The two genuine auth failures, which are the only ones the operator can fix on their side.
    {
      name: "STATIC_HEADER with the header absent",
      strategy: "STATIC_HEADER",
      secret: filled(token),
      getHeader: none,
      expected: { ok: false, reason: "header_missing" },
    },
    {
      name: "STATIC_HEADER with the wrong value",
      strategy: "STATIC_HEADER",
      secret: filled(token),
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: "wrong" }),
      expected: { ok: false, reason: "credential_mismatch" },
    },
    {
      name: "STATIC_HEADER with the right value",
      strategy: "STATIC_HEADER",
      secret: filled(token),
      getHeader: hdr({ [DEFAULT_STATIC_HEADER]: token }),
      expected: { ok: true },
    },

    // HMAC reaches the same verdicts through its own material.
    {
      name: "HMAC_SHA256 whose entry was never filled",
      strategy: "HMAC_SHA256",
      secret: { state: "pending" },
      getHeader: hdr({ [DEFAULT_SIGNATURE_HEADER]: sig }),
      expected: { ok: false, reason: "secret_pending" },
    },
    {
      name: "HMAC_SHA256 wired to a multi-field credential",
      strategy: "HMAC_SHA256",
      secret: filled({ publicKey: "pk", secretKey: "sk" }),
      getHeader: hdr({ [DEFAULT_SIGNATURE_HEADER]: sig }),
      expected: { ok: false, reason: "secret_unusable" },
    },
    {
      name: "HMAC_SHA256 with the signature header absent",
      strategy: "HMAC_SHA256",
      secret: filled(token),
      getHeader: none,
      expected: { ok: false, reason: "header_missing" },
    },
    {
      name: "HMAC_SHA256 with a signature over different material",
      strategy: "HMAC_SHA256",
      secret: filled(token),
      getHeader: hdr({ [DEFAULT_SIGNATURE_HEADER]: "deadbeef" }),
      expected: { ok: false, reason: "credential_mismatch" },
    },
    {
      name: "HMAC_SHA256 verifies the signature over the raw body",
      strategy: "HMAC_SHA256",
      secret: filled(token),
      getHeader: hdr({ [DEFAULT_SIGNATURE_HEADER]: sig }),
      expected: { ok: true },
    },
    {
      name: "HMAC_SHA256 accepts the sha256= prefix",
      strategy: "HMAC_SHA256",
      secret: filled(token),
      getHeader: hdr({ [DEFAULT_SIGNATURE_HEADER]: `sha256=${sig}` }),
      expected: { ok: true },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        verifyInboundAuth({
          strategy: c.strategy,
          secret: c.secret,
          rawBody: body,
          getHeader: c.getHeader,
        }),
      ).toEqual(c.expected);
    });
  }
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

    // The right header, the wrong value.
    await expect(
      receiveInbound({
        routeToken: routeToken as string,
        rawBody: body,
        getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "WRONG" }),
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    // The right value in the GENERIC header. Asaas never sends this one, so accepting it would
    // mean the instance authenticates something Asaas cannot produce (issue #107).
    await expect(
      receiveInbound({
        routeToken: routeToken as string,
        rawBody: body,
        getHeader: headersFrom({ [DEFAULT_STATIC_HEADER]: "T0KEN" }),
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    // What Asaas actually delivers: its token, in its own header.
    const ok = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: body,
      getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "T0KEN" }),
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

  // ── why the 401 happened (issue #124) ──
  // The response is uniform by design, so the refusal REASON in the server log is the observable
  // effect of this fix: asserting the 401 alone would assert the behaviour that was already there.
  // Each broken instance is written straight to the table: the write boundary now refuses these
  // values, and the point is precisely that databases already hold them.

  function captureWarnings() {
    const seen: Record<string, unknown>[] = [];
    const logger = {
      warn: (obj: unknown) => {
        seen.push(obj as Record<string, unknown>);
      },
    };
    return { seen, deps: { logger } as ReceiveParams["deps"] };
  }

  async function rawInstance(spec: {
    strategy: InboundAuthStrategy;
    secretRef?: string | null;
    enabled?: boolean;
  }): Promise<{ token: string; id: bigint }> {
    const minted = generateRouteToken();
    const row = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "ASAAS",
        name: `diag-${minted.hash.slice(0, 10)}`,
        enabled: spec.enabled ?? true,
        config: {},
        inboundAuthStrategy: spec.strategy,
        inboundSecretRef: spec.secretRef ?? null,
        routeTokenHash: minted.hash,
        routeToken: encryptJson(minted.token),
      },
      select: { id: true },
    });
    return { token: minted.token, id: row.id };
  }

  const diagBody = JSON.stringify({
    event: "PAYMENT_RECEIVED",
    payment: { id: "diag", status: "RECEIVED", value: 1 },
  });

  test("names the cause when the ref is a bare vault NAME, which resolves to nothing", async () => {
    await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "asaas-inbound",
        secret: encryptJson("REAL-TOKEN"),
      },
    });
    // What a client following the REST schema's own wording ("Vault reference name") used to store.
    const { token, id } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: "asaas-inbound",
    });
    const cap = captureWarnings();

    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "REAL-TOKEN" }),
        base: appDb,
        deps: cap.deps,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(cap.seen).toHaveLength(1);
    expect(cap.seen[0]).toMatchObject({
      reason: "secret_ref_unresolved",
      instanceId: String(id),
      secretRef: "asaas-inbound",
      strategy: "STATIC_HEADER",
    });
    // The token the operator pasted on both ends never reaches the log.
    expect(JSON.stringify(cap.seen[0])).not.toContain("REAL-TOKEN");
  });

  test("names the cause when the vault entry exists but was never filled", async () => {
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "unfilled-inbound",
        secret: encryptJson({}),
        status: "pending",
      },
      select: { id: true },
    });
    const { token } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
    });
    const cap = captureWarnings();

    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "anything" }),
        base: appDb,
        deps: cap.deps,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(cap.seen[0]).toMatchObject({
      reason: "secret_pending",
      secretRef: `vault:${entry.id}`,
    });
  });

  test("names the cause when the strategy needs a secret the instance never named", async () => {
    const { token } = await rawInstance({ strategy: "HMAC_SHA256" });
    const cap = captureWarnings();

    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        getHeader: headersFrom({ [DEFAULT_SIGNATURE_HEADER]: "deadbeef" }),
        base: appDb,
        deps: cap.deps,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(cap.seen[0]).toMatchObject({ reason: "secret_not_configured" });
    expect(cap.seen[0]).not.toHaveProperty("secretRef");
  });

  test("a delivery wired to a multi-field credential is refused, not crashed", async () => {
    // langfuse-shaped: decryptJson gives a Record, which used to reach Buffer.from and throw, so a
    // 500 where every other refusal is a 401.
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "multi-field-inbound",
        kind: "langfuse",
        secret: encryptJson({ publicKey: "pk", secretKey: "sk" }),
      },
      select: { id: true },
    });
    const { token } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
    });
    const cap = captureWarnings();

    const err = await receiveInbound({
      routeToken: token,
      rawBody: diagBody,
      getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "whatever" }),
      base: appDb,
      deps: cap.deps,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { statusCode?: number }).statusCode).toBe(401);
    expect((err as Error).name).not.toBe("TypeError");
    expect(cap.seen[0]).toMatchObject({ reason: "secret_unusable" });
  });

  test("separates a token that resolves nothing from an instance that is switched off", async () => {
    const unknown = captureWarnings();
    await expect(
      receiveInbound({
        routeToken: "not-a-live-token",
        rawBody: diagBody,
        getHeader: () => null,
        base: appDb,
        deps: unknown.deps,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(unknown.seen[0]).toMatchObject({ reason: "route_unknown" });
    expect(unknown.seen[0]).not.toHaveProperty("instanceId");

    const { token, id } = await rawInstance({
      strategy: "NONE",
      enabled: false,
    });
    const disabled = captureWarnings();
    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        getHeader: () => null,
        base: appDb,
        deps: disabled.deps,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(disabled.seen[0]).toMatchObject({
      reason: "route_disabled",
      instanceId: String(id),
    });
  });

  test("the response is identical whichever cause produced it", async () => {
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "identical-inbound",
        secret: encryptJson("GOOD"),
      },
      select: { id: true },
    });
    const wired = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
    });
    const dangling = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: "vault:999999999",
    });
    const shape = async (routeToken: string) =>
      receiveInbound({
        routeToken,
        rawBody: diagBody,
        getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "BAD" }),
        base: appDb,
        deps: captureWarnings().deps,
      }).then(
        () => null,
        (e: unknown) => ({
          statusCode: (e as { statusCode?: number }).statusCode,
          message: (e as Error).message,
          translationKey: (e as { translationKey?: string }).translationKey,
        }),
      );
    // Wrong token vs a ref pointing at nothing: same status, same body. The reason lives in the
    // log, never in the answer. There is no oracle for which route tokens are live.
    expect(await shape(wired.token)).toEqual(await shape(dangling.token));
  });

  test("an accepted delivery logs no rejection at all", async () => {
    const entry = await suDb.vaultEntry.create({
      data: { tenantId, name: "quiet-inbound", secret: encryptJson("QUIET") },
      select: { id: true },
    });
    const { token } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
    });
    const cap = captureWarnings();

    const ok = await receiveInbound({
      routeToken: token,
      rawBody: diagBody,
      getHeader: headersFrom({ [ASAAS_STATIC_HEADER]: "QUIET" }),
      base: appDb,
      deps: cap.deps,
    });
    expect(ok.outcome).toBe("queued");
    expect(cap.seen).toHaveLength(0);
  });
});
