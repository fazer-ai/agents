import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type ScopedDb } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { webhookEventsList } from "@/modules/mcp/read";
import { webhookCreate, webhookUpdate } from "@/modules/mcp/write-webhooks";
import {
  isSubscribableEvent,
  OUTBOUND_EVENTS,
  outboundEventGroups,
} from "@/modules/webhooks/outbound/events";
import {
  emitOutbound,
  emitOutboundMany,
} from "@/modules/webhooks/outbound/service";
import {
  createWebhookSubscription,
  updateWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { dbProbeFailed } from "@/tests/db-gate";
import { outboundUrl } from "../utils/outbound";

// A subscription may hold a family wildcard (`document.*`), stored as written, which receives every
// event of that family, including ones added later (docs/api-and-fleet.md, Outbound webhooks).

describe("which names a subscription may hold", () => {
  const rows: [string, boolean][] = [
    ["conversation.created", true],
    ["conversation.*", true],
    ["document.*", true],
    ["llm.*", true],
    ["heartbeat", true],
    ["foobar.*", false],
    ["foobar.created", false],
    ["*", false],
    [".*", false],
    ["conversation*", false],
    ["conversation.created.*", false],
    ["heartbeat.*", false],
    ["conversation.", false],
  ];
  for (const [name, ok] of rows) {
    test(`${name} → ${ok ? "accepted" : "refused"}`, () => {
      expect(isSubscribableEvent(name)).toBe(ok);
    });
  }
});

describe("the catalog grouped by family", () => {
  test("every event is in exactly one group, and only a family has a wildcard", () => {
    const groups = outboundEventGroups();
    expect(groups.flatMap((g) => g.events).sort()).toEqual(
      [...OUTBOUND_EVENTS].sort(),
    );
    for (const g of groups) {
      if (g.family === null) expect(g.wildcard).toBeNull();
      else {
        expect(g.wildcard).toBe(`${g.family}.*`);
        expect(g.events.every((e) => e.startsWith(`${g.family}.`))).toBe(true);
      }
    }
    expect(groups.find((g) => g.family === null)?.events).toEqual([
      "heartbeat",
    ]);
  });

  test("the MCP catalog carries the same groups beside the flat list", async () => {
    const r = await webhookEventsList({
      userId: 1n,
      tenantId: 1n,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      clientId: "c",
      jti: "j",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = r.data as { events: string[]; families: unknown };
      expect(body.events).toEqual([...OUTBOUND_EVENTS]);
      expect(body.families).toEqual(outboundEventGroups());
    }
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
let tenantId = 0n;
const ctx = () => ({ tenantId, userId: null, role: "TENANT_ADMIN" as const });
const scoped = <T>(fn: (db: ScopedDb) => Promise<T>) =>
  runScopedOn(appDb, ctx(), fn);

function principal(): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

async function subscribe(path: string, events: string[]) {
  return (
    await suDb.webhookSubscription.create({
      data: { tenantId, url: outboundUrl(path), events, enabled: true },
    })
  ).id;
}

async function deliveredTo(event: string) {
  const rows = await suDb.outboundWebhookDelivery.findMany({
    where: { tenantId, event },
    select: { subscription: { select: { url: true } } },
  });
  return rows.map((r) => r.subscription.url).sort();
}

describe.skipIf(!dbUp)("family wildcards on a real subscription", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "WHFam", slug: `wh-fam-${process.pid}` },
      })
    ).id;
    await subscribe("/conversations-all", ["conversation.*"]);
    await subscribe("/documents-all", ["document.*"]);
    await subscribe("/explicit", ["conversation.created"]);
    await subscribe("/both", ["conversation.*", "conversation.created"]);
    await subscribe("/heartbeat", ["heartbeat"]);
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "outbound_webhook_deliveries",
        "webhook_subscriptions",
        "audit_logs",
      ])
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an event reaches its family's wildcard and its own name, once per subscription, and no other family", async () => {
    const n = await scoped((db) =>
      emitOutbound(db, tenantId, "conversation.created", {
        conversation_id: "1",
      }),
    );
    expect(n).toBe(3);
    expect(await deliveredTo("conversation.created")).toEqual(
      ["/both", "/conversations-all", "/explicit"]
        .map((p) => outboundUrl(p))
        .sort(),
    );
  });

  test("the batch emit matches the same way", async () => {
    await scoped((db) =>
      emitOutboundMany(db, tenantId, "document.approval_decided", [
        { request_id: "1" },
        { request_id: "2" },
      ]),
    );
    expect(await deliveredTo("document.approval_decided")).toEqual([
      outboundUrl("/documents-all"),
      outboundUrl("/documents-all"),
    ]);
  });

  test("an event with no family reaches only its own name", async () => {
    await scoped((db) => emitOutbound(db, tenantId, "heartbeat", {}));
    expect(await deliveredTo("heartbeat")).toEqual([outboundUrl("/heartbeat")]);
  });

  test("a wildcard is stored as written, beside an explicit name", async () => {
    const sub = await createWebhookSubscription(
      ctx(),
      {
        url: outboundUrl("/stored"),
        events: ["document.*", "conversation.handoff"],
      },
      appDb,
    );
    const row = await suDb.webhookSubscription.findUniqueOrThrow({
      where: { id: BigInt(sub.id) },
      select: { events: true },
    });
    expect(row.events).toEqual(["document.*", "conversation.handoff"]);
    const updated = await updateWebhookSubscription(
      ctx(),
      BigInt(sub.id),
      { events: ["conversation.*"] },
      appDb,
    );
    expect(updated.events).toEqual(["conversation.*"]);
  });

  test("an unknown family is refused like an unknown event, by REST and MCP, and nothing is written", async () => {
    const before = await suDb.webhookSubscription.count({
      where: { tenantId },
    });
    for (const events of [["foobar.*"], ["foobar.created"], ["*"]]) {
      await expect(
        createWebhookSubscription(
          ctx(),
          { url: outboundUrl("/refused"), events },
          appDb,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        translationKey: "errors.unknownWebhookEvent",
      });
    }
    const created = await webhookCreate(principal(), {
      url: outboundUrl("/refused"),
      events: ["foobar.*"],
      dry_run: false,
    });
    expect(created.ok).toBe(false);
    const existing = await subscribe("/patch-target", ["heartbeat"]);
    const patched = await webhookUpdate(principal(), {
      webhook_id: String(existing),
      events: ["conversation.created.*"],
      dry_run: false,
    });
    expect(patched.ok).toBe(false);
    expect(await suDb.webhookSubscription.count({ where: { tenantId } })).toBe(
      before + 1,
    );
    expect(
      (
        await suDb.webhookSubscription.findUniqueOrThrow({
          where: { id: existing },
          select: { events: true },
        })
      ).events,
    ).toEqual(["heartbeat"]);
  });
});
