import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
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
      sel({ enabledTools: ["email_send"] }),
      baseCtx(),
    );
    expect(tools.map((t) => t.name)).toEqual(["email_send"]);
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
      sel({ enabledTools: ["email_send"], config }),
      ctx,
    );
    return tools[0];
  }

  test("config from + replyTo land in the request body; the model's args cannot override them", async () => {
    const { impl, calls } = stubFetch(200, { id: "email_1" });
    const tool = sendTool(
      { from: "Nina <nina@example.com>", replyTo: "contato@example.com" },
      baseCtx({ fetchImpl: impl }),
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
      baseCtx({ fetchImpl: impl }),
    );
    const out = await tool?.invoke({
      to: "lead@example.com",
      subject: "Oi",
      html: "<p>Oi</p>",
    });
    expect(String(out)).toContain("not verified");
  });
});

describe("resend toolpack — email_status", () => {
  function statusTool(ctx: ToolpackCtx) {
    const tools = resendToolpack.build(
      sel({ enabledTools: ["email_status"] }),
      ctx,
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
    expect(out).toContain("emailId returned by email_send");
    expect(calls).toHaveLength(0);
  });

  test("a 404 answers recoverable guidance", async () => {
    const { impl } = stubFetch(404, { name: "not_found" });
    const tool = statusTool(baseCtx({ fetchImpl: impl }));
    const out = String(await tool?.invoke({ emailId: "email_zz" }));
    expect(out).toContain("HTTP 404");
  });
});
