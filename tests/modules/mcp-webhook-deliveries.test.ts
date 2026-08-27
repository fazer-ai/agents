import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { webhookDeliveryGet, webhookDeliveryList } from "@/modules/mcp/read";
import { webhookDeliveryRequeue } from "@/modules/mcp/write-webhooks";

// ── THE DELIVERY LEDGER ON MCP (issue #305) ──
// The REST half is covered in webhooks-outbound-deliveries.test.ts; this drives what MCP adds on
// top of the same service: the scope gate, the dry run, and the audit row.
//
// The dry run gets its own case for the reason it exists: the only way this call can fail is the
// row not being DEAD, so a preview built from the id alone would approve exactly the requests the
// apply refuses.

function principal(over: Partial<VerifiedToken> = {}): VerifiedToken {
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

describe("MCP delivery tools gate (no DB)", () => {
  test("webhook_delivery_list without mcp:read → insufficient_scope", async () => {
    const r = await webhookDeliveryList(principal({ scopes: [] }), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("webhook_delivery_requeue without mcp:write → insufficient_scope", async () => {
    const r = await webhookDeliveryRequeue(
      principal({ scopes: ["mcp:read"] }),
      {
        delivery_id: "1",
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
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

const PAYLOAD_MARKER = "sk-live-PAYLOAD-MUST-NOT-LEAK-305-mcp";

describe.skipIf(!dbUp)("MCP delivery tools (DB)", () => {
  let tenantId = 0n;
  let subId = 0n;

  async function seed(
    status: "PENDING" | "SENDING" | "DELIVERED" | "DEAD",
    attempts: number,
  ): Promise<bigint> {
    const row = await suDb.outboundWebhookDelivery.create({
      data: {
        tenantId,
        subscriptionId: subId,
        event: "conversion",
        payload: { token: PAYLOAD_MARKER },
        status,
        attempts,
        lastError: "non-2xx response: 500",
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MWD", slug: `mwd-${process.pid}` },
    });
    tenantId = t.id;
    subId = (
      await suDb.webhookSubscription.create({
        data: {
          tenantId,
          url: "https://example.com/mcp",
          events: ["conversion"],
          enabled: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("webhook_delivery_list and _get return delivery state, never the payload", async () => {
    const id = await seed("DEAD", 8);
    const p = principal({ tenantId });
    const list = await webhookDeliveryList(
      p,
      { status: "DEAD" },
      {
        base: appDb,
      },
    );
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(JSON.stringify(list.data)).not.toContain(PAYLOAD_MARKER);
      const items = list.data.items as Array<{ id: string }>;
      expect(items.map((i) => i.id)).toContain(String(id));
    }
    const one = await webhookDeliveryGet(
      p,
      { delivery_id: String(id) },
      { base: appDb },
    );
    expect(one.ok).toBe(true);
    if (one.ok) expect(JSON.stringify(one.data)).not.toContain(PAYLOAD_MARKER);
  });

  test("the dry run is the default and changes nothing", async () => {
    const id = await seed("DEAD", 8);
    const r = await webhookDeliveryRequeue(
      principal({ tenantId }),
      { delivery_id: String(id) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.current).toMatchObject({ status: "DEAD", attempts: 8 });
      // The preview names what the apply will write, including the number that decides whether
      // this buys a full ladder or a single post.
      expect(r.data.preview).toEqual({
        status: "PENDING",
        attempts: 0,
        willBeClaimed: true,
      });
    }
    const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
      where: { id },
    });
    expect([row.status, row.attempts]).toEqual(["DEAD", 8]);
  });

  test("the dry run refuses exactly what the apply refuses", async () => {
    const id = await seed("SENDING", 3);
    for (const dry_run of [true, false]) {
      const r = await webhookDeliveryRequeue(
        principal({ tenantId }),
        { delivery_id: String(id), dry_run },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("SENDING");
    }
    const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
      where: { id },
    });
    expect([row.status, row.attempts]).toEqual(["SENDING", 3]);
  });

  test("an apply waits for the worker to finish dying instead of refusing", async () => {
    // The row the tool must NOT refuse: the worker has decided it is dead and has not committed
    // yet, so an unlocked read still answers SENDING. The service is built to wait on exactly that
    // transition, so the apply defers to its locked check rather than repeating the read — a
    // preview may say SENDING here, but an apply that did would refuse a delivery that is dead by
    // the time it would have written.
    const id = await seed("SENDING", 7);
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE outbound_webhook_deliveries SET status = 'DEAD', attempts = 8 WHERE id = ${id}`,
        );
        await Bun.sleep(500);
      },
      { timeout: 10_000 },
    );
    await Bun.sleep(120);
    const [, r] = await Promise.all([
      holder,
      webhookDeliveryRequeue(
        principal({ tenantId }),
        { delivery_id: String(id), dry_run: false },
        { base: appDb },
      ),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
    const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
      where: { id },
    });
    expect([row.status, row.attempts]).toEqual(["PENDING", 0]);
    const audit = await suDb.auditLog.findFirstOrThrow({
      where: { tenantId, target: `webhook_delivery:${id}` },
      orderBy: { id: "desc" },
    });
    expect(audit.before).toMatchObject({ status: "DEAD", attempts: 8 });
  });

  test("the audit records the state the LOCKED write undid, not an earlier look", async () => {
    // The window: the tool reads the row to build its preview, and between that read and the write
    // the row can move — another operator requeues it and the worker kills it again, which for a
    // URL the SSRF guard refuses takes one tick. Held open here by a transaction that changes the
    // attempt count and commits only after the tool's `FOR UPDATE` is already waiting on it, so
    // the unlocked read sees 8 and the locked one sees 1. The audit has to describe the second.
    const id = await seed("DEAD", 8);
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE outbound_webhook_deliveries SET attempts = 1 WHERE id = ${id}`,
        );
        await Bun.sleep(500);
      },
      { timeout: 10_000 },
    );
    await Bun.sleep(120);
    const [, r] = await Promise.all([
      holder,
      webhookDeliveryRequeue(
        principal({ tenantId }),
        { delivery_id: String(id), dry_run: false },
        { base: appDb },
      ),
    ]);
    expect(r.ok).toBe(true);
    const audit = await suDb.auditLog.findFirstOrThrow({
      where: { tenantId, target: `webhook_delivery:${id}` },
      orderBy: { id: "desc" },
    });
    expect(audit.before).toMatchObject({ status: "DEAD", attempts: 1 });
    expect(audit.after).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  test("the apply requeues the row and records who did it", async () => {
    const id = await seed("DEAD", 8);
    const r = await webhookDeliveryRequeue(
      principal({ tenantId }),
      { delivery_id: String(id), dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
    const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
      where: { id },
    });
    expect([row.status, row.attempts]).toEqual(["PENDING", 0]);
    const audit = await suDb.auditLog.findFirst({
      where: {
        tenantId,
        action: "webhook_delivery.requeue",
        target: `webhook_delivery:${id}`,
      },
    });
    expect(audit).not.toBeNull();
  });
});
