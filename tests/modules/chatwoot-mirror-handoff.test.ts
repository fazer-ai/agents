import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #61. After a handoff, Chatwoot delivers a burst of conversation_* events and then a
// message_updated tail whose conversation snapshot was serialized when the message event fired —
// and handoff_to_human posts the customer message BEFORE it assigns the human, so that snapshot is
// always the pre-handoff one. Whether the mirror survived came down to luck: `last_activity_at` has
// one-second resolution and does not advance on a status or assignee change, so when the whole burst
// landed inside one second the monotonic guard could not order it and the stale tail won, rewriting
// the row to pending and CLEARING a real human assignee. Two conversations twenty minutes apart, the
// same code path and the same event sequence, ended differently.
//
// The ordering key is the conversation's own `updated_at`, which every payload carries and which
// moves on exactly the writes last_activity_at ignores. These tests therefore build payloads with
// BOTH timestamps, as Chatwoot sends them.

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
const INBOX = 71;

interface ConvOver {
  status: string;
  // last_activity_at: whole seconds, and it only moves when a MESSAGE is created.
  lastActivityAt: number;
  // conversation.updated_at: seconds with a fraction, and it moves on every write to the row.
  // Left out to stand for a Chatwoot older than 4.0.2, which does not send it.
  updatedAt?: number;
  assignee?: { id: number; name: string } | null;
}

function convPayload(convId: number, over: ConvOver) {
  return {
    id: convId,
    inbox_id: INBOX,
    status: over.status,
    contact_inbox: { id: 88_000 + convId },
    meta: {
      assignee_type: over.assignee ? "User" : null,
      assignee: over.assignee ?? null,
      sender: {
        id: 500 + convId,
        name: "Cliente",
        phone_number: "+5511999990000",
      },
    },
    channel: "Channel::Email",
    last_activity_at: over.lastActivityAt,
    ...(over.updatedAt !== undefined ? { updated_at: over.updatedAt } : {}),
  };
}

function messageEvent(
  convId: number,
  event: "message_created" | "message_updated",
  over: ConvOver & { messageId: number; messageType?: string },
) {
  return {
    event,
    id: over.messageId,
    content: "Vou te transferir para um atendente.",
    message_type: over.messageType ?? "outgoing",
    private: false,
    conversation: convPayload(convId, over),
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  expect(n).not.toBeNull();
  if (!n) throw new Error("unreachable");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function mirrored(convId: number) {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { status: true, assigneeType: true, assigneeId: true },
  });
}

const HUMAN = { id: 3, name: "Atendente Humana" };

// The burst as delivered, in order. `t` is the burst's shared last_activity_at (the agent's message);
// `u` is when each event was serialized. The tail carries the snapshot from BEFORE the status change,
// because that is when handoff_to_human posted its message. `opts.legacy` drops updated_at from every
// payload, standing for a Chatwoot too old to send it.
async function handoffBurst(
  convId: number,
  t: number,
  tail: number,
  u: number,
  opts: { legacy?: boolean } = {},
) {
  const at = (sec: number) => (opts.legacy ? undefined : sec);
  await mirror({
    event: "conversation_updated",
    ...convPayload(convId, {
      status: "pending",
      lastActivityAt: t,
      updatedAt: at(u + 0.1),
    }),
  });
  for (const event of [
    "conversation_updated",
    "conversation_opened",
    "conversation_status_changed",
  ] as const) {
    await mirror({
      event,
      ...convPayload(convId, {
        status: "open",
        lastActivityAt: t,
        updatedAt: at(u + 0.4),
      }),
    });
  }
  await mirror({
    event: "conversation_updated",
    ...convPayload(convId, {
      status: "open",
      lastActivityAt: t,
      updatedAt: at(u + 0.55),
      assignee: HUMAN,
    }),
  });
  for (let i = 0; i < 2; i++) {
    await mirror(
      messageEvent(convId, "message_updated", {
        messageId: 900 + convId,
        status: "pending",
        lastActivityAt: tail,
        // Serialized between the pending write and the reopen: this is the frozen copy.
        updatedAt: at(u + 0.25),
      }),
    );
  }
}

describe.skipIf(!dbUp)(
  "mirror: a handoff is not undone by a frozen message tail",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "MIRROR-HANDOFF", slug: `mirror-handoff-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 11,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      await suDb.webhookSubscription.create({
        data: {
          tenantId,
          url: "https://example.com/hook",
          events: ["conversation.handoff"],
        },
      });
    });

    afterAll(async () => {
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await su?.$disconnect();
      await app?.$disconnect();
    });

    // The conversation from the report that broke: every event, stale tail included, on 1786483614.
    test("the whole burst inside one second still leaves the human owning it", async () => {
      await handoffBurst(6, 1_786_483_614, 1_786_483_614, 1_786_483_614);
      const row = await mirrored(6);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // The conversation that survived on luck: its tail was one second behind, so the monotonic guard
    // discarded it. It must keep working for the same reason it worked before, not by accident.
    test("a tail one second behind is still discarded", async () => {
      await handoffBurst(9, 1_786_484_801, 1_786_484_800, 1_786_484_801);
      const row = await mirrored(9);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // Same burst on a Chatwoot that does not send updated_at: with no key to order by, a message
    // snapshot is not trusted for conversation state at all.
    test("without the ordering key the tail is distrusted outright", async () => {
      await handoffBurst(7, 1_786_485_000, 1_786_485_000, 0, { legacy: true });
      const row = await mirrored(7);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
    });

    // Chatwoot reopens BEFORE it dispatches the message event
    // (Message#execute_after_create_commit_callbacks: reopen_conversation, then
    // dispatch_create_events), so this snapshot is current and must keep being mirrored — the
    // guardrail from the resolved-conversation follow-up chain.
    test("a brand-new incoming message still reopens a resolved conversation", async () => {
      const T = 1_786_490_000;
      await mirror({
        event: "conversation_resolved",
        ...convPayload(12, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      });
      await mirror(
        messageEvent(12, "message_created", {
          messageId: 950,
          messageType: "incoming",
          status: "open",
          lastActivityAt: T + 60,
          updatedAt: T + 60.3,
        }),
      );
      expect((await mirrored(12)).status).toBe("open");
    });

    // The mirror image of the burst above, and the reason ordering beats a blanket "message events
    // are never authoritative": when the handoff's own event is delayed past the first message the
    // human sends, that message's snapshot is the ONLY witness of the new owner. Distrusting it
    // leaves the conversation bot-owned forever, because the delayed event loses to the monotonic
    // guard on arrival, and conversation.handoff never fires for anyone listening.
    test("a message that overtakes the handoff event carries the handoff", async () => {
      const T = 1_786_492_000;
      const handoffsBefore = await suDb.outboundWebhookDelivery.count({
        where: { tenantId, event: "conversation.handoff" },
      });
      await mirror({
        event: "conversation_updated",
        ...convPayload(21, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      await mirror(
        messageEvent(21, "message_created", {
          messageId: 970,
          status: "open",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
          assignee: HUMAN,
        }),
      );
      await mirror({
        event: "conversation_updated",
        ...convPayload(21, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.9,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(21);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
      const handoffsAfter = await suDb.outboundWebhookDelivery.count({
        where: { tenantId, event: "conversation.handoff" },
      });
      expect(handoffsAfter - handoffsBefore).toBe(1);
    });

    // Chatwoot emits several events for ONE write to the conversation (conversation_updated +
    // conversation_status_changed), all carrying that write's version. They must not fight: the one
    // that arrives second is frequently the one carrying `meta`, so rejecting an equal version
    // would drop the assignee it brought.
    test("companions of one write all apply, whichever arrives with meta", async () => {
      const T = 1_786_494_000;
      const U = T + 0.123_456;
      await mirror({
        event: "conversation_updated",
        ...convPayload(27, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      await mirror({
        event: "conversation_status_changed",
        ...convPayload(27, { status: "open", lastActivityAt: T, updatedAt: U }),
      });
      await mirror({
        event: "conversation_updated",
        ...convPayload(27, {
          status: "open",
          lastActivityAt: T,
          updatedAt: U,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(27);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // The stamp is stored as the double Chatwoot sent. Rounding it to a timestamp would collapse
    // two writes a few hundred microseconds apart into one version, and the second would lose.
    test("two writes inside the same millisecond stay ordered", async () => {
      const T = 1_786_495_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(30, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.500_1,
          assignee: HUMAN,
        }),
      });
      // 200µs EARLIER, same millisecond: a re-delivery of the pre-handoff snapshot.
      await mirror(
        messageEvent(30, "message_updated", {
          messageId: 990,
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.499_9,
        }),
      );
      const row = await mirrored(30);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
    });

    // A conversation mirrored before the watermark column existed knows the payload's version but
    // not its own. The payload's is the first thing we learn, so it decides that one event and
    // ordering runs from there — otherwise the row would fall back to the type rule forever and a
    // handoff carried by a message would stay invisible.
    test("a row with no stored version bootstraps from the payload", async () => {
      const T = 1_786_496_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(33, { status: "pending", lastActivityAt: T }),
      });
      expect(
        (
          await suDb.conversation.findFirstOrThrow({
            where: { tenantId, chatwootConversationId: 33 },
            select: { chatwootUpdatedAt: true },
          })
        ).chatwootUpdatedAt,
      ).toBeNull();
      await mirror(
        messageEvent(33, "message_created", {
          messageId: 995,
          status: "open",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
          assignee: HUMAN,
        }),
      );
      const row = await mirrored(33);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      // And from here the ordering holds: the pre-handoff snapshot no longer wins.
      await mirror(
        messageEvent(33, "message_updated", {
          messageId: 995,
          status: "pending",
          lastActivityAt: T + 5,
          updatedAt: T + 0.2,
        }),
      );
      expect((await mirrored(33)).status).toBe("open");
    });

    // A re-delivery of the same event carries the same version stamp, so it is not news.
    test("a re-delivered event cannot walk the state backwards", async () => {
      const T = 1_786_493_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(24, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.2,
          assignee: HUMAN,
        }),
      });
      await mirror({
        event: "conversation_resolved",
        ...convPayload(24, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.6,
        }),
      });
      await mirror({
        event: "conversation_updated",
        ...convPayload(24, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.2,
          assignee: HUMAN,
        }),
      });
      expect((await mirrored(24)).status).toBe("resolved");
    });
  },
);
