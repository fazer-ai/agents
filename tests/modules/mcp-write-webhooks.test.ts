import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { listCatalog } from "@/modules/integrations/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  alertChannelCreate,
  integrationCreate,
  integrationUpdate,
  webhookCreate,
  webhookDelete,
} from "@/modules/mcp/write-webhooks";
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

  // Review round 1 of #370. `dry_run` DEFAULTS to true here, so the preview is the operator's FIRST
  // answer — and it echoed the config back as approved while the apply would refuse it, which is the
  // shape issue #248 was about. A preview that answers only from its own arguments is not a preview
  // of anything.
  test("integration_create's dry run refuses a header name the apply would refuse", async () => {
    const r = await integrationCreate(principal({}), {
      catalog_type: "ASAAS",
      name: "hdr-dry",
      config: { authHeader: "asaas-access-token " },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("config.authHeader");
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
  } catch {
    dbUp = false;
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

  // The other half of the same round: the update tool has its own dry-run branch, and a rule enforced
  // on one of the two would let an operator edit an instance into exactly what create refuses.
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
