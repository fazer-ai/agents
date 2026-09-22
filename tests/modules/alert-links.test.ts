import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { buildAlertBody } from "@/modules/flowlog/alert-send";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import { dispatchAlertsForEvent } from "@/modules/flowlog/alerts";
import { createAlertChannel } from "@/modules/flowlog/channels";
import type { FlowContext } from "@/modules/flowlog/service";
import { outboundUrl } from "../utils/outbound";
import { POLL_DEADLINE_MS } from "../utils/poll";

// Issue #665: an alert names where it happened, so an operator can get from the Discord message to
// the turn or the conversation without guessing a time window on /logs.

const host = config.publicUrl.replace(/\/+$/, "");

function body(over: Partial<Parameters<typeof buildAlertBody>[0]> = {}) {
  return buildAlertBody({
    type: "discord",
    stage: "generate",
    level: "error",
    summary: "[generate via openai] error: HTTP 503",
    count: 1,
    tenantId: 7n,
    turnId: "71b89fbe-turn",
    conversationId: 7697n,
    ...over,
  });
}

function content(over: Partial<Parameters<typeof buildAlertBody>[0]> = {}) {
  return (JSON.parse(body(over).rawBody) as { content: string }).content;
}

describe("alert links", () => {
  test("a single event links to its turn and its conversation, on its own tenant", () => {
    const c = content();
    expect(c).toContain(`<${host}/logs?turnId=71b89fbe-turn&switchTenant=7>`);
    expect(c).toContain(`<${host}/conversations/7697?switchTenant=7>`);
  });

  test("a single event with no conversation still links to its turn", () => {
    const c = content({ conversationId: null });
    expect(c).toContain(`<${host}/logs?turnId=71b89fbe-turn&switchTenant=7>`);
    expect(c).not.toContain("/conversations/");
  });

  // The ids name the FIRST event of the window, so on a burst they would point at one member of it.
  test("a burst links to the stage and level, never to the first event's turn or conversation", () => {
    const c = content({ stage: "delivery", count: 4 });
    expect(c).toContain(
      `<${host}/logs?stage=delivery&level=error&switchTenant=7>`,
    );
    expect(c).not.toContain("turnId=");
    expect(c).not.toContain("/conversations/");
  });

  test("an alert with no event behind it (a probe, a row from before the columns) carries no link", () => {
    const c = content({ turnId: null, conversationId: null });
    expect(c).not.toContain(host);
  });

  test("a summary long enough to be clipped does not cut the link", () => {
    const c = content({ summary: "x".repeat(5000) });
    expect(c.length).toBeLessThanOrEqual(1900);
    expect(c.endsWith(`<${host}/conversations/7697?switchTenant=7>`)).toBe(
      true,
    );
  });

  test("the generic webhook gets the ids as fields, not rendered URLs", () => {
    const env = JSON.parse(body({ type: "webhook" }).rawBody);
    expect(env.turnId).toBe("71b89fbe-turn");
    expect(env.conversationId).toBe("7697");
    expect(JSON.stringify(env)).not.toContain(host);
    const none = JSON.parse(
      body({ type: "webhook", turnId: null, conversationId: null }).rawBody,
    );
    expect(none.turnId).toBeNull();
    expect(none.conversationId).toBeNull();
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

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const flow = (turnId: string, conversationId: bigint | null): FlowContext => ({
  tenantId,
  turnId,
  source: "inbox",
  conversationId,
  base: appDb,
});
const allowAll = async (u: string) => new URL(u);

describe.skipIf(!dbUp)("alert links through the ledger", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Links665", slug: `links-665-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const tbl of ["alert_deliveries", "alert_channels"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // Ticks until the row leaves PENDING: the claim skips locked rows, so one tick can claim nothing
  // under the full suite (see unsigned-delivery-says-so.test.ts).
  async function deliver(channelId: bigint) {
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      await processAlertBatch({
        base: appDb,
        tenantId,
        coalesceWindowMs: 0,
        fetchImpl,
        assertSafe: allowAll,
      });
      const pending = await suDb.alertDelivery.count({
        where: { channelId, status: "PENDING" },
      });
      if (pending === 0) break;
    }
    return sent.map((b) => (JSON.parse(b) as { content: string }).content);
  }

  async function channel(name: string, stage: string) {
    const ch = await createAlertChannel(
      ctx(),
      {
        name,
        type: "discord",
        url: outboundUrl(`/api/webhooks/${name}`),
        stages: [stage],
      },
      appDb,
    );
    return BigInt(ch.id);
  }

  test("the event's turn and conversation reach the posted body", async () => {
    const id = await channel("single", "stt");
    await dispatchAlertsForEvent(
      flow("turn-665-a", 4242n),
      { stage: "stt", level: "error", errorMessage: "timeout" },
      appDb,
    );
    const [c] = await deliver(id);
    expect(c).toContain(
      `<${host}/logs?turnId=turn-665-a&switchTenant=${tenantId}>`,
    );
    expect(c).toContain(
      `<${host}/conversations/4242?switchTenant=${tenantId}>`,
    );
  });

  // The coalescing bump must leave the ids alone: they describe the first event, like `summary`,
  // and a burst links to the list anyway.
  test("a burst keeps the first event's ids on the row and links to the list", async () => {
    const id = await channel("burst", "tts");
    await dispatchAlertsForEvent(
      flow("turn-665-first", 1n),
      { stage: "tts", level: "error", errorMessage: "timeout" },
      appDb,
    );
    await dispatchAlertsForEvent(
      flow("turn-665-second", 2n),
      { stage: "tts", level: "error", errorMessage: "timeout" },
      appDb,
    );
    const row = await suDb.alertDelivery.findFirstOrThrow({
      where: { channelId: id },
    });
    expect(row.count).toBe(2);
    expect(row.turnId).toBe("turn-665-first");
    expect(row.conversationId).toBe(1n);
    const [c] = await deliver(id);
    expect(c).toContain(
      `<${host}/logs?stage=tts&level=error&switchTenant=${tenantId}>`,
    );
    expect(c).not.toContain("turn-665-");
  });
});
