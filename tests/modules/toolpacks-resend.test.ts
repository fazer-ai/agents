import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { resendToolpack } from "@/modules/integrations/toolpacks/resend";
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

const noopAssert = async () => undefined;

function baseCtx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    // The send tool's persist-ref path treats a failed write as a reported side effect (the email
    // already went out), so an absent base never changes a tool's return value.
    base: undefined as unknown as PrismaClient,
    threadId: "1:1:1",
    resolveCredential: async () => "re_test_key",
    assertSafe: noopAssert,
    onSideEffectError: () => undefined,
    ...over,
  };
}

function sel(over: Partial<IntegrationSelection> = {}): IntegrationSelection {
  return {
    instanceId: 1n,
    catalogType: "RESEND",
    config: { from: "Nina <nina@example.com>", replyTo: "contato@example.com" },
    credentialRef: "resend-key",
    enabledTools: [],
    ...over,
  };
}

describe("resend toolpack — allowlist (fail-closed)", () => {
  test("empty allowlist → no tools", () => {
    expect(resendToolpack.build(sel({ enabledTools: [] }), baseCtx())).toEqual(
      [],
    );
  });
  test("only allowlisted tools are exposed", () => {
    const tools = resendToolpack.build(
      sel({ enabledTools: ["resend_send_email"] }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name)).toEqual(["resend_send_email"]);
  });
  test("an unknown tool name yields nothing", () => {
    expect(
      resendToolpack.build(sel({ enabledTools: ["bogus"] }), baseCtx()),
    ).toEqual([]);
  });
});

describe("resend toolpack — sender is bound to config, never an arg", () => {
  function sendTool(config: Record<string, unknown>, ctx: ToolpackCtx) {
    const tools = resendToolpack.build(
      sel({ enabledTools: ["resend_send_email"], config }),
      ctx,
    );
    return tools[0];
  }

  test("config from + replyTo land in the request body; the model's args cannot override them", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_1" });
    const tool = sendTool(
      { from: "Nina <nina@example.com>", replyTo: "contato@example.com" },
      baseCtx({
        fetchImpl: impl,
        contactDbId: 7n,
        resolveContactEmail: async () => "lead@example.com",
      }),
    );
    const out = await tool?.invoke({
      to: "lead@example.com",
      subject: "Reunião confirmada",
      html: "<p>Confirmada.</p>",
    });
    expect(String(out)).toContain("email_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.from).toBe("Nina <nina@example.com>");
    expect(body.reply_to).toBe("contato@example.com");
    expect(body.to).toBe("lead@example.com");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
  });

  test("a blank from fails closed (no request goes out)", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_1" });
    const tool = sendTool({ from: "  " }, baseCtx({ fetchImpl: impl }));
    const out = await tool?.invoke({
      to: "lead@example.com",
      subject: "Oi",
      html: "<p>Oi</p>",
    });
    expect(String(out)).toContain("sender address is not configured");
    expect(calls).toHaveLength(0);
  });

  test("a missing credential fails closed (no request goes out)", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_1" });
    const tool = sendTool(
      { from: "Nina <nina@example.com>" },
      baseCtx({ fetchImpl: impl, resolveCredential: async () => null }),
    );
    const out = await tool?.invoke({
      to: "lead@example.com",
      subject: "Oi",
      html: "<p>Oi</p>",
    });
    expect(String(out)).toContain("credential is not configured");
    expect(calls).toHaveLength(0);
  });

  test("a 403 surfaces the unverified-domain hint", async () => {
    const { impl } = stubFetch(403, { name: "validation_error" });
    const tool = sendTool(
      { from: "Nina <nina@example.com>" },
      baseCtx({
        fetchImpl: impl,
        contactDbId: 7n,
        resolveContactEmail: async () => "lead@example.com",
      }),
    );
    const out = await tool?.invoke({
      to: "lead@example.com",
      subject: "Oi",
      html: "<p>Oi</p>",
    });
    expect(String(out)).toContain("not verified");
  });
});

// Postgres real a partir daqui: o gate por thread e a gravação da ref atravessam `runScopedOn`
// ($extends + $transaction + o GUC do RLS), e um dublê de `base` responderia à fiação, não à regra.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.TEST_MIGRATION_DATABASE_URL;
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
const THREAD = `resend-tp-${process.pid}`;

beforeAll(async () => {
  if (!dbUp) return;
  const t = await suDb.tenant.create({
    data: { name: "ResendTP", slug: `resend-tp-${process.pid}` },
  });
  tenantId = t.id;
  const inst = await suDb.integrationInstance.create({
    data: {
      tenantId,
      catalogType: "RESEND",
      name: "resend-test",
      config: { from: "Nina <nina@example.com>" },
      routeTokenHash: randomBytes(16).toString("hex"),
    },
  });
  instanceId = inst.id;
  for (const externalId of ["email_1", "email_zz", "email_big", "email_huge"])
    await suDb.integrationExternalRef.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        externalId,
        threadId: THREAD,
        kind: "resend_email",
        metadata: {},
      },
    });
});

afterAll(async () => {
  if (tenantId) {
    await suDb.$executeRawUnsafe(
      `DELETE FROM integration_external_refs WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM integration_instances WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  }
});

describe.skipIf(!dbUp)("resend toolpack — resend_email_status", () => {
  function statusTool(ctx: ToolpackCtx) {
    const tools = resendToolpack.build(
      sel({ enabledTools: ["resend_email_status"], instanceId }),
      { ...ctx, tenantId, base: appDb, threadId: THREAD },
    );
    return tools[0];
  }

  test("projects status-relevant fields only (never the html body)", async () => {
    const { impl, calls } = stubFetch(200, {
      id: "email_1",
      last_event: "delivered",
      to: ["lead@example.com"],
      subject: "Reunião confirmada",
      created_at: "2026-09-06T00:00:00Z",
      html: "<p>NEVER back into context</p>",
    });
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = String(await tool?.invoke({ emailId: "email_1" }));
    expect(calls[0]?.url).toBe("https://api.resend.com/emails/email_1");
    expect(out).toContain("delivered");
    expect(out).not.toContain("NEVER back into context");
  });

  test("a pasted URL is rejected with guidance (no request goes out)", async () => {
    const { impl, calls } = stubFetch(200, {});
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = String(
      await tool?.invoke({ emailId: "https://resend.com/emails/x" }),
    );
    expect(out).toContain("emailId returned by resend_send_email");
    expect(calls).toHaveLength(0);
  });

  test("a 404 answers recoverable guidance", async () => {
    const { impl } = stubFetch(404, { name: "not_found" });
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = String(await tool?.invoke({ emailId: "email_zz" }));
    expect(out).toContain("HTTP 404");
  });
});

// Hardening, from the review of PR #570.
describe("resend toolpack — who the recipient may be", () => {
  const contactCtx = (over: Partial<ToolpackCtx> = {}) =>
    baseCtx({
      contactDbId: 42n,
      resolveContactEmail: async () => "cliente@example.com",
      ...over,
    });

  test("the contact's own address goes through", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_1" });
    const tool = resendToolpack.build(
      sel({ enabledTools: ["resend_send_email"] }),
      contactCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      to: "cliente@example.com",
      subject: "Confirmação",
      html: "<p>ok</p>",
    })) as string;
    expect(out).toContain("email_1");
    expect(calls).toHaveLength(1);
  });

  test("any other address is refused, and nothing leaves", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_2" });
    const tool = resendToolpack.build(
      sel({ enabledTools: ["resend_send_email"] }),
      contactCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      to: "atacante@evil.example",
      subject: "Confirmação",
      html: "<p>segredo</p>",
    })) as string;
    expect(calls).toHaveLength(0);
    expect(out.toLowerCase()).toContain("atacante@evil.example");
  });

  test("no contact in scope refuses every address", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_3" });
    const tool = resendToolpack.build(
      sel({ enabledTools: ["resend_send_email"] }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const out = (await tool?.invoke({
      to: "cliente@example.com",
      subject: "x",
      html: "<p>x</p>",
    })) as string;
    expect(calls).toHaveLength(0);
    expect(typeof out).toBe("string");
  });

  test("an operator allowlist authorises an address the contact does not own", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_4" });
    const tool = resendToolpack.build(
      sel({
        enabledTools: ["resend_send_email"],
        config: {
          from: "Nina <nina@example.com>",
          allowedRecipients: ["financeiro@empresa.com", "@parceiro.com"],
        },
      }),
      baseCtx({ fetchImpl: impl }),
    )[0];
    const ok = (await tool?.invoke({
      to: "financeiro@empresa.com",
      subject: "x",
      html: "<p>x</p>",
    })) as string;
    expect(ok).toContain("email_4");
    const domain = (await tool?.invoke({
      to: "qualquer@parceiro.com",
      subject: "x",
      html: "<p>x</p>",
    })) as string;
    expect(domain).toContain("email_4");
    expect(calls).toHaveLength(2);
    const no = (await tool?.invoke({
      to: "outro@fora.com",
      subject: "x",
      html: "<p>x</p>",
    })) as string;
    expect(calls).toHaveLength(2);
    expect(no.toLowerCase()).toContain("outro@fora.com");
  });
});

describe.skipIf(!dbUp)(
  "resend toolpack — a status read that cannot be parsed",
  () => {
    test("a large email's status comes back readable, not as an empty object", async () => {
      const big = "<p>".concat("x".repeat(19_000), "</p>");
      const { impl } = stubFetch(200, {
        id: "email_big",
        last_event: "delivered",
        to: ["cliente@example.com"],
        subject: "Confirmação",
        created_at: "2026-09-15T00:00:00Z",
        html: big,
      });
      const tool = resendToolpack.build(
        sel({ enabledTools: ["resend_email_status"], instanceId }),
        {
          ...baseCtx({ fetchImpl: impl }),
          tenantId,
          base: appDb,
          threadId: THREAD,
        },
      )[0];
      const out = (await tool?.invoke({ emailId: "email_big" })) as string;
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed.last_event).toBe("delivered");
      expect(parsed.id).toBe("email_big");
      expect(out).not.toContain("xxxxx");
    });

    test("a body too large even for the raised cap fails loudly instead of answering {}", async () => {
      const huge = "y".repeat(400_000);
      const impl = (async () =>
        new Response(`{"id":"email_huge","html":"${huge}"`, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
      const tool = resendToolpack.build(
        sel({ enabledTools: ["resend_email_status"], instanceId }),
        {
          ...baseCtx({ fetchImpl: impl }),
          tenantId,
          base: appDb,
          threadId: THREAD,
        },
      )[0];
      const out = (await tool?.invoke({ emailId: "email_huge" })) as string;
      expect(out).not.toBe("{}");
      expect(out.toLowerCase()).toMatch(/too large|truncat|unexpected/);
    });
  },
);

describe("resend toolpack — what a muted turn may hold", () => {
  test("resend_send_email declares that it delivers to the customer", () => {
    const spec = resendToolpack.toolSpecs.find(
      (t) => t.name === "resend_send_email",
    );
    expect(spec?.deliversToCustomer).toBe(true);
  });
  test("resend_email_status does not, since it only reads", () => {
    const spec = resendToolpack.toolSpecs.find(
      (t) => t.name === "resend_email_status",
    );
    expect(spec?.deliversToCustomer ?? false).toBe(false);
  });
});

describe.skipIf(!dbUp)(
  "resend toolpack — the correlation ref is really written",
  () => {
    test("a send persists an IntegrationExternalRef keyed by the provider's email id", async () => {
      const { impl } = stubFetch(200, { id: "email_persisted" });
      const tool = resendToolpack.build(
        sel({ enabledTools: ["resend_send_email"], instanceId }),
        {
          ...baseCtx({
            fetchImpl: impl,
            contactDbId: 9n,
            resolveContactEmail: async () => "cliente@example.com",
          }),
          tenantId,
          base: appDb,
          threadId: THREAD,
        },
      )[0];

      const out = (await tool?.invoke({
        to: "cliente@example.com",
        subject: "Confirmação",
        html: "<p>ok</p>",
      })) as string;
      expect(out).toContain("email_persisted");

      const ref = await suDb.integrationExternalRef.findFirst({
        where: { tenantId, externalId: "email_persisted" },
        select: { threadId: true, kind: true, metadata: true },
      });
      expect(ref?.threadId).toBe(THREAD);
      expect(ref?.kind).toBe("resend_email");
      expect((ref?.metadata as Record<string, unknown>)?.subject).toBe(
        "Confirmação",
      );
    });

    // O que a PR nunca exercitou: com a linha gravada, o status daquele id é legível — e o de um id
    // de outra thread não é.
    test("the row the send wrote is what lets resend_email_status answer, and only for this thread", async () => {
      const { impl } = stubFetch(200, {
        id: "email_persisted",
        last_event: "delivered",
      });
      const ctx = {
        ...baseCtx({ fetchImpl: impl }),
        tenantId,
        base: appDb,
        threadId: THREAD,
      };
      const mine = resendToolpack.build(
        sel({ enabledTools: ["resend_email_status"], instanceId }),
        ctx,
      )[0];
      expect(
        String(await mine?.invoke({ emailId: "email_persisted" })),
      ).toContain("delivered");

      const other = resendToolpack.build(
        sel({ enabledTools: ["resend_email_status"], instanceId }),
        { ...ctx, threadId: `${THREAD}-outra` },
      )[0];
      expect(
        String(await other?.invoke({ emailId: "email_persisted" })),
      ).toContain("not sent from this conversation");
    });
  },
);
