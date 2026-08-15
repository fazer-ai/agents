import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import { seedChatwootInstance } from "../utils/chatwoot";

// The three guards that make it safe to apply a REST snapshot to the mirror after any write. They
// existed inline on the proactive-nudge path and nothing exercised them; the console's buttons are
// now a second caller (issue #77), so each one gets a case here.
//
// The window they protect is the same in both callers: a webhook can commit BETWEEN the GET and this
// write, which makes the snapshot in hand the older truth even though it was read later.

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

const T = 1_786_600_000;
let tenantId = 0n;
let instanceId = 0n;
let nextConvId = 700;

interface StoredRow {
  status: string;
  assigneeType: string | null;
  assigneeId: number | null;
  lastEventAt: Date | null;
  chatwootStatusAt: number | null;
  chatwootAssigneeAt: number | null;
}

async function seedRow(over: Partial<StoredRow> = {}): Promise<number> {
  const chatwootConversationId = nextConvId++;
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId,
      status: over.status ?? "pending",
      assigneeType: over.assigneeType ?? null,
      assigneeId: over.assigneeId ?? null,
      lastEventAt: over.lastEventAt ?? new Date(T * 1000),
      chatwootStatusAt: over.chatwootStatusAt ?? null,
      chatwootAssigneeAt: over.chatwootAssigneeAt ?? null,
      threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
    },
  });
  return chatwootConversationId;
}

async function readRow(conversationId: number) {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: conversationId },
    select: {
      status: true,
      assigneeType: true,
      assigneeId: true,
      chatwootStatusAt: true,
      chatwootAssigneeAt: true,
      updatedAt: true,
    },
  });
}

async function applyFor(
  conversationId: number,
  live: {
    status: string;
    assigneeType?: string | null;
    assigneeId?: number | null;
    lastActivitySec?: number;
    updatedAt: number | null;
  },
) {
  return reconcileMirrorFromLive({
    tenantId,
    instanceId,
    conversationId,
    live: {
      status: live.status,
      assigneeType: live.assigneeType ?? null,
      assigneeId: live.assigneeId ?? null,
      assigneeName: null,
      lastActivityAt: new Date((live.lastActivitySec ?? T) * 1000),
      updatedAt: live.updatedAt,
    },
    base: appDb,
  });
}

describe.skipIf(!dbUp)("reconcileMirrorFromLive", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Reconcile", slug: `reconcile-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 3,
      baseUrl: "https://cw-reconcile.example",
      adminToken: "enc",
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("applies the snapshot and stamps both marks with its version", async () => {
    const id = await seedRow();
    await applyFor(id, {
      status: "open",
      assigneeType: "User",
      assigneeId: 7,
      updatedAt: T + 1,
    });
    const row = await readRow(id);
    expect(row.status).toBe("open");
    expect(row.assigneeType).toBe("User");
    expect(row.assigneeId).toBe(7);
    expect(row.chatwootStatusAt).toBe(T + 1);
    expect(row.chatwootAssigneeAt).toBe(T + 1);
  });

  test("a webhook that landed after the read wins: nothing is applied over it", async () => {
    // The stored row moved past the snapshot's activity time, so this snapshot is the older truth.
    const id = await seedRow({ lastEventAt: new Date((T + 30) * 1000) });
    await applyFor(id, {
      status: "resolved",
      lastActivitySec: T,
      updatedAt: T + 50,
    });
    const row = await readRow(id);
    expect(row.status).toBe("pending");
    expect(row.chatwootStatusAt).toBeNull();
  });

  // The activity clock is coarse (one-second, and unmoved by a status or assignee change) and the
  // stored `lastEventAt` may have been synthesized from receipt time. When the snapshot carries a
  // version and the mark holds one, that pair decides — otherwise the coarse key would veto the
  // precise one, and on an inflated `lastEventAt` it would keep vetoing it.
  test("a versioned snapshot is not rejected by an activity time that looks older", async () => {
    const id = await seedRow({
      lastEventAt: new Date((T + 30) * 1000),
      chatwootStatusAt: T,
      chatwootAssigneeAt: T,
    });
    await applyFor(id, {
      status: "resolved",
      lastActivitySec: T,
      updatedAt: T + 50,
    });
    const row = await readRow(id);
    expect(row.status).toBe("resolved");
    expect(row.chatwootStatusAt).toBe(T + 50);
  });

  // The verdict a caller acts on. Losing to a stored VERSION is evidence of something newer in the
  // row; losing to the coarse activity comparison is not evidence of anything, and a caller that just
  // wrote to Chatwoot needs to tell the two apart.
  test("reports what it did: applied, and the row as it now stands", async () => {
    const id = await seedRow();
    const out = await applyFor(id, {
      status: "open",
      assigneeType: "User",
      assigneeId: 7,
      updatedAt: T + 1,
    });
    expect(out.applied).toBe(true);
    expect(out.outrankedByVersion).toBe(false);
    expect(out.state).toMatchObject({
      status: "open",
      assigneeType: "User",
      assigneeId: 7,
    });
  });

  test("a loss to a stored version is reported as such, with the row that won", async () => {
    const id = await seedRow({
      status: "resolved",
      chatwootStatusAt: T + 9,
      chatwootAssigneeAt: T + 9,
    });
    const out = await applyFor(id, { status: "pending", updatedAt: T + 5 });
    expect(out.applied).toBe(false);
    expect(out.outrankedByVersion).toBe(true);
    expect(out.state).toMatchObject({ status: "resolved" });
  });

  test("a loss to the activity comparison alone is NOT reported as outranked", async () => {
    // No marks: nothing can be ordered by version, and `lastEventAt` may have been synthesized from
    // receipt time. The caller is told the write did not land and that no version decided it.
    const id = await seedRow({ lastEventAt: new Date((T + 30) * 1000) });
    const out = await applyFor(id, {
      status: "resolved",
      lastActivitySec: T,
      updatedAt: T + 50,
    });
    expect(out.applied).toBe(false);
    expect(out.outrankedByVersion).toBe(false);
  });

  test("nothing to write because the row already agrees counts as applied", async () => {
    const id = await seedRow({
      status: "open",
      chatwootStatusAt: T,
      chatwootAssigneeAt: T,
    });
    const out = await applyFor(id, { status: "open", updatedAt: T + 1 });
    expect(out.applied).toBe(true);
    expect(out.state).toMatchObject({ status: "open" });
  });

  test("a snapshot older than the mark that orders a field does not write that field", async () => {
    const id = await seedRow({
      status: "resolved",
      chatwootStatusAt: T + 9,
      chatwootAssigneeAt: T + 9,
    });
    await applyFor(id, { status: "pending", updatedAt: T + 5 });
    const row = await readRow(id);
    expect(row.status).toBe("resolved");
    expect(row.chatwootStatusAt).toBe(T + 9);
  });

  test("a mark never walks backwards, even when the field is written", async () => {
    const id = await seedRow({ status: "pending", chatwootStatusAt: T + 5 });
    // Equal version: new enough to be applied, not new enough to move the mark.
    await applyFor(id, { status: "open", updatedAt: T + 5 });
    const row = await readRow(id);
    expect(row.status).toBe("open");
    expect(row.chatwootStatusAt).toBe(T + 5);
  });

  test("nothing differs → no write at all (the row is not even touched)", async () => {
    const id = await seedRow({
      status: "open",
      assigneeType: "User",
      assigneeId: 7,
      chatwootStatusAt: T + 1,
      chatwootAssigneeAt: T + 1,
    });
    const before = await readRow(id);
    await applyFor(id, {
      status: "open",
      assigneeType: "User",
      assigneeId: 7,
      updatedAt: T + 1,
    });
    const after = await readRow(id);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  test("a Chatwoot too old to send a version still applies, ordered by activity alone", async () => {
    const id = await seedRow();
    await applyFor(id, { status: "resolved", updatedAt: null });
    const row = await readRow(id);
    expect(row.status).toBe("resolved");
    expect(row.chatwootStatusAt).toBeNull();
  });
});
