import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { getMapper } from "@/modules/integrations/mappers";
import { asaasToolpack } from "@/modules/integrations/toolpacks/asaas";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";

// A fetch stub that records the request and returns a canned JSON response.
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

// A fetch stub that routes by (url, method) so a multi-call flow (find customer → create customer
// → create payment → fetch QR) can return a different canned response per step.
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
    // build() / non-persisting paths never touch base; the DB suite overrides it.
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

describe("asaas toolpack — allowlist (fail-closed)", () => {
  test("empty allowlist → no tools", () => {
    expect(asaasToolpack.build(sel({ enabledTools: [] }), baseCtx())).toEqual(
      [],
    );
  });
  test("only allowlisted tools are exposed", () => {
    const tools = asaasToolpack.build(
      sel({ enabledTools: ["asaas_payment_link_create"] }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name)).toEqual(["asaas_payment_link_create"]);
  });
  test("two tools when both granted", () => {
    const tools = asaasToolpack.build(
      sel({
        enabledTools: ["asaas_payment_link_create", "asaas_payment_status"],
      }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name).sort()).toEqual([
      "asaas_payment_link_create",
      "asaas_payment_status",
    ]);
  });
  test("an unknown tool name yields nothing", () => {
    expect(
      asaasToolpack.build(sel({ enabledTools: ["bogus"] }), baseCtx()),
    ).toEqual([]);
  });
});

describe("asaas toolpack — environment is bound to config, never an arg", () => {
  function statusTool(config: Record<string, unknown>, ctx: ToolpackCtx) {
    const tools = asaasToolpack.build(
      sel({ enabledTools: ["asaas_payment_status"], config }),
      ctx,
    );
    return tools[0];
  }

  test("production config → production origin", async () => {
    const { impl, calls } = stubFetch(200, { id: "plink_1", active: true });
    const tool = statusTool(
      { environment: "production" },
      baseCtx({ fetchImpl: impl }),
    );
    await tool?.invoke({ paymentLinkId: "plink_1" });
    expect(calls[0]?.url).toBe("https://api.asaas.com/v3/paymentLinks/plink_1");
  });

  test("absent / unknown environment → sandbox origin (safe default)", async () => {
    const { impl, calls } = stubFetch(200, { id: "plink_1", active: true });
    const tool = statusTool({}, baseCtx({ fetchImpl: impl }));
    await tool?.invoke({ paymentLinkId: "plink_1" });
    expect(calls[0]?.url).toBe(
      "https://api-sandbox.asaas.com/v3/paymentLinks/plink_1",
    );
  });

  test("credential flows only into the access_token header, never the return", async () => {
    const { impl, calls } = stubFetch(200, { id: "plink_1", active: true });
    const tool = statusTool(
      {},
      baseCtx({
        fetchImpl: impl,
        resolveCredential: async () => "SECRET_TOKEN",
      }),
    );
    const out = (await tool?.invoke({ paymentLinkId: "plink_1" })) as string;
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.access_token).toBe("SECRET_TOKEN");
    expect(out).not.toContain("SECRET_TOKEN");
  });

  test("missing credential → friendly error, no fetch", async () => {
    const { impl, calls } = stubFetch(200, {});
    const tool = asaasToolpack.build(
      sel({ enabledTools: ["asaas_payment_status"], credentialRef: null }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({ paymentLinkId: "plink_1" })) as string;
    expect(out).toContain("not configured");
    expect(calls).toHaveLength(0);
  });
});

describe("asaas toolpack — PIX charge (hermetic)", () => {
  const CPF = "12345678909";
  function pixRoutes(customerLookup: unknown) {
    return [
      {
        match: (u: string, i: RequestInit) =>
          u.includes("/customers?cpfCnpj=") && i.method === "GET",
        status: 200,
        json: customerLookup,
      },
      {
        match: (u: string, i: RequestInit) =>
          u.endsWith("/customers") && i.method === "POST",
        status: 200,
        json: { id: "cus_new" },
      },
      {
        match: (u: string, i: RequestInit) =>
          u.endsWith("/payments") && i.method === "POST",
        status: 200,
        json: {
          id: "pay_pix_1",
          invoiceUrl: "https://sandbox.asaas.com/i/pix1",
          status: "PENDING",
        },
      },
      {
        match: (u: string) => u.includes("/payments/pay_pix_1/pixQrCode"),
        status: 200,
        json: {
          encodedImage: "BASE64_QR_IMAGE_DATA",
          payload: "00020126PIXCOPYPASTE6304ABCD",
          expirationDate: "2026-06-21 23:59:59",
        },
      },
    ];
  }

  function pixTool(ctx: ToolpackCtx) {
    return asaasToolpack.build(
      sel({
        enabledTools: ["asaas_create_pix_charge"],
        config: { environment: "sandbox" },
      }),
      ctx,
    )[0];
  }

  test("full flow: creates customer, opens charge, returns payload + page", async () => {
    const { impl, calls } = scriptedFetch(
      pixRoutes({ data: [], totalCount: 0 }),
    );
    const tool = pixTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({
      value: 199.9,
      customerName: "Maria Souza",
      cpfCnpj: CPF,
      description: "Plano mensal",
    })) as string;

    // No customer found → one POST /customers, then POST /payments, then GET pixQrCode.
    const paymentCall = calls.find(
      (c) => c.url.endsWith("/payments") && c.init.method === "POST",
    );
    const body = JSON.parse(paymentCall?.init.body as string) as Record<
      string,
      unknown
    >;
    expect(body.billingType).toBe("PIX");
    expect(body.value).toBe(199.9);
    expect(body.customer).toBe("cus_new");
    expect(body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.externalReference as string).toMatch(/^[0-9a-f]{32}$/);

    // Model-visible return: the copy-and-paste code + the hosted page.
    expect(out).toContain("00020126PIXCOPYPASTE6304ABCD");
    expect(out).toContain("https://sandbox.asaas.com/i/pix1");
  });

  test("never echoes the CPF or the QR image (base64) in the return", async () => {
    const { impl } = scriptedFetch(pixRoutes({ data: [], totalCount: 0 }));
    const tool = pixTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({
      value: 50,
      customerName: "João",
      cpfCnpj: CPF,
    })) as string;
    expect(out).not.toContain(CPF);
    expect(out).not.toContain("BASE64_QR_IMAGE_DATA");
  });

  test("reuses an existing customer (no POST /customers)", async () => {
    const { impl, calls } = scriptedFetch(
      pixRoutes({ data: [{ id: "cus_exist" }], totalCount: 1 }),
    );
    const tool = pixTool(baseCtx({ fetchImpl: impl }));
    await tool?.invoke({ value: 10, customerName: "Ana", cpfCnpj: CPF });

    expect(
      calls.some(
        (c) => c.url.endsWith("/customers") && c.init.method === "POST",
      ),
    ).toBe(false);
    const paymentCall = calls.find(
      (c) => c.url.endsWith("/payments") && c.init.method === "POST",
    );
    const body = JSON.parse(paymentCall?.init.body as string) as Record<
      string,
      unknown
    >;
    expect(body.customer).toBe("cus_exist");
  });

  test("invalid CPF/CNPJ → friendly error, no fetch", async () => {
    const { impl, calls } = scriptedFetch(pixRoutes({ data: [] }));
    const tool = pixTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({
      value: 10,
      customerName: "X",
      cpfCnpj: "123",
    })) as string;
    expect(out).toContain("Invalid CPF/CNPJ");
    expect(calls).toHaveLength(0);
  });

  test("missing PIX code still returns the payable invoiceUrl", async () => {
    const routes = pixRoutes({ data: [], totalCount: 0 });
    // QR endpoint fails (e.g. no PIX key on the account).
    routes[3] = {
      match: (u: string) => u.includes("/pixQrCode"),
      status: 400,
      json: { errors: [{ description: "no pix key" }] },
    };
    const { impl } = scriptedFetch(routes);
    const tool = pixTool(baseCtx({ fetchImpl: impl }));
    const out = (await tool?.invoke({
      value: 10,
      customerName: "Y",
      cpfCnpj: CPF,
    })) as string;
    expect(out).toContain("https://sandbox.asaas.com/i/pix1");
  });
});

// ── DB-gated: the create tool persists the correlation ref ──
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
let instanceId = 0n;

describe.skipIf(!dbUp)("asaas toolpack — correlation ref persistence", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "AsaasTP", slug: `asaas-tp-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "ASAAS",
        name: "asaas-test",
        config: { environment: "sandbox" },
        routeTokenHash: randomBytes(16).toString("hex"),
      },
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM integration_external_refs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM integration_instances WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("create persists an IntegrationExternalRef keyed by the externalReference we sent", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "plink_42",
      url: "https://sandbox.asaas.com/i/abc",
    });
    const threadId = `${tenantId}:1:777`;
    const tool = asaasToolpack.build(
      sel({
        instanceId,
        enabledTools: ["asaas_payment_link_create"],
        config: { environment: "sandbox" },
      }),
      baseCtx({ tenantId, base: appDb, threadId, fetchImpl: impl }),
    )[0];

    const out = (await tool?.invoke({
      value: 199.9,
      description: "Plano mensal",
    })) as string;
    expect(out).toContain("https://sandbox.asaas.com/i/abc");

    // The body carried our opaque correlation token as externalReference.
    const body = JSON.parse(calls[0]?.init.body as string) as Record<
      string,
      unknown
    >;
    const externalReference = body.externalReference as string;
    expect(externalReference).toMatch(/^[0-9a-f]{32}$/);
    expect(body.value).toBe(199.9);
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)
        ?.access_token,
    ).toBe("tok_live");

    // The ref ties that token back to THIS thread, by PK.
    const ref = await suDb.integrationExternalRef.findFirst({
      where: { tenantId, externalId: externalReference },
      select: { threadId: true, kind: true, metadata: true },
    });
    expect(ref?.threadId).toBe(threadId);
    expect(ref?.kind).toBe("asaas_payment");
    expect((ref?.metadata as Record<string, unknown>)?.paymentLinkId).toBe(
      "plink_42",
    );

    // Round-trip: the inbound mapper resolves the same externalId from a payment webhook that
    // echoes our externalReference — closing the outbound→inbound correlation loop.
    const mapped = getMapper("ASAAS")?.map({
      event: "PAYMENT_RECEIVED",
      payment: { id: "pay_99", externalReference, status: "RECEIVED" },
    });
    if (!mapped?.ok) throw new Error("expected a mapped inbound event");
    expect(mapped.event.externalId).toBe(externalReference);
  });

  test("pix charge persists the correlation ref keyed by externalReference (metadata.paymentId)", async () => {
    const { impl, calls } = scriptedFetch([
      {
        match: (u, i) =>
          u.includes("/customers?cpfCnpj=") && i.method === "GET",
        status: 200,
        json: { data: [], totalCount: 0 },
      },
      {
        match: (u, i) => u.endsWith("/customers") && i.method === "POST",
        status: 200,
        json: { id: "cus_db" },
      },
      {
        match: (u, i) => u.endsWith("/payments") && i.method === "POST",
        status: 200,
        json: { id: "pay_db_1", invoiceUrl: "https://sandbox.asaas.com/i/db1" },
      },
      {
        match: (u) => u.includes("/payments/pay_db_1/pixQrCode"),
        status: 200,
        json: { encodedImage: "IMG", payload: "PIXCODE_DB" },
      },
    ]);
    const threadId = `${tenantId}:1:888`;
    const tool = asaasToolpack.build(
      sel({
        instanceId,
        enabledTools: ["asaas_create_pix_charge"],
        config: { environment: "sandbox" },
      }),
      baseCtx({ tenantId, base: appDb, threadId, fetchImpl: impl }),
    )[0];

    await tool?.invoke({
      value: 99.9,
      customerName: "Cliente DB",
      cpfCnpj: "12345678909",
    });

    const paymentCall = calls.find(
      (c) => c.url.endsWith("/payments") && c.init.method === "POST",
    );
    const body = JSON.parse(paymentCall?.init.body as string) as Record<
      string,
      unknown
    >;
    const externalReference = body.externalReference as string;

    const ref = await suDb.integrationExternalRef.findFirst({
      where: { tenantId, externalId: externalReference },
      select: { threadId: true, kind: true, metadata: true },
    });
    expect(ref?.threadId).toBe(threadId);
    expect(ref?.kind).toBe("asaas_payment");
    expect((ref?.metadata as Record<string, unknown>)?.paymentId).toBe(
      "pay_db_1",
    );
  });
});

// NOTE: Integration failures must reach the flow log as failures (issue #40): invoked as a
// tool_call, a missing credential returns a ToolMessage with status "error"; bad model input
// (invalid CPF) stays a plain success — normal operation, not an outage.
describe("asaas toolpack — integration failures are marked (issue #40)", () => {
  test("missing credential returns ToolMessage status error", async () => {
    const { impl, calls } = stubFetch(200, {});
    const tool = asaasToolpack.build(
      sel({ enabledTools: ["asaas_payment_status"], credentialRef: null }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      type: "tool_call",
      id: "call_as_1",
      name: "asaas_payment_status",
      args: { paymentLinkId: "plink_1" },
    })) as ToolMessage;
    expect(out.status).toBe("error");
    expect(String(out.content)).toContain("not configured");
    expect(calls).toHaveLength(0);
  });

  test("a rejected customer lookup fails the call — no duplicate customer POST", async () => {
    const { impl, calls } = scriptedFetch([
      {
        match: (u, i) =>
          u.includes("/customers?cpfCnpj=") && i.method === "GET",
        status: 500,
        json: { error: "boom" },
      },
    ]);
    const tool = asaasToolpack.build(
      sel({
        enabledTools: ["asaas_create_pix_charge"],
        config: { environment: "sandbox" },
      }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      type: "tool_call",
      id: "call_as_3",
      name: "asaas_create_pix_charge",
      args: { value: 10, customerName: "X", cpfCnpj: "12345678909" },
    })) as ToolMessage;
    expect(out.status).toBe("error");
    expect(String(out.content)).toContain("customer lookup (HTTP 500)");
    // NOTE: Exactly ONE request (the lookup): the create branch must never run on a rejected lookup.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("a malformed 2xx lookup body fails the call — no duplicate customer POST", async () => {
    // NOTE: Malformed shapes a 2xx can carry: no data array at all, a non-empty data array whose
    // first customer has no string id, and a blank id (customerId would stay falsy and reach the
    // create branch). Any of them falling through would POST a duplicate customer.
    for (const body of [
      {},
      { data: [{ nome: "sem id" }] },
      { data: [{ id: "   " }] },
    ]) {
      const { impl, calls } = scriptedFetch([
        {
          match: (u, i) =>
            u.includes("/customers?cpfCnpj=") && i.method === "GET",
          status: 200,
          json: body,
        },
      ]);
      const tool = asaasToolpack.build(
        sel({
          enabledTools: ["asaas_create_pix_charge"],
          config: { environment: "sandbox" },
        }),
        baseCtx({ fetchImpl: impl }),
      )[0];
      const out = (await tool?.invoke({
        type: "tool_call",
        id: "call_as_4",
        name: "asaas_create_pix_charge",
        args: { value: 10, customerName: "X", cpfCnpj: "12345678909" },
      })) as ToolMessage;
      expect(out.status).toBe("error");
      expect(String(out.content)).toContain("unexpected response");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init.method).toBe("GET");
    }
  });

  test("an invalid CPF (model input) is NOT marked as a failure", async () => {
    const { impl, calls } = stubFetch(200, {});
    const tool = asaasToolpack.build(
      sel({
        enabledTools: ["asaas_create_pix_charge"],
        config: { environment: "sandbox" },
      }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      type: "tool_call",
      id: "call_as_2",
      name: "asaas_create_pix_charge",
      args: { value: 10, customerName: "X", cpfCnpj: "123" },
    })) as ToolMessage;
    expect(out.status).toBe("success");
    expect(calls).toHaveLength(0);
  });
});
