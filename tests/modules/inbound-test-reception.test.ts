import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { inFlightWork } from "@/lib/shutdown";
import type { TenantContext } from "@/lib/tenancy";
import { ensureConversationRef } from "@/modules/integrations/conversation-ref";
import { runFetchBack } from "@/modules/integrations/fetch-back-run";
import {
  createIntegrationInstance,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import { createToolDefinition } from "@/modules/tool-definitions/service";
import {
  TEST_RECEPTION_PER_MINUTE,
  testReception,
} from "@/modules/webhooks/inbound/test-reception";
import { dbProbeFailed } from "@/tests/db-gate";

// The sample notifications below are the shapes the providers document: Mercado Pago's id-only
// notice signed over `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, a GENERIC body signed as
// hex over the raw body in x-webhook-signature, and an Asaas PAYMENT_RECEIVED.

const SECRET = "test-reception-secret";
const TOKEN = "TEST-access-token";
const hmac = (msg: string, secret = SECRET) =>
  createHmac("sha256", secret).update(msg).digest("hex");

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

describe.skipIf(!dbUp)("test reception", () => {
  const tenants: bigint[] = [];
  let tenantId = 0n;
  let mpId = 0n;
  let genericId = 0n;
  let asaasId = 0n;
  let refApproved = "";
  let refGeneric = "";
  const ctx = (id = tenantId): TenantContext => ({
    tenantId: id,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const payments = new Map<string, { code: number; body: unknown }>();
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push(String(url));
    if (new Headers(init.headers).get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("{}", { status: 401 });
    }
    const id = /\/v1\/payments\/([^/?]+)$/.exec(String(url))?.[1] ?? "";
    const p = payments.get(id) ?? { code: 404, body: {} };
    return new Response(JSON.stringify(p.body), {
      status: p.code,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const run = (p: Parameters<typeof runFetchBack>[0]) =>
    runFetchBack({ ...p, deps: { fetchImpl } });
  const nudges: unknown[] = [];
  // What a shutdown would have seen registered while the agent turn ran.
  const tracked: number[] = [];
  let clock = 1_800_000_000_000;
  const deps = () => {
    // Each call its own minute, so only the rate-limit test meets the limit.
    clock += 61_000;
    return {
      now: clock,
      runFetchBack: run,
      process: {
        runNudge: async (a: unknown) => {
          nudges.push(a);
          tracked.push(inFlightWork().byKind.inbound_delivery ?? 0);
          return "messaged" as const;
        },
      } as never,
    };
  };
  const mpNotice = (id: string, secret = SECRET) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      body: JSON.stringify({
        action: "payment.updated",
        type: "payment",
        data: { id },
      }),
      headers: {
        "x-signature": `ts=${ts},v1=${hmac(`id:${id};request-id:req-1;ts:${ts};`, secret)}`,
        "x-request-id": "req-1",
      },
      query: `data.id=${id}&type=payment`,
    };
  };
  const counts = async () => ({
    deliveries: await suDb.inboundDelivery.count({ where: { tenantId } }),
    conversions: await suDb.conversionEvent.count({ where: { tenantId } }),
  });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TESTRECEPTION", slug: `test-reception-${process.pid}` },
    });
    tenantId = t.id;
    tenants.push(t.id);
    const sig = await suDb.vaultEntry.create({
      data: { tenantId, name: "sig", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const tok = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "token",
        kind: "bearer_token",
        secret: encryptJson(TOKEN),
      },
      select: { id: true },
    });
    const tool = await createToolDefinition(
      ctx(),
      {
        name: "consultar_pagamento",
        label: "Consultar pagamento",
        method: "GET",
        urlTemplate: "https://8.8.8.8/v1/payments/{{payment_id}}",
        allowedHosts: ["8.8.8.8"],
        inputSchema: { payment_id: { type: "string", required: true } },
        credentialRef: `vault:${tok.id}`,
      } as never,
      appDb,
    );
    const mp = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Mercado Pago",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${sig.id}`,
        config: {
          signatureHeader: "x-signature",
          signature: {
            format: "parts",
            signaturePart: "v1",
            timestampPart: "ts",
            message:
              "[[id:{{query.data.id|lower}};]][[request-id:{{header.x-request-id}};]]ts:{{sig.ts}};",
          },
          fetchBack: {
            toolId: String(tool.id),
            idFrom: "query.data.id",
            idArg: "payment_id",
            conversationRefPath: "external_reference",
            statusPath: "status",
            valuePath: "transaction_amount",
            statuses: [{ status: "approved", paid: true, text: "Pago" }],
          },
        },
      },
      appDb,
    );
    mpId = mp.id;
    const g = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Sistema próprio",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${sig.id}`,
      },
      appDb,
    );
    genericId = g.id;
    const a = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "ASAAS",
        name: "Asaas",
        inboundAuthStrategy: "STATIC_HEADER",
        inboundSecretRef: `vault:${sig.id}`,
      },
      appDb,
    );
    asaasId = a.id;
    const r1 = await ensureConversationRef({
      tenantId,
      integrationInstanceId: mpId,
      threadId: `${tenantId}:1:501`,
      base: appDb,
    });
    const r2 = await ensureConversationRef({
      tenantId,
      integrationInstanceId: genericId,
      threadId: `${tenantId}:1:502`,
      base: appDb,
    });
    if (!r1.ok || !r2.ok) throw new Error("mint");
    refApproved = r1.ref;
    refGeneric = r2.ref;
    payments.set("1001", {
      code: 200,
      body: {
        status: "approved",
        external_reference: refApproved,
        transaction_amount: 99.9,
      },
    });
  });

  afterAll(async () => {
    for (const id of tenants) {
      for (const table of [
        "inbound_deliveries",
        "conversion_events",
        "integration_external_refs",
        "integration_instances",
        "tool_definitions",
        "vault_entries",
        "audit_logs",
      ]) {
        await suDb
          .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${id}`)
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a Mercado Pago notice, dry: every stage down to the conversation, and nothing written", async () => {
    const before = await counts();
    const calls = seen.length;
    const r = await testReception(ctx(), mpId, mpNotice("1001"), appDb, deps());
    expect(r.dryRun).toBe(true);
    expect(r.outcome).toBe("queued");
    expect(r.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["signature", true],
      ["mapping", true],
      ["record", true],
      ["fetch_back", true],
      ["mapping", true],
      ["correlation", true],
    ]);
    expect(r.stages[0]?.detail).toMatchObject({
      strategy: "HMAC_SHA256",
      header: "x-signature",
      headerPresent: true,
      parts: ["ts", "v1"],
    });
    expect(String(r.stages[0]?.detail?.signedMessage)).toMatch(
      /^id:1001;request-id:req-1;ts:\d+;$/,
    );
    expect(r.stages[1]?.detail).toEqual({ lookup: "1001" });
    expect(r.stages[2]?.detail).toEqual({ status: "PENDING", dryRun: true });
    expect(r.stages[4]?.detail).toMatchObject({
      kind: "conversion",
      externalId: refApproved,
      dedupeKey: "1001:approved",
      value: 99.9,
    });
    expect(r.stages[5]?.detail).toEqual({
      conversation: `${tenantId}:1:501`,
    });
    expect(seen.length).toBe(calls + 1);
    expect(await counts()).toEqual(before);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a wrong secret stops at the signature with the receptor's own reason", async () => {
    const r = await testReception(
      ctx(),
      mpId,
      mpNotice("1001", "another-secret"),
      appDb,
      deps(),
    );
    expect(r.outcome).toBe("unauthorized");
    expect(r.stages.map((s) => [s.stage, s.ok, s.reason])).toEqual([
      ["signature", false, "credential_mismatch"],
    ]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("a GENERIC body, dry: the mapped event and its conversation, or the dead handle", async () => {
    const body = (ref: string) =>
      JSON.stringify({ event_id: "evt-1", conversation_ref: ref, text: "Oi" });
    const ok = await testReception(
      ctx(),
      genericId,
      {
        body: body(refGeneric),
        headers: { "X-Webhook-Signature": hmac(body(refGeneric)) },
      },
      appDb,
      deps(),
    );
    expect(ok.outcome).toBe("queued");
    expect(ok.stages.map((s) => s.stage)).toEqual([
      "signature",
      "mapping",
      "correlation",
      "record",
    ]);
    expect(ok.stages[1]?.detail).toMatchObject({
      kind: "agent_nudge",
      dedupeKey: "evt-1",
      text: "Oi",
    });
    // A ref minted by the Mercado Pago instance names no conversation of this one.
    const dead = await testReception(
      ctx(),
      genericId,
      {
        body: body(refApproved),
        headers: { "x-webhook-signature": hmac(body(refApproved)) },
      },
      appDb,
      deps(),
    );
    expect(dead.outcome).toBe("uncorrelated");
    expect(dead.stages.at(-1)).toMatchObject({
      stage: "correlation",
      ok: false,
      reason: "uncorrelated",
    });
  });

  test("a body the mapper refuses names the paths it missed", async () => {
    const body = JSON.stringify({ text: "sem id" });
    const r = await testReception(
      ctx(),
      genericId,
      { body, headers: { "x-webhook-signature": hmac(body) } },
      appDb,
      deps(),
    );
    expect(r.outcome).toBe("invalid");
    expect(r.stages[1]).toMatchObject({
      stage: "mapping",
      ok: false,
      reason: "invalid",
    });
    expect(r.stages.at(-1)).toEqual({
      stage: "record",
      ok: true,
      detail: { status: "FAILED", dryRun: true },
    });
  });

  test("a catalog integration (Asaas) runs its own mapper and correlation", async () => {
    const r = await testReception(
      ctx(),
      asaasId,
      {
        body: JSON.stringify({
          event: "PAYMENT_RECEIVED",
          payment: { id: "pay_1", value: 10, externalReference: "nao-existe" },
        }),
        headers: { "asaas-access-token": SECRET },
      },
      appDb,
      deps(),
    );
    expect(r.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["signature", true],
      ["mapping", true],
      ["record", true],
      ["correlation", false],
    ]);
    expect(r.stages[0]?.detail).toEqual({
      strategy: "STATIC_HEADER",
      header: "asaas-access-token",
      headerPresent: true,
    });
    expect(r.outcome).toBe("uncorrelated");
  });

  test("without the dry run the notice is delivered: the lookup runs, the sale is recorded, the agent is woken", async () => {
    const n = nudges.length;
    const r = await testReception(
      ctx(),
      mpId,
      { ...mpNotice("1001"), dryRun: false },
      appDb,
      deps(),
    );
    expect(r.dryRun).toBe(false);
    expect(r.stages.at(-1)).toMatchObject({
      stage: "delivery",
      ok: true,
      detail: { status: "PROCESSED" },
    });
    expect(
      await suDb.conversionEvent.count({
        where: { tenantId, threadId: `${tenantId}:1:501` },
      }),
    ).toBe(1);
    expect(nudges.length).toBe(n + 1);
    // Registered with the shutdown drain, as the webhook route's dispatch is.
    expect(tracked.at(-1)).toBe(1);
  });

  test("a real test whose processing fails, or whose lookup will be retried, does not answer queued", async () => {
    const boom = await testReception(
      ctx(),
      mpId,
      { ...mpNotice("1004"), dryRun: false },
      appDb,
      {
        ...deps(),
        runFetchBack: async () => {
          throw new Error("lookup crashed");
        },
      },
    );
    expect(boom.stages.at(-1)).toMatchObject({
      stage: "delivery",
      ok: false,
      reason: "lookup crashed",
    });
    expect(boom.outcome).toBe("failed");

    payments.set("1005", { code: 503, body: {} });
    const later = await testReception(
      ctx(),
      mpId,
      { ...mpNotice("1005"), dryRun: false },
      appDb,
      deps(),
    );
    expect(later.stages.find((s) => s.stage === "fetch_back")).toMatchObject({
      ok: false,
      detail: { retried: true },
    });
    expect(later.outcome).toBe("retrying");
  });

  test("a real test reports what processing found: an Asaas payment whose reference names no conversation is not an all-green run", async () => {
    const r = await testReception(
      ctx(),
      asaasId,
      {
        body: JSON.stringify({
          event: "PAYMENT_RECEIVED",
          payment: {
            id: "pay_2",
            value: 10,
            externalReference: "ref-que-nao-existe",
          },
        }),
        headers: { "asaas-access-token": SECRET },
        dryRun: false,
      },
      appDb,
      deps(),
    );
    expect(r.outcome).toBe("uncorrelated");
    expect(r.stages.find((s) => s.stage === "correlation")).toMatchObject({
      ok: false,
      reason: "uncorrelated",
    });
  });

  test("the dry run refuses a provider answer that real processing would refuse (an id the row cannot carry)", async () => {
    payments.set("1003", {
      code: 200,
      body: { status: "approved", external_reference: "ref\u0000x" },
    });
    const r = await testReception(ctx(), mpId, mpNotice("1003"), appDb, deps());
    expect(r.outcome).toBe("invalid");
    expect(r.stages.at(-1)).toMatchObject({
      stage: "mapping",
      ok: false,
      reason: "unstorable-identity",
    });
  });

  test("a disabled instance can be tested dry, not delivered", async () => {
    await updateIntegrationInstance(
      ctx(),
      genericId,
      { enabled: false },
      appDb,
    );
    const body = JSON.stringify({
      event_id: "evt-2",
      conversation_ref: refGeneric,
      text: "Oi",
    });
    const input = { body, headers: { "x-webhook-signature": hmac(body) } };
    expect(
      (await testReception(ctx(), genericId, input, appDb, deps())).outcome,
    ).toBe("queued");
    await expect(
      testReception(
        ctx(),
        genericId,
        { ...input, dryRun: false },
        appDb,
        deps(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await updateIntegrationInstance(ctx(), genericId, { enabled: true }, appDb);
  });

  test("another workspace's instance is not found", async () => {
    const o = await suDb.tenant.create({
      data: { name: "TR-OTHER", slug: `test-reception-o-${process.pid}` },
    });
    tenants.push(o.id);
    await expect(
      testReception(ctx(o.id), mpId, mpNotice("1001"), appDb, deps()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test(`at most ${TEST_RECEPTION_PER_MINUTE} a minute per workspace`, async () => {
    clock += 120_000;
    const now = clock;
    const input = { body: "{}" };
    for (let i = 0; i < TEST_RECEPTION_PER_MINUTE; i++) {
      await testReception(ctx(), genericId, input, appDb, {
        ...deps(),
        now: now + i,
      });
    }
    await expect(
      testReception(ctx(), genericId, input, appDb, {
        ...deps(),
        now: now + 30_000,
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
    // A minute later the window has moved.
    await testReception(ctx(), genericId, input, appDb, {
      ...deps(),
      now: now + 61_000,
    });
  });
});
