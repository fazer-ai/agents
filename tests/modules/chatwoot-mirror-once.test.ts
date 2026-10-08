import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { mirrorOncePerEvent } from "@/modules/chatwoot/mirror-once";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";

// An inbox with an observer beside its responder gets every event once per route. One mirror run per
// event: the other route's delivery of the same payload reuses it.

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
let instanceId = 0n;
const T0 = 1_790_100_000;

function statusEvent(
  convId: number,
  status: string,
  at: number,
): NormalizedChatwootEvent {
  const n = normalizeChatwootEvent({
    event: "conversation_status_changed",
    id: convId,
    inbox_id: 41,
    status,
    contact_inbox: { id: 9_000 + convId },
    meta: { assignee: null, sender: { id: 8_000 + convId, type: "contact" } },
    channel: "Channel::Whatsapp",
    last_activity_at: at,
    updated_at: at,
  });
  if (!n) throw new Error("payload did not normalize");
  return n;
}

// The real mirror, counted.
function countingMirror() {
  let runs = 0;
  const fn: typeof mirrorChatwootEvent = (...args) => {
    runs += 1;
    return mirrorChatwootEvent(...args);
  };
  return { fn, runs: () => runs };
}

function once(
  n: NormalizedChatwootEvent,
  fn: typeof mirrorChatwootEvent,
  opts: Parameters<typeof mirrorChatwootEvent>[4] = {},
) {
  return mirrorOncePerEvent(tenantId, instanceId, n, appDb, opts, fn);
}

describe.skipIf(!dbUp)("one mirror run per event, not per route", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MIRROR-ONCE", slug: `mirror-once-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 73,
      baseUrl: "https://chat.mirror-once.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("two routes delivering one event at once run the mirror once, and only one of them sees the transition", async () => {
    const m = countingMirror();
    await once(statusEvent(11, "pending", T0), m.fn);
    const resolved = statusEvent(11, "resolved", T0 + 10);
    const [a, b] = await Promise.all([
      once(resolved, m.fn),
      once(resolved, m.fn),
    ]);
    expect(m.runs()).toBe(2); // the setup event, and this one once
    const transitions = [a, b].filter(
      (r) => r.prevStatus !== "resolved" && r.status === "resolved",
    );
    expect(transitions).toHaveLength(1);
    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    expect(a.conversationRowId).toBe(b.conversationRowId);
    expect(a.inboxRowId).toBe(b.inboxRowId);
  });

  test("the second route delivering later reuses the run while its rows stand still", async () => {
    const m = countingMirror();
    const first = statusEvent(12, "pending", T0);
    const lead = await once(first, m.fn);
    const late = await once(first, m.fn);
    expect(m.runs()).toBe(1);
    expect(late.applied).toBe(false);
    expect(late.status).toBe("pending");
    expect(late.prevStatus).toBe("pending");
    expect(late.rowVersions).toBe(lead.rowVersions);
  });

  test("a later delivery over rows that moved since runs again, and the run orders itself as stale", async () => {
    const m = countingMirror();
    const first = statusEvent(18, "pending", T0);
    await once(first, m.fn);
    // A newer event moves the conversation between the two deliveries of `first`.
    await once(statusEvent(18, "resolved", T0 + 20), m.fn);
    const late = await once(first, m.fn);
    expect(m.runs()).toBe(3);
    expect(late.applied).toBe(false);
    expect(late.status).toBe("resolved");
  });

  test("a write by anyone else to the conversation, its inbox or its contact makes the next delivery run", async () => {
    const m = countingMirror();
    const n = statusEvent(19, "pending", T0);
    const lead = await once(n, m.fn);
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: lead.conversationRowId as bigint },
      select: { inboxId: true, contactId: true },
    });
    await suDb.conversation.update({
      where: { id: lead.conversationRowId as bigint },
      data: { redirectOriginDisplayId: 77 },
    });
    await once(n, m.fn);
    expect(m.runs()).toBe(2);
    await suDb.inbox.update({
      where: { id: row.inboxId as bigint },
      data: { name: "renomeada fora do mirror" },
    });
    await once(n, m.fn);
    expect(m.runs()).toBe(3);
    if (row.contactId !== null) {
      await suDb.contact.update({
        where: { id: row.contactId },
        data: { name: "outro nome" },
      });
      await once(n, m.fn);
      expect(m.runs()).toBe(4);
    }
    await once(n, m.fn);
    expect(m.runs()).toBe(row.contactId !== null ? 4 : 3);
  });

  test("a different payload, or the same payload under different options, runs its own mirror", async () => {
    const m = countingMirror();
    await once(statusEvent(13, "pending", T0), m.fn);
    await once(statusEvent(13, "pending", T0 + 1), m.fn);
    await once(statusEvent(13, "pending", T0 + 1), m.fn, {
      suppressInboundWatermark: true,
    });
    expect(m.runs()).toBe(3);
  });

  test("a run that failed is not reused: the other delivery runs its own", async () => {
    let calls = 0;
    const flaky: typeof mirrorChatwootEvent = async (...args) => {
      calls += 1;
      if (calls === 1) {
        await Bun.sleep(50);
        throw new Error("pool exhausted");
      }
      return mirrorChatwootEvent(...args);
    };
    const n = statusEvent(14, "pending", T0);
    const [a, b] = await Promise.allSettled([once(n, flaky), once(n, flaky)]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    expect(calls).toBe(2);
    // And the failure is not remembered: a third delivery reuses the successful run.
    await once(n, flaky);
    expect(calls).toBe(2);
  });

  test("a run that held a write back is not reused: the next delivery runs the mirror again", async () => {
    let calls = 0;
    const holding: typeof mirrorChatwootEvent = async (...args) => {
      calls += 1;
      const r = await mirrorChatwootEvent(...args);
      return calls === 1 ? { ...r, heldBack: true } : r;
    };
    const n = statusEvent(15, "pending", T0);
    const [a, b] = await Promise.all([once(n, holding), once(n, holding)]);
    expect(calls).toBe(2);
    expect(a.heldBack).toBe(true);
    expect(b.heldBack).toBeUndefined();
    await once(n, holding);
    expect(calls).toBe(2);
  });

  test("a status a live claim refused is not reused: once the claim expires, the same event applies", async () => {
    const m = countingMirror();
    const first = await once(statusEvent(16, "pending", T0), m.fn);
    // A local takeover moved the conversation off `pending` and holds a claim on that transition.
    await suDb.conversation.update({
      where: { id: first.conversationRowId as bigint },
      data: {
        status: "open",
        statusClaimUntil: new Date(Date.now() + 45_000),
        statusClaimFrom: "pending",
      },
    });
    const handBack = statusEvent(16, "pending", T0 + 10);
    const refused = await once(handBack, m.fn);
    expect(refused.status).toBe("open");
    expect(refused.heldBack).toBe(true);

    await suDb.conversation.update({
      where: { id: first.conversationRowId as bigint },
      data: { statusClaimUntil: new Date(Date.now() - 1_000) },
    });
    const later = await once(handBack, m.fn);
    expect(m.runs()).toBe(3);
    expect(later.status).toBe("pending");
  });

  test("an unversioned payload that serializes two transitions alike runs for each of them", async () => {
    const m = countingMirror();
    const bare = (status: string) => {
      const n = statusEvent(17, status, T0);
      return { ...n, conversationUpdatedAt: null } as NormalizedChatwootEvent;
    };
    const [a, b] = await Promise.all([
      once(bare("open"), m.fn),
      once(bare("open"), m.fn),
    ]);
    expect(m.runs()).toBe(1);
    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    await once(bare("resolved"), m.fn);
    // The same payload as the first, a real reopen: it runs.
    const reopened = await once(bare("open"), m.fn);
    expect(m.runs()).toBe(3);
    expect(reopened.status).toBe("open");
  });
});
