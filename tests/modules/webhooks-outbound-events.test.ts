import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  buildOutboundEnvelope,
  isOutboundEvent,
  OUTBOUND_ENVELOPE_VERSION,
  OUTBOUND_EVENTS,
  type OutboundEvent,
} from "@/modules/webhooks/outbound/events";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { dbProbeFailed } from "@/tests/db-gate";
import { outboundUrl } from "../utils/outbound";

// ── pure unit (no DB) ──

describe("outbound events", () => {
  test("the closed set holds exactly the canonical events", () => {
    expect([...OUTBOUND_EVENTS]).toEqual([
      "conversation.created",
      "conversation.status_changed",
      "conversation.handoff",
      "kanban.card_moved",
      "llm.usage",
      "tenant.created",
      "document.approval_requested",
      "document.approval_decided",
      "document.approval_outcome",
      "heartbeat",
    ]);
  });

  test("isOutboundEvent narrows to the union", () => {
    expect(isOutboundEvent("conversation.created")).toBe(true);
    expect(isOutboundEvent("llm.usage")).toBe(true);
    expect(isOutboundEvent("conversion")).toBe(false);
    expect(isOutboundEvent("unknown.event")).toBe(false);
    // Compile-time: the union assignment below only type-checks for valid literals.
    const e: OutboundEvent = "tenant.created";
    expect(e).toBe("tenant.created");
  });

  test("buildOutboundEnvelope produces the versioned, fenced shape", () => {
    const env = buildOutboundEnvelope(
      42n,
      "conversation.handoff",
      { conversation_id: "7", inbox_id: "3" },
      () => 1_700_000_000_000,
    );
    expect(env.version).toBe(OUTBOUND_ENVELOPE_VERSION);
    expect(env.event).toBe("conversation.handoff");
    expect(env.tenant_id).toBe("42");
    expect(env.occurred_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(typeof env.instance_id).toBe("string");
    expect(env.data).toEqual({ conversation_id: "7", inbox_id: "3" });
  });
});

// ── integration (real DB): subscription CRUD with the tenant fence ──

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
let tenantA = 0n;
let tenantB = 0n;
const ctxA = (): TenantContext => ({
  tenantId: tenantA,
  userId: null,
  role: "TENANT_ADMIN",
});
const ctxB = (): TenantContext => ({
  tenantId: tenantB,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("webhook subscription CRUD", () => {
  beforeAll(async () => {
    if (!su) return;
    const a = await su.tenant.create({
      data: { name: "WHS-A", slug: `whs-a-${process.pid}` },
    });
    const b = await su.tenant.create({
      data: { name: "WHS-B", slug: `whs-b-${process.pid}` },
    });
    tenantA = a.id;
    tenantB = b.id;
  });

  afterAll(async () => {
    if (su) {
      for (const id of [tenantA, tenantB]) {
        if (!id) continue;
        await su.$executeRawUnsafe(
          `DELETE FROM outbound_webhook_deliveries WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM webhook_subscriptions WHERE tenant_id = ${id}`,
        );
        await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
      }
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("create + list + update + delete round-trips", async () => {
    const sub = await createWebhookSubscription(
      ctxA(),
      {
        url: outboundUrl("/hook"),
        events: ["conversation.created", "llm.usage"],
      },
      appDb,
    );
    expect(sub.url).toBe(outboundUrl("/hook"));
    expect(sub.events).toEqual(["conversation.created", "llm.usage"]);
    expect(sub.enabled).toBe(true);
    expect(sub.secretRef).toBeNull();

    const list = await listWebhookSubscriptions(ctxA(), appDb);
    expect(list.some((s) => s.id === sub.id)).toBe(true);

    const updated = await updateWebhookSubscription(
      ctxA(),
      BigInt(sub.id),
      { enabled: false, events: ["heartbeat"] },
      appDb,
    );
    expect(updated.enabled).toBe(false);
    expect(updated.events).toEqual(["heartbeat"]);

    await deleteWebhookSubscription(ctxA(), BigInt(sub.id), appDb);
    const after = await listWebhookSubscriptions(ctxA(), appDb);
    expect(after.some((s) => s.id === sub.id)).toBe(false);
  });

  test("rejects an unknown event with a 400", async () => {
    const err = await createWebhookSubscription(
      ctxA(),
      { url: outboundUrl("/hook"), events: ["conversion"] },
      appDb,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).translationKey).toBe("errors.unknownWebhookEvent");
  });

  test("rejects an SSRF-blocked URL", async () => {
    const err = await createWebhookSubscription(
      ctxA(),
      {
        url: "http://169.254.169.254/latest/meta-data",
        events: ["heartbeat"],
      },
      appDb,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
  });

  test("tenant B cannot update or delete tenant A's subscription", async () => {
    const sub = await createWebhookSubscription(
      ctxA(),
      { url: outboundUrl("/fenced"), events: ["conversation.created"] },
      appDb,
    );
    const updErr = await updateWebhookSubscription(
      ctxB(),
      BigInt(sub.id),
      { enabled: false },
      appDb,
    ).catch((e) => e);
    expect((updErr as AppError).statusCode).toBe(404);

    const delErr = await deleteWebhookSubscription(
      ctxB(),
      BigInt(sub.id),
      appDb,
    ).catch((e) => e);
    expect((delErr as AppError).statusCode).toBe(404);

    // Still visible/owned by A.
    const list = await listWebhookSubscriptions(ctxA(), appDb);
    expect(list.some((s) => s.id === sub.id)).toBe(true);
    // B's list never sees it.
    const listB = await listWebhookSubscriptions(ctxB(), appDb);
    expect(listB.some((s) => s.id === sub.id)).toBe(false);
  });
});
