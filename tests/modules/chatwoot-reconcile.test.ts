import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher } from "@/api/features/realtime/realtime.service";
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
let inboxRowId = 0n;
let nextConvId = 700;

interface StoredRow {
  status: string;
  statusClaimUntil: Date | null;
  statusClaimFrom: string | null;
  statusClaimStampedAt: number | null;
  statusClaimRefusedAt: number | null;
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
      statusClaimUntil: over.statusClaimUntil ?? null,
      statusClaimFrom: over.statusClaimFrom ?? null,
      statusClaimStampedAt: over.statusClaimStampedAt ?? null,
      statusClaimRefusedAt: over.statusClaimRefusedAt ?? null,
      inboxId: inboxRowId,
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
      statusClaimStampedAt: true,
      statusClaimRefusedAt: true,
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
  ownsStatusClaim: Date | null = null,
  base: PrismaClient = appDb,
) {
  return reconcileMirrorFromLive({
    ownsStatusClaim,
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
    base,
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
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 11,
        name: "Reconcile",
      },
    });
    inboxRowId = inbox.id;
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

  // ── THE LOCAL STATUS CLAIM (issue #436) ──
  //
  // A live read is not evidence about a transition still on the wire: Chatwoot may not have committed
  // it yet, and the snapshot carries no way to say so. The claim is the writer of that transition
  // announcing it, and this is the second reader of it after the mirror.
  test("a claim somebody else holds fences the status this read carries", async () => {
    const id = await seedRow({
      status: "open",
      statusClaimUntil: new Date(Date.now() + 30_000),
      statusClaimFrom: "pending",
      // Nothing stamped: the reconcile that would give this transition the source's own version has
      // not run, which is the whole of the window.
      statusClaimStampedAt: null,
      chatwootStatusAt: T,
    });
    // What the proactive nudge's probe sees while a takeover's toggle is on the wire: the source
    // still says `pending`, and applying it would put the agent back into a conversation a colleague
    // has just answered in.
    const result = await applyFor(id, { status: "pending", updatedAt: T + 1 });
    const row = await readRow(id);
    expect(row.status).toBe("open");
    expect(row.chatwootStatusAt).toBe(T);
    // NOT reported as outranked, which is a different answer with a different consequence: the
    // console reads it to decide that something strictly newer is in the row and it must stand down,
    // and a claim is the opposite situation — its own unversioned write, which a fresh command beats.
    expect(result.outrankedByVersion).toBe(false);
  });

  test("a read carrying the gap's own state does not end the fence", async () => {
    // Something moved the status mark while the claim was open — a delivery for another field, an
    // operator's own change — and a mark that moved is not a version for OUR transition. The gap is
    // still open, so a snapshot restating the status the claim replaced is still unplaceable.
    const id = await seedRow({
      status: "open",
      statusClaimUntil: new Date(Date.now() + 30_000),
      statusClaimFrom: "pending",
      statusClaimStampedAt: null,
      chatwootStatusAt: T + 1,
    });
    const result = await applyFor(id, { status: "pending", updatedAt: T + 1 });
    const row = await readRow(id);
    expect(row.status).toBe("open");
    expect(row.chatwootStatusAt).toBe(T + 1);
    expect(result.refusedByStatusClaim).toBe(true);
  });

  test("a read refused inside somebody else's gap keeps its version too", async () => {
    // The owner's GET was issued before a hand-back and this one was answered after it, so this
    // snapshot is the newer reading of the two. Discarding it would let the owner's stale `open`
    // write win, and the event that would have corrected that is the one this window exists because
    // it can be delayed or lost.
    const id = await seedRow({
      status: "open",
      statusClaimUntil: new Date(Date.now() + 30_000),
      statusClaimFrom: "pending",
      statusClaimStampedAt: null,
      chatwootStatusAt: T,
    });
    const result = await applyFor(id, { status: "pending", updatedAt: T + 9 });
    const row = await readRow(id);
    expect(result.refusedByStatusClaim).toBe(true);
    expect(row.status).toBe("open");
    expect(row.statusClaimRefusedAt).toBe(T + 9);
    // Forward-only, like every other mark here: a second probe answered from an older snapshot must
    // not replace the stronger evidence with its own, which the adjudication would then drop.
    await applyFor(id, { status: "pending", updatedAt: T + 2 });
    expect((await readRow(id)).statusClaimRefusedAt).toBe(T + 9);
  });

  // ── THE OWNER'S ADJUDICATION ──
  //
  // This read is the version the source gave our own transition, so it is also the answer to
  // everything the claim had to refuse without one. Both directions are decided here and nowhere
  // else: the mirror only KEPT those versions, it never judged them.
  test("a version refused ahead of ours was a hand-back, and it stands", async () => {
    const until = new Date(Date.now() + 30_000);
    const id = await seedRow({
      status: "open",
      statusClaimUntil: until,
      statusClaimFrom: "pending",
      // A colleague returned the conversation while the toggle was on the wire: both events for that
      // one write were refused and acknowledged, and Chatwoot never sends them again.
      statusClaimRefusedAt: T + 9,
      chatwootStatusAt: T,
    });
    // Our own read is older than that write — a GET issued before it committed comes back with
    // exactly this — so the refusal is what describes the source now.
    // A subscriber, because a durable event with nobody listening writes no row: this asserts the
    // integration side of the announcement, not only the console's.
    await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://sub.example/hook",
        events: ["conversation.status_changed"],
      },
    });
    const published: Record<string, unknown>[] = [];
    // WHEN each half happens, not only that it did. The durable one is the last statement inside the
    // transaction; the realtime one must come after it, because a broadcast made in there is a
    // `pending` every console is holding while the row can still roll back to `open`.
    const order: string[] = [];
    const traced = appDb.$extends({
      query: {
        outboundWebhookDelivery: {
          async createMany({ args, query }) {
            const out = await query(args);
            order.push("enqueued");
            return out;
          },
        },
      },
    }) as unknown as PrismaClient;
    setPublisher((_topic, data) => {
      published.push(JSON.parse(String(data)));
      order.push("broadcast");
    });
    let result: Awaited<ReturnType<typeof applyFor>>;
    try {
      result = await applyFor(
        id,
        { status: "open", updatedAt: T + 1 },
        until,
        traced,
      );
    } finally {
      setPublisher(() => undefined);
    }
    const row = await readRow(id);
    expect(row.status).toBe("pending");
    expect(row.chatwootStatusAt).toBe(T + 9);
    expect(result.state?.status).toBe("pending");
    // The stamp is still our own read's version, which is what it is: the version of OUR write. And
    // the evidence goes with the answer.
    expect(row.statusClaimStampedAt).toBe(T + 1);
    expect(row.statusClaimRefusedAt).toBeNull();
    // AND IT IS ANNOUNCED, because nothing else will: the webhook that carried this transition was
    // acknowledged with its status refused, so the mirror said nothing, and the last thing every open
    // console heard was the claim's own `open`.
    expect(
      published.filter(
        (e) => e.type === "conversation" && e.status === "pending",
      ).length,
    ).toBe(1);
    expect(order).toEqual(["enqueued", "broadcast"]);
    const emitted = await suDb.outboundWebhookDelivery.findMany({
      where: { tenantId, event: "conversation.status_changed" },
      select: { payload: true },
    });
    expect(emitted.length).toBe(1);
    // The inbox travels with the event: subscribers route and filter on it, and this path is not the
    // one that gets to be the exception.
    expect(
      (emitted[0]?.payload as { data?: { inbox_id?: unknown } } | null)?.data
        ?.inbox_id,
    ).toBe(String(inboxRowId));
  });

  test("a version refused behind ours was a stale snapshot, and goes", async () => {
    const until = new Date(Date.now() + 30_000);
    const id = await seedRow({
      status: "open",
      statusClaimUntil: until,
      statusClaimFrom: "pending",
      // The shape issue #468 round 6 found: a pair of `conversation_*` events for a write that
      // happened BEFORE the claim — a customer message reopening the conversation — refused on the
      // way in. Nothing about them is news, and letting either one through would put the agent back
      // into a conversation a colleague is holding.
      statusClaimRefusedAt: T + 1,
      chatwootStatusAt: T,
    });
    await applyFor(id, { status: "open", updatedAt: T + 5 }, until);
    const row = await readRow(id);
    expect(row.status).toBe("open");
    expect(row.statusClaimStampedAt).toBe(T + 5);
    expect(row.statusClaimRefusedAt).toBeNull();
  });

  test("a change applied inside the claim outranks what the gap kept", async () => {
    const until = new Date(Date.now() + 30_000);
    const id = await seedRow({
      // An operator resolved the conversation while the claim was open: that payload stated a status
      // the claim does not refuse, so it was APPLIED, and its version is on the status mark.
      status: "resolved",
      chatwootStatusAt: T + 20,
      statusClaimUntil: until,
      statusClaimFrom: "pending",
      statusClaimRefusedAt: T + 9,
    });
    // The deferred version is ahead of our own read and would otherwise stand, but it is behind the
    // resolve, and nothing here may walk a newer write back.
    await applyFor(id, { status: "open", updatedAt: T + 1 }, until);
    const row = await readRow(id);
    expect(row.status).toBe("resolved");
    expect(row.chatwootStatusAt).toBe(T + 20);
    expect(row.statusClaimRefusedAt).toBeNull();
  });

  test("the caller holding the claim writes through it", async () => {
    const until = new Date(Date.now() + 30_000);
    const id = await seedRow({
      status: "open",
      statusClaimUntil: until,
      statusClaimFrom: "pending",
      statusClaimStampedAt: null,
      chatwootStatusAt: T,
    });
    // The takeover's own reconcile, which is what EARNS the claim the version it was taken without.
    // Read back with the source DISAGREEING, which is the only shape where owning the claim changes
    // the outcome: a snapshot that agrees states something the claim does not refuse anyway. The
    // toggle returned, so this is the freshest word there is about a conversation somebody moved back
    // — and fenced by its own claim the row would sit `open` and unversioned while Chatwoot said
    // `pending`, with the agent silent on a conversation nobody holds.
    await applyFor(id, { status: "pending", updatedAt: T + 1 }, until);
    const row = await readRow(id);
    expect(row.status).toBe("pending");
    expect(row.chatwootStatusAt).toBe(T + 1);
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
