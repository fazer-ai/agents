import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import { ensureConversationRef } from "@/modules/integrations/conversation-ref";
import {
  type FetchBackConfig,
  mapFetchedResource,
  noticeResourceId,
  parseFetchBackConfig,
} from "@/modules/integrations/fetch-back";
import {
  fetchBackToolProblem,
  runFetchBack,
} from "@/modules/integrations/fetch-back-run";
import {
  createIntegrationInstance,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import { createToolDefinition } from "@/modules/tool-definitions/service";
import {
  NOTICE_WINDOW_MS,
  processInboundDelivery,
  receiveInbound,
} from "@/modules/webhooks/inbound/service";
import {
  parseSignatureConfig,
  renderSignedMessage,
  signatureCoversId,
} from "@/modules/webhooks/inbound/signed-message";
import { dbProbeFailed } from "@/tests/db-gate";

// A gateway that notifies with an id only, as Mercado Pago does: `POST <url>?data.id=123&type=payment`
// with `{"action":"payment.updated","type":"payment","data":{"id":"123"}}`, signed over a manifest
// of the id, `x-request-id` and `ts`. What happened is read from `GET /v1/payments/{id}` with the
// seller's access token, whose answer carries `status`, `external_reference` (what the charge was
// created with), `transaction_amount` and `currency_id`. The fake API below answers in that shape.

const SECRET = "mp-app-secret";
const TOKEN = "TEST-access-token";
const hmac = (secret: string, msg: string) =>
  createHmac("sha256", secret).update(msg).digest("hex");
const lookup =
  (h: Record<string, string>) =>
  (n: string): string | null =>
    h[n.toLowerCase()] ?? h[n] ?? null;

const MP_SIGNATURE = {
  format: "parts",
  signaturePart: "v1",
  timestampPart: "ts",
  message:
    "[[id:{{query.data.id|lower}};]][[request-id:{{header.x-request-id}};]]ts:{{sig.ts}};",
};
const STATUSES = [
  { status: "approved", paid: true, text: "Pagamento aprovado" },
  { status: "rejected", text: "Pagamento recusado, ofereça outro meio" },
];
const fetchBackOf = (toolId: bigint | string | number, over = {}) => ({
  toolId: String(toolId),
  idFrom: "query.data.id",
  idArg: "payment_id",
  conversationRefPath: "external_reference",
  statusPath: "status",
  valuePath: "transaction_amount",
  currencyPath: "currency_id",
  statuses: STATUSES,
  ...over,
});

const parsed = (raw: unknown) => {
  const c = parseFetchBackConfig(raw);
  if (!c || "problem" in c) throw new Error(JSON.stringify(c));
  return c;
};

describe("which tools can serve a consult-back", () => {
  const tool = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    urlTemplate: "https://8.8.8.8/v1/payments/{{payment_id}}",
    headers: {},
    query: {},
    body: {},
    inputSchema: { payment_id: { type: "string", required: true } },
    ...over,
  });
  test.each([
    ["an enabled tool with an AI field for the id", tool(), null],
    ["no tool", null, /no HTTP tool/],
    ["a disabled tool", tool({ enabled: false }), /disabled/],
    [
      "{{conversation_ref}}, which only a conversation has",
      tool({
        urlTemplate:
          "https://8.8.8.8/v1/p/{{payment_id}}?r={{conversation_ref}}",
      }),
      /conversation_ref/,
    ],
    [
      "{{contact_phone}} in a header",
      tool({
        headers: { "x-phone": "{{contact_phone}}" },
      }),
      /contact_phone/,
    ],
    [
      "an id field the operator fixed",
      tool({
        inputSchema: {
          payment_id: { type: "string", source: "fixed", value: "1" },
        },
      }),
      /no field "payment_id"/,
    ],
    [
      "an id field that takes a number, while the lookup hands it text",
      tool({
        inputSchema: { payment_id: { type: "integer", required: true } },
      }),
      /not text/,
    ],
    [
      "another field the call cannot run without",
      tool({
        inputSchema: {
          payment_id: { type: "string", required: true },
          store: { type: "string", required: true },
        },
      }),
      /also requires "store"/,
    ],
    [
      "another field that is optional, or fixed",
      tool({
        inputSchema: {
          payment_id: { type: "string", required: true },
          note: { type: "string" },
          store: { type: "string", source: "fixed", value: "1" },
        },
      }),
      null,
    ],
  ])("%s", (_, t, problem) => {
    const got = fetchBackToolProblem(t as never, "payment_id");
    if (problem === null) expect(got).toBeNull();
    else expect(got).toMatch(problem as RegExp);
  });
});

describe("an id the signature covers with fixed boundaries", () => {
  const sig = (message: string) => ({ format: "hex", message });
  test.each([
    ["Mercado Pago's manifest", MP_SIGNATURE, true],
    ["the id between literal text", sig("id:{{query.id}};{{body}}"), true],
    ["the id at the end, after text", sig("{{header.x-t}}.{{query.id}}"), true],
    [
      "the id right before another value",
      sig("{{query.id}}{{header.x-request-id}}"),
      false,
    ],
    [
      "the id right after another value",
      sig("{{header.x-a}}{{query.id}};"),
      false,
    ],
    [
      "two values run together before the id",
      sig("{{header.x-a}}{{header.x-b}};{{query.id}};"),
      false,
    ],
    ["the id not in the message", sig("{{body}}"), false],
    [
      "a separator that drops with an optional group",
      sig("{{header.x}}[[;{{query.optional}};]]{{query.id}};"),
      false,
    ],
  ])("%s", (_, signature, covered) => {
    expect(
      signatureCoversId(
        signature,
        "query",
        MP_SIGNATURE === signature ? "data.id" : "id",
      ),
    ).toBe(covered);
  });
});

test("a value that runs into the text of the next group is refused, the group between them dropped", () => {
  const parsed = parseSignatureConfig({
    message: "[[{{header.x}}]][[{{header.y}}]];{{body}}",
  });
  if (!parsed || "problem" in parsed) throw new Error("config");
  const render = (x: string) =>
    renderSignedMessage(parsed.groups, {
      rawBody: "B",
      getHeader: lookup({ x }),
      getQuery: lookup({}),
      parts: new Map(),
    });
  expect(render("1")).toBe("1;B");
  expect(render("1;2")).toBe("ambiguous");
});

describe("the consult-back config", () => {
  test("a Mercado Pago config reads back whole", () => {
    expect(parsed(fetchBackOf(7))).toMatchObject({
      toolId: 7n,
      idFrom: { source: "query", name: "data.id" },
      idArg: "payment_id",
      eventIdPath: null,
      statuses: [
        { status: "approved", paid: true, text: "Pagamento aprovado" },
        { status: "rejected", paid: false },
      ],
    });
  });

  test.each([
    ["no tool", { toolId: "" }, "toolId"],
    [
      "an id source outside query, header and body",
      { idFrom: "path.id" },
      "idFrom",
    ],
    ["a field name that is not one", { idArg: "payment id" }, "idArg"],
    [
      "no path to the conversation",
      { conversationRefPath: "" },
      "conversationRefPath",
    ],
    ["a path with a bracket", { statusPath: "a[0]" }, "statusPath"],
    ["no status to act on", { statuses: [] }, "statuses"],
    [
      "a status listed twice",
      { statuses: [STATUSES[0], STATUSES[0]] },
      "statuses.1.status",
    ],
    [
      "a status that is neither a payment nor has a text",
      { statuses: [{ status: "in_process" }] },
      "statuses.0.text",
    ],
    [
      "more than 20 statuses",
      {
        statuses: Array.from({ length: 21 }, (_, i) => ({
          status: `s${i}`,
          text: "t",
        })),
      },
      "statuses",
    ],
  ])("refuses %s", (_, over, field) => {
    expect(parseFetchBackConfig(fetchBackOf(7, over))).toMatchObject({
      field,
    });
  });

  test("the id comes from where the config says, and only a plain id is taken", () => {
    const cfg = parsed(fetchBackOf(7));
    const from = (query: Record<string, string>) =>
      noticeResourceId(cfg, {
        parsedBody: { data: { id: "body-id" } },
        getHeader: lookup({}),
        getQuery: lookup(query),
      });
    expect(from({ "data.id": "123456" })).toBe("123456");
    expect(from({})).toBeNull();
    expect(from({ "data.id": "../payments/9" })).toBeNull();
    expect(from({ "data.id": "1?x=2" })).toBeNull();
    expect(from({ "data.id": "a".repeat(65) })).toBeNull();
    const body = parsed(fetchBackOf(7, { idFrom: "body.data.id" }));
    expect(
      noticeResourceId(body, {
        parsedBody: { data: { id: 42 } },
        getHeader: lookup({}),
        getQuery: lookup({}),
      }),
    ).toBe("42");
  });

  describe("the provider's answer, mapped", () => {
    const cfg: FetchBackConfig = parsed(fetchBackOf(7));
    test("a paid status is a conversion with its value, deduplicated by id and status", () => {
      expect(
        mapFetchedResource(cfg, "123", {
          id: 123,
          status: "approved",
          external_reference: "ref-abc",
          transaction_amount: 150.5,
          currency_id: "brl",
        }),
      ).toEqual({
        ok: true,
        event: {
          kind: "conversion",
          externalId: "ref-abc",
          dedupeKey: "123:approved",
          status: "approved",
          text: "Pagamento aprovado",
          value: 150.5,
          currency: "BRL",
        },
      });
    });
    test("another listed status is a nudge with the operator's text and no value", () => {
      expect(
        mapFetchedResource(cfg, "123", {
          status: "rejected",
          external_reference: "ref-abc",
          transaction_amount: 150.5,
        }),
      ).toEqual({
        ok: true,
        event: {
          kind: "agent_nudge",
          externalId: "ref-abc",
          dedupeKey: "123:rejected",
          status: "rejected",
          text: "Pagamento recusado, ofereça outro meio",
        },
      });
    });
    test("an unlisted status is ignored, and an answer without the ref or the status is invalid", () => {
      expect(
        mapFetchedResource(cfg, "1", {
          status: "pending",
          external_reference: "r",
        }),
      ).toEqual({ ok: false, reason: "unhandled" });
      expect(mapFetchedResource(cfg, "1", { status: "approved" })).toEqual({
        ok: false,
        reason: "invalid",
        detail: "external_reference",
      });
    });
    test("an event id path, when set, names the event instead of the notified id", () => {
      const withEvent = parsed(fetchBackOf(7, { eventIdPath: "charge.id" }));
      const r = mapFetchedResource(withEvent, "notice-1", {
        charge: { id: "ch_9" },
        status: "rejected",
        external_reference: "r",
      });
      expect(r.ok && r.event.dedupeKey).toBe("ch_9:rejected");
    });
  });
});

// ── against the database ──
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

describe.skipIf(!dbUp)("a thin notification answered by a consult-back", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  const extraTenants: bigint[] = [];
  let instanceId = 0n;
  let routeToken = "";
  let toolId = 0n;
  let secretRef = "";
  const ctx = (id = tenantId): TenantContext => ({
    tenantId: id,
    userId: null,
    role: "TENANT_ADMIN",
  });

  // The fake payments API: what each id answers, and every request it saw.
  const payments = new Map<string, { code: number; body: unknown }>();
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization");
    seen.push({ url: String(url), auth });
    if (auth !== `Bearer ${TOKEN}`) return new Response("{}", { status: 401 });
    const id = /\/v1\/payments\/([^/?]+)$/.exec(String(url))?.[1] ?? "";
    const p = payments.get(id) ?? { code: 404, body: { message: "not found" } };
    return new Response(JSON.stringify(p.body), {
      status: p.code,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const nudges: Record<string, unknown>[] = [];
  const deps = {
    runFetchBack: (p: Parameters<typeof runFetchBack>[0]) =>
      runFetchBack({ ...p, deps: { fetchImpl } }),
    runNudge: async (args: unknown) => {
      nudges.push(args as Record<string, unknown>);
      return "messaged" as const;
    },
  };

  let reqSeq = 0;
  const signedFor = (id: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const requestId = `req-${++reqSeq}`;
    const sig = hmac(
      SECRET,
      `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`,
    );
    return {
      getHeader: lookup({
        "x-signature": `ts=${ts},v1=${sig}`,
        "x-request-id": requestId,
      }),
      getQuery: lookup({ "data.id": id, type: "payment" }),
    };
  };
  const notify = async (
    id: string,
    action = "payment.updated",
    token = routeToken,
  ) =>
    receiveInbound({
      routeToken: token,
      rawBody: JSON.stringify({ action, type: "payment", data: { id } }),
      ...signedFor(id),
      base: appDb,
    });
  const process_ = (deliveryId: bigint) =>
    processInboundDelivery({
      deliveryId,
      tenantId,
      base: appDb,
      deps: deps as never,
    });
  const mint = async (thread: number, instance = instanceId) => {
    const m = await ensureConversationRef({
      tenantId,
      integrationInstanceId: instance,
      threadId: `${tenantId}:1:${thread}`,
      base: appDb,
    });
    if (!m.ok) throw new Error("mint");
    return m.ref;
  };
  const rows = (instance = instanceId) =>
    suDb.inboundDelivery.findMany({
      where: { integrationInstanceId: instance },
      select: { id: true, dedupeKey: true, status: true, payload: true },
      orderBy: { id: "asc" },
    });

  const getPayment = (over: Record<string, unknown> = {}) => ({
    name: "consultar_pagamento",
    label: "Consultar pagamento",
    method: "GET" as const,
    urlTemplate: "https://8.8.8.8/v1/payments/{{payment_id}}",
    allowedHosts: ["8.8.8.8"],
    inputSchema: { payment_id: { type: "string", required: true } },
    credentialRef: secretRef,
    ...over,
  });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "FETCHBACK", slug: `fetchback-${process.pid}` },
    });
    tenantId = t.id;
    const o = await suDb.tenant.create({
      data: { name: "FETCHBACK-OTHER", slug: `fetchback-o-${process.pid}` },
    });
    otherTenantId = o.id;
    const sigSecret = await suDb.vaultEntry.create({
      data: { tenantId, name: "mp-signature", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const token = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "mp-token",
        kind: "bearer_token",
        secret: encryptJson(TOKEN),
      },
      select: { id: true },
    });
    secretRef = `vault:${token.id}`;
    const tool = await createToolDefinition(
      ctx(),
      getPayment() as never,
      appDb,
    );
    toolId = BigInt(tool.id);
    const g = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Mercado Pago",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${sigSecret.id}`,
        config: {
          signatureHeader: "x-signature",
          signature: MP_SIGNATURE,
          fetchBack: fetchBackOf(toolId),
        },
      },
      appDb,
    );
    instanceId = g.id;
    routeToken = g.routeToken as string;
  });

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId, ...extraTenants]) {
      if (!id) continue;
      for (const table of [
        "scheduler_jobs",
        "agent_tool_selections",
        "agents",
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

  test("an approved payment, looked up with the seller's token, is one conversion and one nudge", async () => {
    const ref = await mint(101);
    payments.set("1001", {
      code: 200,
      body: {
        id: 1001,
        status: "approved",
        external_reference: ref,
        transaction_amount: 150.5,
        currency_id: "BRL",
      },
    });
    const before = seen.length;
    const r = await notify("1001", "payment.created");
    expect(r.outcome).toBe("queued");
    expect(await process_(r.deliveryId as bigint)).toBe("processed");

    expect(seen.slice(before)).toEqual([
      { url: "https://8.8.8.8/v1/payments/1001", auth: `Bearer ${TOKEN}` },
    ]);
    const conv = await suDb.conversionEvent.findMany({
      where: { tenantId, threadId: `${tenantId}:1:101` },
      select: { source: true, value: true, currency: true },
    });
    expect(conv.map((c) => [c.source, Number(c.value), c.currency])).toEqual([
      ["GENERIC", 150.5, "BRL"],
    ]);
    expect(nudges.at(-1)).toMatchObject({
      threadId: `${tenantId}:1:101`,
      deliverToResolved: true,
      nudge: {
        source: "GENERIC",
        status: "approved",
        text: "Pagamento aprovado",
        value: 150.5,
        currency: "BRL",
      },
    });
    const all = await rows();
    const notice = all.find((x) => x.id === r.deliveryId);
    expect(notice?.status).toBe("PROCESSED");
    expect(
      all.filter((x) => x.dedupeKey === "1001:approved").map((x) => x.status),
    ).toEqual(["PROCESSED"]);

    // The same payment notified again (`payment.updated`) is looked up again and maps to the
    // event already recorded: no second nudge. The very same notification is a duplicate at once.
    const n = nudges.length;
    const again = await notify("1001", "payment.updated");
    expect(again.outcome).toBe("queued");
    await process_(again.deliveryId as bigint);
    expect(nudges.length).toBe(n);
  });

  test("a pending payment is not acted on, and the notice for its approval is", async () => {
    const ref = await mint(102);
    payments.set("1002", {
      code: 200,
      body: { status: "pending", external_reference: ref },
    });
    const n = nudges.length;
    const first = await notify("1002", "payment.created");
    await process_(first.deliveryId as bigint);
    expect(nudges.length).toBe(n);
    expect((await rows()).find((x) => x.id === first.deliveryId)?.status).toBe(
      "PROCESSED",
    );

    payments.set("1002", {
      code: 200,
      body: {
        status: "rejected",
        external_reference: ref,
        transaction_amount: 80,
      },
    });
    const second = await notify("1002", "payment.updated");
    await process_(second.deliveryId as bigint);
    expect(nudges.at(-1)).toMatchObject({
      threadId: `${tenantId}:1:102`,
      nudge: {
        status: "rejected",
        text: "Pagamento recusado, ofereça outro meio",
        value: null,
      },
    });
    expect(
      await suDb.conversionEvent.count({
        where: { tenantId, threadId: `${tenantId}:1:102` },
      }),
    ).toBe(0);
  });

  test("a reference minted by another instance reaches no conversation", async () => {
    const other = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Outra integração",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: (
          await suDb.integrationInstance.findUniqueOrThrow({
            where: { id: instanceId },
            select: { inboundSecretRef: true },
          })
        ).inboundSecretRef as string,
        config: {},
      },
      appDb,
    );
    const foreign = await mint(103, other.id);
    payments.set("1003", {
      code: 200,
      body: {
        status: "approved",
        external_reference: foreign,
        transaction_amount: 10,
      },
    });
    const n = nudges.length;
    const r = await notify("1003");
    await process_(r.deliveryId as bigint);
    expect(nudges.length).toBe(n);
    expect(
      await suDb.conversionEvent.count({
        where: { tenantId, threadId: `${tenantId}:1:103` },
      }),
    ).toBe(0);
  });

  test("a provider error the same id may answer later is retried, one it would answer the same is FAILED", async () => {
    payments.set("1004", { code: 503, body: {} });
    const r = await notify("1004");
    await expect(process_(r.deliveryId as bigint)).rejects.toThrow(
      /will be retried/,
    );
    expect((await rows()).find((x) => x.id === r.deliveryId)?.status).toBe(
      "PROCESSING",
    );
    expect(
      (await rows()).filter((x) => x.dedupeKey.startsWith("1004:")),
    ).toEqual([]);

    const gone = await notify("1999");
    expect(await process_(gone.deliveryId as bigint)).toBe("processed");
    expect((await rows()).find((x) => x.id === gone.deliveryId)?.status).toBe(
      "FAILED",
    );
  });

  test("an id that is not a plain id is refused before anything is looked up", async () => {
    const before = seen.length;
    const r = await notify("..%2F1");
    expect(r.outcome).toBe("invalid");
    expect(seen.length).toBe(before);
  });

  test("a notice for another instance's route never runs this instance's tool", async () => {
    const before = seen.length;
    await expect(
      notify("1001", "payment.updated", "not-a-route"),
    ).rejects.toBeDefined();
    expect(seen.length).toBe(before);
  });

  test("a notice after its window's lookup books one more for the next window, and the payment's later state is acted on", async () => {
    const ref = await mint(106);
    payments.set("1006", {
      code: 200,
      body: { status: "pending", external_reference: ref },
    });
    const start =
      Math.ceil(Date.now() / NOTICE_WINDOW_MS + 1) * NOTICE_WINDOW_MS;
    setSystemTime(new Date(start + 1_000));
    try {
      const first = await notify("1006", "payment.updated");
      expect(first.outcome).toBe("queued");
      await process_(first.deliveryId as bigint);
      // The payment is approved and the gateway sends a bare notice again within the window.
      payments.set("1006", {
        code: 200,
        body: {
          status: "approved",
          external_reference: ref,
          transaction_amount: 30,
          currency_id: "BRL",
        },
      });
      const before = seen.length;
      const again = await notify("1006", "payment.updated");
      expect(again).toMatchObject({ outcome: "queued", deferred: true });
      expect(again.deliveryId).not.toBe(first.deliveryId);
      expect(seen.length).toBe(before);
      const job = await suDb.schedulerJob.findFirstOrThrow({
        where: {
          tenantId,
          kind: "INBOUND_REDISPATCH",
          dedupeKey: `inbound-delivery:${again.deliveryId}:0`,
        },
        select: { runAt: true },
      });
      expect(job.runAt.getTime()).toBe(start + NOTICE_WINDOW_MS);
      // A replay with other bytes (whitespace) in the same window books nothing more.
      const replay = await receiveInbound({
        routeToken,
        rawBody:
          ' {"action":"payment.updated","type":"payment","data":{"id":"1006"}} ',
        ...signedFor("1006"),
        base: appDb,
      });
      expect(replay.outcome).toBe("duplicate");
      // The job runs at the next window and the approval is acted on.
      setSystemTime(new Date(start + NOTICE_WINDOW_MS + 1_000));
      await process_(again.deliveryId as bigint);
      expect(seen.length).toBe(before + 1);
      expect(
        await suDb.conversionEvent.count({
          where: { tenantId, threadId: `${tenantId}:1:106` },
        }),
      ).toBe(1);
    } finally {
      setSystemTime();
    }
  });

  test("an agent bundle carries the lookup tool by name, and the import points the lookup at its copy", async () => {
    const dst = await suDb.tenant.create({
      data: { name: "FETCHBACK-DST", slug: `fetchback-d-${process.pid}` },
    });
    extraTenants.push(dst.id);
    const charge = await createToolDefinition(
      ctx(),
      {
        name: "criar_cobranca",
        label: "Criar cobrança",
        method: "POST",
        urlTemplate: "https://8.8.8.8/v1/payments",
        allowedHosts: ["8.8.8.8"],
        body: {
          mode: "kv",
          rows: [{ key: "external_reference", value: "{{conversation_ref}}" }],
        },
        conversationRefIntegrationId: String(instanceId),
      } as never,
      appDb,
    );
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Cobrança",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "HTTP",
        toolDefinitionId: BigInt(charge.id),
        enabledTools: [],
        knowledgeBaseIds: [],
      },
    });
    const exp = await exportAgent(ctx(), agent.id, appDb, {
      includeComponents: true,
    });
    const inst = exp.components?.integrations.find(
      (i) => i.catalogType === "GENERIC" && i.name === "Mercado Pago",
    );
    expect(
      ((inst?.config.fetchBack ?? {}) as Record<string, unknown>).toolName,
    ).toBe("consultar_pagamento");
    expect(
      ((inst?.config.fetchBack ?? {}) as Record<string, unknown>).toolId,
    ).toBeUndefined();
    expect(exp.components?.httpTools.map((h) => h.name).sort()).toEqual([
      "consultar_pagamento",
      "criar_cobranca",
    ]);

    const { warnings } = await importAgent(ctx(dst.id), exp, appDb);
    const copy = await suDb.toolDefinition.findFirstOrThrow({
      where: { tenantId: dst.id, name: "consultar_pagamento" },
    });
    const dstInst = await suDb.integrationInstance.findFirstOrThrow({
      where: { tenantId: dst.id, catalogType: "GENERIC", name: "Mercado Pago" },
    });
    expect(
      (dstInst.config as { fetchBack: Record<string, unknown> }).fetchBack,
    ).toMatchObject({ toolId: String(copy.id), idArg: "payment_id" });
    expect(
      warnings.some((w) => w.code === "integrationLookupToolNotFound"),
    ).toBe(false);
    // The lookup tool is not granted to the imported agent: it only answers notifications.
    const grants = await suDb.agentToolSelection.findMany({
      where: { tenantId: dst.id, source: "HTTP" },
      select: { toolDefinitionId: true },
    });
    expect(grants.map((g) => g.toolDefinitionId)).not.toContain(copy.id);
  });

  describe("the save refuses a consult-back that cannot work or would leak", () => {
    const create = (config: Record<string, unknown>, catalogType = "GENERIC") =>
      createIntegrationInstance(
        ctx(),
        {
          catalogType,
          name: `refused-${++reqSeq}`,
          inboundAuthStrategy: "HMAC_SHA256",
          inboundSecretRef: secretRef,
          config,
        } as never,
        appDb,
      );
    const mpConfig = (fetchBack: Record<string, unknown>) => ({
      signatureHeader: "x-signature",
      signature: MP_SIGNATURE,
      fetchBack,
    });

    test("a tool that renders a conversation variable", async () => {
      const t = await createToolDefinition(
        ctx(),
        getPayment({
          name: "com_contato",
          urlTemplate:
            "https://8.8.8.8/v1/payments/{{payment_id}}?phone={{contact_phone}}",
        }) as never,
        appDb,
      );
      await expect(create(mpConfig(fetchBackOf(t.id)))).rejects.toMatchObject({
        statusCode: 400,
        field: "config.fetchBack.toolId",
      });
    });

    test("a tool with no field for the id", async () => {
      const t = await createToolDefinition(
        ctx(),
        getPayment({
          name: "sem_campo",
          urlTemplate: "https://8.8.8.8/v1/payments/search",
          inputSchema: {},
        }) as never,
        appDb,
      );
      await expect(create(mpConfig(fetchBackOf(t.id)))).rejects.toMatchObject({
        field: "config.fetchBack.toolId",
      });
    });

    test("a tool of another workspace", async () => {
      const foreign = await createToolDefinition(
        ctx(otherTenantId),
        getPayment({ credentialRef: null }) as never,
        appDb,
      );
      await expect(
        create(mpConfig(fetchBackOf(foreign.id))),
      ).rejects.toMatchObject({ field: "config.fetchBack.toolId" });
    });

    test("an id read from where the signature does not reach", async () => {
      await expect(
        create(mpConfig(fetchBackOf(toolId, { idFrom: "body.data.id" }))),
      ).rejects.toMatchObject({ field: "config.fetchBack.idFrom" });
      await expect(
        create(mpConfig(fetchBackOf(toolId, { idFrom: "header.x-id" }))),
      ).rejects.toMatchObject({ field: "config.fetchBack.idFrom" });
      await expect(
        create({
          signatureHeader: "x-signature",
          signature: { message: "{{query.id}}{{header.x-request-id}}" },
          fetchBack: fetchBackOf(toolId, { idFrom: "query.id" }),
        }),
      ).rejects.toMatchObject({ field: "config.fetchBack.idFrom" });
    });

    test("a consult-back on anything but the generic webhook", async () => {
      await expect(
        create({ fetchBack: fetchBackOf(toolId) }, "ASAAS"),
      ).rejects.toMatchObject({ statusCode: 400, field: "config.fetchBack" });
    });

    test("an update that breaks it keeps what was stored", async () => {
      await expect(
        updateIntegrationInstance(
          ctx(),
          instanceId,
          {
            config: mpConfig(fetchBackOf(toolId, { statuses: [] })),
          },
          appDb,
        ),
      ).rejects.toMatchObject({ field: "config.fetchBack.statuses" });
      const row = await suDb.integrationInstance.findUniqueOrThrow({
        where: { id: instanceId },
        select: { config: true },
      });
      expect((row.config as Record<string, unknown>).fetchBack).toEqual(
        fetchBackOf(toolId),
      );
    });
  });
});
