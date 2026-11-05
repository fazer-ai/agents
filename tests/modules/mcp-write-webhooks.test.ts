import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { listCatalog } from "@/modules/integrations/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  alertChannelCreate,
  alertChannelTest,
  alertChannelUpdate,
  integrationCreate,
  integrationUpdate,
  webhookCreate,
  webhookDelete,
} from "@/modules/mcp/write-webhooks";
import { dbProbeFailed } from "@/tests/db-gate";
import { outboundUrl } from "../utils/outbound";

// Webhook/alert/integration write tools: gate is DB-free; dry-run, secret-by-reference, and the
// DB-only apply paths (create/delete) need a real Postgres. External delivery (webhook_test) is
// exercised live in Fase 8.

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP webhooks/alerts/integrations gate (no DB)", () => {
  test("webhook_create without mcp:write → insufficient_scope", async () => {
    const r = await webhookCreate(principal({ scopes: ["mcp:read"] }), {
      url: outboundUrl(),
      events: ["heartbeat"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("webhook_create with unknown event → error", async () => {
    const r = await webhookCreate(principal({}), {
      url: outboundUrl(),
      events: ["not.a.real.event"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown event");
  });

  // NOTE: `dry_run` DEFAULTS to true here, so the preview is the operator's FIRST answer, and it must not
  // echo the config back as approved when the apply would refuse it. A preview that answers only from
  // its own arguments is not a preview of anything.
  test("integration_create's dry run refuses a header name the apply would refuse", async () => {
    const r = await integrationCreate(principal({}), {
      catalog_type: "ASAAS",
      name: "hdr-dry",
      config: { authHeader: "asaas-access-token " },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("config.authHeader");
  });

  test("integration_create's dry run refuses a Sheets integration sent with no config", async () => {
    const r = await integrationCreate(principal({}), {
      catalog_type: "GOOGLE_SHEETS",
      name: "sheets-dry",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("config.spreadsheetId");
  });

  test("integration_create with unknown catalog_type → error", async () => {
    const r = await integrationCreate(principal({}), {
      catalog_type: "__nope__",
      name: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown catalog_type");
  });
});

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

describe.skipIf(!dbUp)("MCP webhooks/alerts/integrations tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let secretId = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "WA", slug: `wh-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "WB", slug: `wh-b-${process.pid}` },
    });
    tenantB = b.id;
    const sec = await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "wh-secret",
        kind: "generic",
        secret: encryptJson("signing-secret"),
      },
      select: { id: true },
    });
    secretId = sec.id;
    await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "discord-url",
        kind: "generic",
        secret: encryptJson(outboundUrl("/api/webhooks/123/abcdefTOKEN")),
      },
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM alert_channels WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM webhook_subscriptions WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM integration_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("webhook_create resolves secret NAME → vault:<id> on apply", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await webhookCreate(
      p,
      {
        url: outboundUrl("/in"),
        events: ["conversation.created"],
        secret_ref: "wh-secret",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.webhookSubscription.findFirst({
      where: { tenantId: tenantA, url: outboundUrl("/in") },
    });
    expect(row?.secretRef).toBe(`vault:${secretId}`);
    const audits = await suDb.auditLog.count({
      where: { tenantId: tenantA, action: "webhook.create" },
    });
    expect(audits).toBe(1);
  });

  test("alert_channel_create stores the token-bearing URL encrypted (never echoed)", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await alertChannelCreate(
      p,
      {
        name: "ops",
        type: "discord",
        url_ref: "discord-url",
        min_level: "error",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The plaintext token must not appear anywhere in the tool response.
      expect(JSON.stringify(r.data)).not.toContain("abcdefTOKEN");
    }
    const row = await suDb.alertChannel.findFirst({
      where: { tenantId: tenantA, name: "ops" },
    });
    expect(row).not.toBeNull();
  });

  test("alert_channel_create with unknown url ref → needsCredential (no write)", async () => {
    const p = principal({ tenantId: tenantA });
    const r = await alertChannelCreate(
      p,
      {
        name: "broken",
        type: "webhook",
        url_ref: "no-such-url",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.needsCredential).toBe(true);
    const row = await suDb.alertChannel.findFirst({
      where: { tenantId: tenantA, name: "broken" },
    });
    expect(row).toBeNull();
  });

  // NOTE: ── the test send on this transport ──
  //
  // `alert_channel_test` sits beside `webhook_test` and takes the same shape: one argument, no
  // `dry_run`, acts on the call. A preview of a test would be a preview of a preview, and the whole
  // value of the thing is that it ACTUALLY reaches the destination.

  async function withStubbedFetch<T>(
    reply: () => Response,
    fn: (sent: string[]) => Promise<T>,
  ): Promise<T> {
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      sent.push(String(url));
      return reply();
    }) as unknown as typeof fetch;
    try {
      return await fn(sent);
    } finally {
      globalThis.fetch = real;
    }
  }

  // NOTE: ── the destination URL passed raw, write-only ──
  //
  // A Discord webhook URL embeds the bot token, so every answer the tool gives (preview, apply,
  // refusal, test) and every audit row is searched for the token itself.

  const RAW_TOKEN = "rawURLtoken1696";

  async function auditText(tenantId: bigint): Promise<string> {
    const rows = await suDb.auditLog.findMany({ where: { tenantId } });
    return JSON.stringify(rows, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  }

  test("alert_channel_create takes the URL raw, stores it encrypted, and no answer or audit row carries it", async () => {
    const p = principal({ tenantId: tenantA });
    const url = outboundUrl(`/api/webhooks/1696/${RAW_TOKEN}`);
    const preview = await alertChannelCreate(
      p,
      { name: "raw-url", type: "discord", url },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(RAW_TOKEN);
    if (preview.ok) {
      const shown = preview.data.preview as Record<string, unknown>;
      expect(shown.urlMasked).toBe("https://203.0.113.10/…");
    }
    expect(
      await suDb.alertChannel.count({
        where: { tenantId: tenantA, name: "raw-url" },
      }),
    ).toBe(0);

    const applied = await alertChannelCreate(
      p,
      { name: "raw-url", type: "discord", url, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(JSON.stringify(applied)).not.toContain(RAW_TOKEN);
    const row = await suDb.alertChannel.findFirstOrThrow({
      where: { tenantId: tenantA, name: "raw-url" },
    });
    expect(row.url).not.toContain(RAW_TOKEN);
    expect(decryptJson<string>(row.url)).toBe(url);
    expect(await auditText(tenantA)).toContain("alert_channel.create");
    expect(await auditText(tenantA)).not.toContain(RAW_TOKEN);

    const tested = await withStubbedFetch(
      () => new Response(null, { status: 204 }),
      async (sent) => {
        const r = await alertChannelTest(
          p,
          { channel_id: String(row.id) },
          { base: appDb },
        );
        expect(sent).toEqual([url]);
        return r;
      },
    );
    expect(tested.ok).toBe(true);
    expect(JSON.stringify(tested)).not.toContain(RAW_TOKEN);
  });

  test("alert_channel_create refuses url together with url_ref, and neither, without writing", async () => {
    const p = principal({ tenantId: tenantA });
    const url = outboundUrl(`/api/webhooks/1696/${RAW_TOKEN}`);
    const both = await alertChannelCreate(
      p,
      {
        name: "both",
        type: "discord",
        url,
        url_ref: "discord-url",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(both.ok).toBe(false);
    expect(JSON.stringify(both)).not.toContain(RAW_TOKEN);
    const neither = await alertChannelCreate(
      p,
      { name: "neither", type: "discord", dry_run: false },
      { base: appDb },
    );
    expect(neither.ok).toBe(false);
    expect(
      await suDb.alertChannel.count({
        where: { tenantId: tenantA, name: { in: ["both", "neither"] } },
      }),
    ).toBe(0);
  });

  test("a refused raw URL is not echoed back", async () => {
    const r = await alertChannelCreate(
      principal({ tenantId: tenantA }),
      {
        name: "ftp",
        type: "webhook",
        url: `ftp://203.0.113.10/${RAW_TOKEN}`,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(RAW_TOKEN);
  });

  test("alert_channel_update rotates the URL raw: the preview applies nothing, the apply moves the destination, nothing carries it", async () => {
    const p = principal({ tenantId: tenantA });
    const created = await alertChannelCreate(
      p,
      {
        name: "rotate-raw",
        type: "discord",
        url_ref: "discord-url",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(created.ok).toBe(true);
    const row = await suDb.alertChannel.findFirstOrThrow({
      where: { tenantId: tenantA, name: "rotate-raw" },
    });
    const next = outboundUrl(`/api/webhooks/1696/new${RAW_TOKEN}`, 11);

    const preview = await alertChannelUpdate(
      p,
      { channel_id: String(row.id), url: next },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(RAW_TOKEN);
    if (preview.ok) {
      expect(preview.data.urlRotated).toBe(true);
      expect(preview.data.urlMasked).toBe("https://203.0.113.11/…");
    }
    const unchanged = await suDb.alertChannel.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(unchanged.url).toBe(row.url);

    const both = await alertChannelUpdate(
      p,
      {
        channel_id: String(row.id),
        url: next,
        url_ref: "discord-url",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(both.ok).toBe(false);
    expect(
      (await suDb.alertChannel.findUniqueOrThrow({ where: { id: row.id } }))
        .url,
    ).toBe(row.url);

    const applied = await alertChannelUpdate(
      p,
      { channel_id: String(row.id), url: next, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    expect(JSON.stringify(applied)).not.toContain(RAW_TOKEN);
    const after = await suDb.alertChannel.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(decryptJson<string>(after.url)).toBe(next);
    expect(await auditText(tenantA)).toContain("alert_channel.update");
    expect(await auditText(tenantA)).not.toContain(RAW_TOKEN);

    await withStubbedFetch(
      () => new Response(null, { status: 204 }),
      async (sent) => {
        await alertChannelTest(
          p,
          { channel_id: String(row.id) },
          { base: appDb },
        );
        expect(sent).toEqual([next]);
      },
    );
  });

  test("alert_channel_test sends on the call and returns the outcome", async () => {
    const p = principal({ tenantId: tenantA });
    const created = await alertChannelCreate(
      p,
      {
        name: "mcp-tested",
        type: "discord",
        url_ref: "discord-url",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(created.ok).toBe(true);
    const row = await suDb.alertChannel.findFirstOrThrow({
      where: { tenantId: tenantA, name: "mcp-tested" },
    });
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tenantA}`,
    );

    const r = await withStubbedFetch(
      () => new Response(null, { status: 204 }),
      async (sent) => {
        const res = await alertChannelTest(
          p,
          { channel_id: String(row.id) },
          { base: appDb },
        );
        // One argument and it went out: no second call with an apply flag.
        expect(sent).toHaveLength(1);
        return res;
      },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = (r.data as { result: Record<string, unknown> }).result;
      expect(result.ok).toBe(true);
      expect(result.status).toBe(204);
      expect(typeof result.durationMs).toBe("number");
      // The channel's URL embeds a Discord bot token, and this response is what an MCP client puts
      // in a transcript.
      expect(JSON.stringify(r.data)).not.toContain("abcdefTOKEN");
    }
    // Nothing recorded, same decision as `webhook_test`: the trail records changes.
    expect(await suDb.auditLog.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(
      await suDb.alertDelivery.count({ where: { channelId: row.id } }),
    ).toBe(0);
  });

  test("alert_channel_test does not reach another tenant's channel", async () => {
    const mine = await alertChannelCreate(
      principal({ tenantId: tenantA }),
      {
        name: "mcp-fenced",
        type: "discord",
        url_ref: "discord-url",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(mine.ok).toBe(true);
    const row = await suDb.alertChannel.findFirstOrThrow({
      where: { tenantId: tenantA, name: "mcp-fenced" },
    });

    await withStubbedFetch(
      () => new Response(null, { status: 204 }),
      async (sent) => {
        const r = await alertChannelTest(
          principal({ tenantId: tenantB }),
          { channel_id: String(row.id) },
          { base: appDb },
        );
        expect(r.ok).toBe(false);
        // And the refusal is a refusal, not a delivery to somebody else's destination.
        expect(sent).toHaveLength(0);
      },
    );
  });

  test("integration_create applies but never returns the raw route token", async () => {
    const p = principal({ tenantId: tenantA });
    const catalogType = listCatalog()[0]?.catalogType;
    expect(typeof catalogType).toBe("string");
    const r = await integrationCreate(
      p,
      {
        catalog_type: catalogType as string,
        name: "my-integration",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(true);
      expect(typeof r.data.id).toBe("string");
      expect(typeof r.data.configureAt).toBe("string");
      // The generated route token is surfaced via the console, never in the payload.
      expect(r.data.routeToken).toBeUndefined();
    }
  });

  // NOTE: The other half: the update tool has its own dry-run branch, and a rule enforced on only one of
  // the two would let an operator edit an instance into exactly what create refuses.
  test("integration_update's dry run refuses it too", async () => {
    const p = principal({ tenantId: tenantA });
    const created = await integrationCreate(
      p,
      { catalog_type: "ASAAS", name: "hdr-updatable", dry_run: false },
      { base: appDb },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await integrationUpdate(
      p,
      {
        integration_id: created.data.id as string,
        config: { authHeader: "x tok" },
      },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("config.authHeader");
  });

  test("integration_create still takes a vault NAME, now that the column will not", async () => {
    // The write boundary refuses anything that is not `vault:<id>`, and MCP is the transport that
    // speaks names: it resolves them here, before the service ever sees the argument. This is the
    // test that says the two decisions fit together: tightening the column did not make the tool
    // that talks to a model start demanding numeric ids.
    const r = await integrationCreate(
      principal({ tenantId: tenantA }),
      {
        catalog_type: "ASAAS",
        name: "named-secret-integration",
        inbound_auth_strategy: "STATIC_HEADER",
        inbound_secret_ref: "wh-secret",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.integrationInstance.findFirst({
      where: { tenantId: tenantA, name: "named-secret-integration" },
      select: { inboundSecretRef: true },
    });
    expect(row?.inboundSecretRef).toBe(`vault:${secretId}`);
  });

  test("webhook_delete cross-tenant → not found", async () => {
    // Create a webhook in tenantA, then attempt deletion as tenantB.
    const own = await webhookCreate(
      principal({ tenantId: tenantA }),
      {
        url: outboundUrl("/fenced"),
        events: ["heartbeat"],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(own.ok).toBe(true);
    const row = await suDb.webhookSubscription.findFirst({
      where: { tenantId: tenantA, url: outboundUrl("/fenced") },
    });
    const r = await webhookDelete(
      principal({ tenantId: tenantB }),
      { webhook_id: String(row?.id), dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});
