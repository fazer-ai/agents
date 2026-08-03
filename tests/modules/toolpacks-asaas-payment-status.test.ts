import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { asaasToolpack } from "@/modules/integrations/toolpacks/asaas";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

// NOTE: harness mirrored from toolpacks-asaas.test.ts on purpose — this suite covers the
// payment-status surface (direct charges) and stays independent from that file.
function stubFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function scriptedFetch(
  routes: Array<{
    match: (url: string, init: RequestInit) => boolean;
    status: number;
    json: unknown;
  }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url: String(url), init: i });
    const r = routes.find((x) => x.match(String(url), i));
    return new Response(JSON.stringify(r?.json ?? {}), {
      status: r?.status ?? 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noopAssert = async () => undefined;

function baseCtx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    base: undefined as unknown as PrismaClient,
    threadId: "1:1:1",
    resolveCredential: async () => "tok_live",
    assertSafe: noopAssert,
    ...over,
  };
}

function sel(over: Partial<IntegrationSelection> = {}): IntegrationSelection {
  return {
    instanceId: 1n,
    catalogType: "ASAAS",
    config: {},
    credentialRef: "asaas-token",
    enabledTools: [],
    ...over,
  };
}

function statusTool(ctx: ToolpackCtx) {
  return asaasToolpack.build(
    sel({ enabledTools: ["asaas_payment_status"] }),
    ctx,
  )[0];
}

// Distinct sentinel values per field so the projection negatives cannot false-pass.
const PAYMENT_JSON = {
  id: "pay_1",
  status: "RECEIVED",
  value: 500,
  billingType: "PIX",
  dueDate: "2026-08-01",
  paymentDate: "2026-08-02",
  netValue: 487.55,
  customer: "cus_secret",
  invoiceUrl: "https://sandbox.asaas.com/i/secret-slug",
};

describe("asaas payment status — direct (non-link) charges", () => {
  test("create_pix_charge returns the paymentId for later status checks", async () => {
    const { impl } = scriptedFetch([
      {
        match: (u, i) =>
          u.includes("/customers?cpfCnpj=") && i.method === "GET",
        status: 200,
        json: { data: [{ id: "cus_exist" }], totalCount: 1 },
      },
      {
        match: (u, i) => u.endsWith("/payments") && i.method === "POST",
        status: 200,
        json: {
          id: "pay_pix_1",
          invoiceUrl: "https://sandbox.asaas.com/i/pix1",
          status: "PENDING",
        },
      },
      {
        match: (u) => u.includes("/payments/pay_pix_1/pixQrCode"),
        status: 200,
        json: { payload: "00020126PIXCOPYPASTE6304ABCD" },
      },
    ]);
    const tool = asaasToolpack.build(
      sel({ enabledTools: ["asaas_create_pix_charge"] }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      value: 199.9,
      customerName: "Maria Souza",
      cpfCnpj: "12345678909",
    })) as string;
    expect(out).toContain("(paymentId: pay_pix_1)");
  });

  test("paymentId routes to GET /payments/{id} with the payment projection", async () => {
    const { impl, calls } = stubFetch(200, PAYMENT_JSON);
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({ paymentId: "pay_1" })) as string;
    expect(calls[0]?.url).toBe(
      "https://api-sandbox.asaas.com/v3/payments/pay_1",
    );
    expect(out).toContain("RECEIVED");
    expect(out).toContain("2026-08-02");
    // Merchant-facing / internal fields never reach the model.
    expect(out).not.toContain("487.55");
    expect(out).not.toContain("cus_secret");
    expect(out).not.toContain("secret-slug");
  });

  test("paymentLinkId keeps hitting GET /paymentLinks/{id} with the link projection", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "plink_1",
      active: true,
      value: 100,
      billingType: "UNDEFINED",
      chargeType: "DETACHED",
    });
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({ paymentLinkId: "plink_1" })) as string;
    expect(calls[0]?.url).toBe(
      "https://api-sandbox.asaas.com/v3/paymentLinks/plink_1",
    );
    expect(out).toContain("DETACHED");
  });

  test("a pay_-prefixed id passed as paymentLinkId routes to /payments", async () => {
    const { impl, calls } = stubFetch(200, PAYMENT_JSON);
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    await tool?.invoke({ paymentLinkId: "pay_1" });
    expect(calls[0]?.url).toBe(
      "https://api-sandbox.asaas.com/v3/payments/pay_1",
    );
  });

  test("both ids → paymentId wins (single call to /payments)", async () => {
    const { impl, calls } = stubFetch(200, PAYMENT_JSON);
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    await tool?.invoke({ paymentId: "pay_1", paymentLinkId: "plink_9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api-sandbox.asaas.com/v3/payments/pay_1",
    );
  });

  test("no identifier → instructive message, no fetch", async () => {
    const { impl, calls } = stubFetch(200, PAYMENT_JSON);
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({})) as string;
    expect(out).toContain("paymentId");
    expect(out).toContain("paymentLinkId");
    expect(calls).toHaveLength(0);
  });

  test("a pasted invoice URL is rejected with guidance before any fetch", async () => {
    const { impl, calls } = stubFetch(200, PAYMENT_JSON);
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const viaLink = (await tool?.invoke({
      paymentLinkId: "https://sandbox.asaas.com/i/qwomgrsmq0xyxn86",
    })) as string;
    const viaPayment = (await tool?.invoke({
      paymentId: "https://www.asaas.com/i/abc123",
    })) as string;
    expect(viaLink).toContain("asaas_create_pix_charge");
    expect(viaPayment).toContain("asaas_create_pix_charge");
    expect(calls).toHaveLength(0);
  });

  test("a 404 on an unknown id explains the invoice-slug trap", async () => {
    // A bare invoice-URL slug is shape-indistinguishable from a link id, so it reaches the
    // provider and 404s — the message must route the model back to the real id sources.
    const { impl } = stubFetch(404, {});
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({
      paymentLinkId: "qwomgrsmq0xyxn86",
    })) as string;
    expect(out).toContain("404");
    expect(out).toContain("asaas_create_pix_charge");
  });
});
