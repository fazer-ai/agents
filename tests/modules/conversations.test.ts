import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { listConversations } from "@/modules/conversations/service";
import { seedChatwootInstance } from "../utils/chatwoot";

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

let tenantA = 0n;
let tenantB = 0n;
let instA = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("listConversations", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "ConvA", slug: `conv-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "ConvB", slug: `conv-b-${process.pid}` },
    });
    tenantB = b.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      accountId: 1,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    instA = inst.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: instA,
        chatwootInboxId: 10,
        name: "Support",
      },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instA,
        tenantId: tenantA,
        chatwootContactId: 5,
        name: "Alice",
      },
    });
    // Two conversations for A (different statuses + recency) and one for B (isolation check).
    await suDb.conversation.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: instA,
        chatwootConversationId: 100,
        inboxId: inbox.id,
        contactId: contact.id,
        status: "pending",
        assigneeType: "AgentBot",
        threadId: `${tenantA}:${instA}:100`,
        lastEventAt: new Date("2026-05-01T10:00:00Z"),
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: instA,
        chatwootConversationId: 101,
        inboxId: inbox.id,
        contactId: contact.id,
        status: "open",
        assigneeType: "User",
        assigneeId: 7,
        threadId: `${tenantA}:${instA}:101`,
        lastEventAt: new Date("2026-05-02T10:00:00Z"),
      },
    });
    const instB = await seedChatwootInstance(suDb, {
      tenantId: tenantB,
      accountId: 2,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    await suDb.conversation.create({
      data: {
        tenantId: tenantB,
        chatwootInstanceId: instB.id,
        chatwootConversationId: 200,
        status: "open",
        threadId: `${tenantB}:${instB.id}:200`,
        lastEventAt: new Date("2026-05-03T10:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM conversations WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM inboxes WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM contacts WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("returns the tenant's conversations, newest first, with bigints serialized", async () => {
    const { items, nextCursor } = await listConversations(
      ctx(tenantA),
      {},
      appDb,
    );
    expect(items).toHaveLength(2);
    // A small result (under the page size) is the last page.
    expect(nextCursor).toBeNull();
    // Newest lastEventAt first.
    expect(items[0]?.chatwootConversationId).toBe(101);
    expect(items[1]?.chatwootConversationId).toBe(100);
    // BigInts are strings on the wire.
    expect(typeof items[0]?.id).toBe("string");
    expect(typeof items[0]?.inbox?.id).toBe("string");
    // Joins + PII (contact name) present for same-tenant operators.
    expect(items[0]?.inbox?.name).toBe("Support");
    expect(items[0]?.contact?.name).toBe("Alice");
    // Assignment fields drive the IA-vs-human badge.
    expect(items[0]?.assigneeType).toBe("User");
    expect(items[0]?.assigneeId).toBe(7);
  });

  test("paginates with a keyset cursor (one item per page)", async () => {
    const first = await listConversations(ctx(tenantA), { limit: 1 }, appDb);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.chatwootConversationId).toBe(101);
    expect(first.nextCursor).toBe(first.items[0]?.id ?? null);
    const second = await listConversations(
      ctx(tenantA),
      // `nextCursor` crosses the wire as a string; the caller parses it back, which is what the
      // REST route now does with `parseQueryId` instead of handing the raw value to the service.
      {
        limit: 1,
        cursor: first.nextCursor ? BigInt(first.nextCursor) : undefined,
      },
      appDb,
    );
    expect(second.items).toHaveLength(1);
    // The next page continues past the cursor — no overlap with the first.
    expect(second.items[0]?.chatwootConversationId).toBe(100);
  });

  test("filters by status", async () => {
    const open = await listConversations(
      ctx(tenantA),
      { status: "open" },
      appDb,
    );
    expect(open.items).toHaveLength(1);
    expect(open.items[0]?.status).toBe("open");
  });

  test("an unknown status is REFUSED, not ignored", async () => {
    // Changed in issue #372. The old contract dropped it and returned every conversation, which
    // answers a request narrowed to one status with the tenant's whole list — and the caller has
    // no way to tell that from a status that genuinely matches everything.
    let err: unknown = null;
    try {
      await listConversations(ctx(tenantA), { status: "bogus" }, appDb);
    } catch (e) {
      err = e;
    }
    expect(err === null ? "accepted" : "refused").toBe("refused");
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).field).toBe("status");
  });

  test("tenant isolation: A never sees B's conversations", async () => {
    const { items } = await listConversations(ctx(tenantA), {}, appDb);
    expect(items.every((c) => c.chatwootConversationId !== 200)).toBe(true);
  });
});
