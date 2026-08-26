import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  type InboundAuthStrategy,
  PrismaClient,
} from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
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

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

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
    // Review round 1 of #370. An empty override IS a configured name, and dropping it here sent the
    // gate the DEFAULT — which is the one thing the refusal exists to prevent: comparing the secret
    // against `x-webhook-token` on an instance whose operator asked for something else. The write
    // refuses `""` like any other unusable name; this is the row already written.
    {
      name: "an empty override reaches the gate rather than falling back",
      catalogType: "ASAAS",
      config: { authHeader: "" },
      authHeader: "",
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
  // The record lookup above answers every name, including ones no HTTP stack accepts. The receptor's
  // real reader is `request.headers.get`, which THROWS on a name outside the RFC 7230 token — issue
  // #362 — so the cases about an unusable name have to go through the real thing or they prove
  // nothing about the caller.
  //
  // And the global `Headers` here is NOT the real thing: happy-dom replaces it, and its version
  // accepts every name and answers null, so the first version of these two cases failed on the
  // expected value rather than on the throw they exist to pin. `globalThis.BunRequest` is the native
  // constructor tests/dom-setup.ts stashes before the replacement, which is what the route holds.
  const nativeRequest = (globalThis as { BunRequest?: typeof Request })
    .BunRequest;
  const realHdr =
    (h: Record<string, string>) =>
    (n: string): string | null => {
      const R = nativeRequest ?? Request;
      return new R("https://example.com/", { headers: h }).headers.get(n);
    };
  const none = (): string | null => null;

  const cases: Array<{
    name: string;
    strategy: InboundAuthStrategy;
    secret: InboundSecretResolution;
    getHeader: (name: string) => string | null;
    config?: { authHeader?: string; signatureHeader?: string };
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
    // Issue #362. `config.authHeader` is operator text that becomes a header NAME, and a value with a
    // space around it made `Headers.get` throw inside the gate — answering the delivery 500 where
    // every other refusal gives 401, which is itself the oracle the uniform 401 exists to deny. The
    // refusal has to be a refusal, on both strategies, and it must NOT fall back to the default name:
    // comparing against a header the operator never chose is a worse failure than refusing.
    {
      name: "STATIC_HEADER refuses a configured name no HTTP stack accepts",
      strategy: "STATIC_HEADER",
      secret: filled(token),
      config: { authHeader: "asaas-access-token " },
      getHeader: realHdr({
        "asaas-access-token": token,
        [DEFAULT_STATIC_HEADER]: token,
      }),
      expected: { ok: false, reason: "header_name_unusable" },
    },
    {
      name: "HMAC_SHA256 refuses a configured signature name no HTTP stack accepts",
      strategy: "HMAC_SHA256",
      secret: filled(token),
      config: { signatureHeader: "x-sig " },
      getHeader: realHdr({ "x-sig": sig, [DEFAULT_SIGNATURE_HEADER]: sig }),
      expected: { ok: false, reason: "header_name_unusable" },
    },
    // The control, and it is the one that says the refusal is about the NAME and not about custom
    // names at all: a legal one the provider dictates still reads, through the same real reader.
    {
      name: "STATIC_HEADER reads a legal custom name through a real Headers",
      strategy: "STATIC_HEADER",
      secret: filled(token),
      config: { authHeader: "asaas-access-token" },
      getHeader: realHdr({ "asaas-access-token": token }),
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
          config: c.config,
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
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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

  // ── characters Postgres refuses to store (issue #218) ──
  // A body that is valid JSON, passes the mapper's schema, and that the column then refuses. The
  // two characters and BOTH destinations of the normalized event, measured against this database:
  //   jsonb payload + lone surrogate -> invalid input syntax for type json
  //   jsonb payload + NUL            -> 22P05 unsupported Unicode escape sequence
  //   text  column  + lone surrogate -> 22021 invalid byte sequence for encoding "UTF8": 0xef 0xbf
  //   text  column  + NUL            -> 22021 invalid byte sequence for encoding "UTF8": 0x00
  // Each one used to throw out of `receiveInbound`, which nothing above catches: a 500 with no
  // delivery row and no FAILED record either, and a sender retrying a body that can never succeed.
  // The two halves get OPPOSITE treatment, which is what the second group below pins.
  const NUL = String.fromCharCode(0);

  // The payload is display and diagnostics: repaired, and the delivery is kept.
  const repaired: Array<{
    name: string;
    payment: Record<string, unknown>;
    status: string;
    metadata?: unknown;
  }> = [
    {
      name: "a lone surrogate in metadata (jsonb)",
      payment: { id: "u1", externalReference: "r1", paymentLink: "l\ud800k" },
      status: "RECEIVED",
      metadata: { paymentLink: "l�k" },
    },
    {
      name: "a NUL in metadata (jsonb)",
      payment: { id: "u2", externalReference: "r2", paymentLink: `l${NUL}k` },
      status: "RECEIVED",
      metadata: { paymentLink: "lk" },
    },
    {
      name: "a lone surrogate in the provider's status (jsonb)",
      payment: { id: "u3", externalReference: "r3", status: "RECEIVED\ud800" },
      status: "RECEIVED�",
    },
  ];

  for (const [i, c] of repaired.entries()) {
    test(`repairs and keeps the delivery when the body carries ${c.name}`, async () => {
      const { routeToken } = await createIntegrationInstance(
        ctxOf(tenantId),
        {
          catalogType: "ASAAS",
          name: `asaas-repaired-${i}`,
          inboundAuthStrategy: "NONE",
          config: { notifyOnPayment: false },
        },
        appDb,
      );
      const r = await receiveInbound({
        routeToken: routeToken as string,
        rawBody: JSON.stringify({
          event: "PAYMENT_RECEIVED",
          payment: { value: 10, status: "RECEIVED", ...c.payment },
        }),
        getHeader: () => null,
        base: appDb,
      });
      expect(r.outcome).toBe("queued");

      const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
        where: { id: r.deliveryId as bigint },
      });
      expect(delivery.status).toBe("PENDING");
      const payload = delivery.payload as Record<string, unknown>;
      expect(payload.status).toBe(c.status);
      if (c.metadata) expect(payload.metadata).toEqual(c.metadata);
    });
  }

  // An identity field is NOT repaired. Repairing is lossy, and lossy on an identity is how a
  // payment lands in someone else's conversation (`ref<NUL>` becomes `ref`, which is a reference
  // another conversation registered) or how two distinct provider ids collapse into one dedupe key.
  // The delivery takes the fail-closed path instead: a durable FAILED row and a 2xx, which is what
  // stops the retry loop without inventing an identity.
  const refused: Array<{ name: string; payment: Record<string, unknown> }> = [
    {
      name: "a lone surrogate in the provider's id (text dedupe_key)",
      payment: { id: "u4\ud800", externalReference: "r4" },
    },
    {
      name: "a NUL in the provider's id (text dedupe_key)",
      payment: { id: `u5${NUL}x`, externalReference: "r5" },
    },
    {
      name: "a lone surrogate in the correlation reference (text external_id)",
      payment: { id: "u6", externalReference: "r6\ud800" },
    },
  ];

  for (const [i, c] of refused.entries()) {
    test(`records a durable FAILED delivery when the body carries ${c.name}`, async () => {
      const { routeToken } = await createIntegrationInstance(
        ctxOf(tenantId),
        {
          catalogType: "ASAAS",
          name: `asaas-refused-${i}`,
          inboundAuthStrategy: "NONE",
          config: { notifyOnPayment: false },
        },
        appDb,
      );
      const r = await receiveInbound({
        routeToken: routeToken as string,
        rawBody: JSON.stringify({
          event: "PAYMENT_RECEIVED",
          payment: { value: 10, status: "RECEIVED", ...c.payment },
        }),
        getHeader: () => null,
        base: appDb,
      });
      // The sender still gets its 2xx: the point of the fail-closed path is that the retry loop
      // ends, not that the caller learns anything it could act on.
      expect(r.ack).toBe(true);
      expect(r.outcome).toBe("invalid");

      const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
        where: { id: r.deliveryId as bigint },
      });
      expect(delivery.status).toBe("FAILED");
      expect(delivery.externalId).toBeNull();
      expect(delivery.dedupeKey).toMatch(/^raw:[0-9a-f]{64}$/);
      expect(delivery.payload).toMatchObject({ reason: "unstorable-identity" });
    });
  }

  test("records a durable FAILED delivery when the identity is too long for its own index", async () => {
    const { routeToken } = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-identity-long",
        inboundAuthStrategy: "NONE",
        config: { notifyOnPayment: false },
      },
      appDb,
    );
    // Incompressible on purpose: a run of one character compresses inside the index and slips past
    // the limit, so a probe built from `repeat("x", n)` would prove nothing. Measured on this
    // database, an incompressible dedupe key fails its unique index at ~2704 bytes with "index row
    // size 6432 exceeds btree version 4 maximum 2704", which is the same 500-with-no-record this
    // PR exists to remove. The mapper puts `payment.id` straight into the key and its schema caps
    // neither that nor `event`.
    const longId = Array.from({ length: 3000 }, (_, i) =>
      String.fromCharCode(97 + ((i * 7 + (i % 13)) % 26)),
    ).join("");
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: JSON.stringify({
        event: "PAYMENT_RECEIVED",
        payment: {
          id: longId,
          value: 10,
          status: "RECEIVED",
          externalReference: "r-long",
        },
      }),
      getHeader: () => null,
      base: appDb,
    });
    expect(r.ack).toBe(true);
    expect(r.outcome).toBe("invalid");

    const delivery = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId as bigint },
    });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.payload).toMatchObject({ reason: "unstorable-identity" });
  });

  test("a malformed reference never correlates onto the conversation the clean one owns", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-identity-bleed",
        inboundAuthStrategy: "NONE",
        // notifyOnPayment stays ON: the wrong-thread nudge is half of what this guards against.
        config: {},
      },
      appDb,
    );
    // A real conversation owns the reference `corr_bleed`.
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId: "corr_bleed",
        threadId: "1:1:777",
        kind: "asaas_payment",
      },
    });
    // A different payment arrives carrying that same reference with a NUL glued to it. Repairing
    // it would produce `corr_bleed` exactly, and credit this payment to thread 1:1:777.
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: JSON.stringify({
        event: "PAYMENT_RECEIVED",
        payment: {
          id: "pay_bleed",
          value: 999,
          status: "RECEIVED",
          externalReference: `corr_bleed${NUL}`,
        },
      }),
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("invalid");
    if (r.outcome !== "invalid") return;
    await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
    });
    const conv = await suDb.conversionEvent.findFirst({
      where: { tenantId, threadId: "1:1:777", source: "ASAAS" },
    });
    expect(conv).toBeNull();
  });

  test("a repaired payload still converts end to end (the payment is not lost)", async () => {
    const { id: instanceId, routeToken } = await createIntegrationInstance(
      ctxOf(tenantId),
      {
        catalogType: "ASAAS",
        name: "asaas-repaired-e2e",
        inboundAuthStrategy: "NONE",
        config: { notifyOnPayment: false },
      },
      appDb,
    );
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId: "corr_repaired",
        threadId: "1:1:218",
        kind: "asaas_payment",
      },
    });
    const r = await receiveInbound({
      routeToken: routeToken as string,
      rawBody: JSON.stringify({
        event: "PAYMENT_RECEIVED",
        payment: {
          id: "pay_repaired",
          value: 42,
          status: "RECEIVED",
          externalReference: "corr_repaired",
          paymentLink: `link${NUL}\ud800abc`,
        },
      }),
      getHeader: () => null,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");

    const proc = await processInboundDelivery({
      deliveryId: r.deliveryId as bigint,
      tenantId,
      base: appDb,
    });
    expect(proc).toBe("processed");
    const conv = await suDb.conversionEvent.findFirst({
      where: { tenantId, threadId: "1:1:218", source: "ASAAS" },
    });
    expect(conv?.value?.toString()).toBe("42");
  });

  test("records an unparseable payload as invalid (durable FAILED delivery)", async () => {
    const { routeToken } = await createIntegrationInstance(
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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
      ctxOf(tenantId),
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
    config?: Record<string, string>;
  }): Promise<{ token: string; id: bigint }> {
    const minted = generateRouteToken();
    const row = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "ASAAS",
        name: `diag-${minted.hash.slice(0, 10)}`,
        enabled: spec.enabled ?? true,
        config: spec.config ?? {},
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

  // Issue #362, end to end and through the reader the route actually holds. Written against a row
  // created directly, because that is the case the write-side refusal cannot reach: rows already
  // carry whatever they carry.
  test("names the cause when the configured header name is not one, and still answers 401", async () => {
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "unusable-header-name",
        secret: encryptJson("the-secret"),
      },
      select: { id: true },
    });
    const { token } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
      config: { authHeader: "asaas-access-token " },
    });
    const cap = captureWarnings();

    // The native reader, not `headersFrom`: happy-dom's Headers accepts every name, so the record
    // lookup would answer null and this would pass on `header_missing` — the wrong reason, and the
    // 500 it exists to pin would never happen.
    const R =
      (globalThis as { BunRequest?: typeof Request }).BunRequest ?? Request;
    const nativeHeaders = new R("https://example.com/", {
      headers: {
        "asaas-access-token": "the-secret",
        [DEFAULT_STATIC_HEADER]: "the-secret",
      },
    }).headers;

    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        getHeader: (n) => nativeHeaders.get(n),
        base: appDb,
        deps: cap.deps,
      }),
      // 401, not the 500 the TypeError produced. The status is the whole defect: a caller holding a
      // route token and no valid secret got 500 where every other refusal gives 401, so the status
      // itself said "this token resolves to a live instance that is misconfigured".
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(cap.seen[0]).toMatchObject({ reason: "header_name_unusable" });
  });

  // And the half that a fallback would quietly break: the correct secret IS present under the
  // default name in the request above. Authenticating on it would be a 200 on a header the operator
  // never chose.
  test("an unusable configured name does not fall back to the default header", async () => {
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "no-fallback",
        secret: encryptJson("the-secret"),
      },
      select: { id: true },
    });
    const { token } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
      config: { authHeader: "x tok" },
    });
    const R =
      (globalThis as { BunRequest?: typeof Request }).BunRequest ?? Request;
    const nativeHeaders = new R("https://example.com/", {
      headers: { [DEFAULT_STATIC_HEADER]: "the-secret" },
    }).headers;

    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        getHeader: (n) => nativeHeaders.get(n),
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  // Review round 1 of #370, and the same rule as the two above through a different door: an empty
  // string is a configured name, and it used to be dropped one layer earlier — so the gate never saw
  // it and authenticated against `x-webhook-token`, which the row's operator never chose.
  test("an empty configured name refuses too, and does not authenticate on the default", async () => {
    const entry = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "empty-header-name",
        secret: encryptJson("the-secret"),
      },
      select: { id: true },
    });
    const { token } = await rawInstance({
      strategy: "STATIC_HEADER",
      secretRef: `vault:${entry.id}`,
      config: { authHeader: "" },
    });
    const cap = captureWarnings();

    await expect(
      receiveInbound({
        routeToken: token,
        rawBody: diagBody,
        // The correct secret, under the default name. A fallback would answer 200 here.
        getHeader: headersFrom({ [DEFAULT_STATIC_HEADER]: "the-secret" }),
        base: appDb,
        deps: cap.deps,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(cap.seen[0]).toMatchObject({ reason: "header_name_unusable" });
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
