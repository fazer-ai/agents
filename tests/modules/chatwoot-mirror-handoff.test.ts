import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher } from "@/api/features/realtime/realtime.service";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  handoffConversation,
  setConversationStatus,
} from "@/modules/conversations/service";
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
  customAttributes?: Record<string, unknown>;
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
    ...(over.customAttributes
      ? { custom_attributes: over.customAttributes }
      : {}),
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
    select: {
      status: true,
      assigneeType: true,
      assigneeId: true,
      lastEventAt: true,
    },
  });
}

const HUMAN = { id: 3, name: "Atendente Humana" };

// The realtime envelope, as the console's socket receives it.
interface ServerEventLike {
  type: string;
  status?: string;
  assigneeId?: number | null;
  assigneeType?: string | null;
  lastEventAt?: string | null;
}

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

    // The reopen above is the ONE transition a message carries, so it is also the one place where a
    // message moves state — and the two halves of the rule have to stay together there too. If it
    // moved the status without claiming the version, the row would be ahead of its own watermark,
    // and a companion of the resolve (same version, Chatwoot emits several events per write) would
    // sail through the idempotent `>=` and write `resolved` back over a customer who is waiting.
    // Chatwoot stamps a strictly greater version on that snapshot: `reopen_conversation` runs, then
    // `set_conversation_activity` does `update_columns(..., updated_at: Time.current)`, and only
    // then `dispatch_create_events` serializes it.
    test("a resolve companion cannot undo the reopen it arrives after", async () => {
      const T = 1_786_496_100;
      await mirror({
        event: "conversation_resolved",
        ...convPayload(29, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      });
      await mirror(
        messageEvent(29, "message_created", {
          messageId: 974,
          messageType: "incoming",
          status: "open",
          lastActivityAt: T + 60,
          updatedAt: T + 60.3,
        }),
      );
      expect((await mirrored(29)).status).toBe("open");
      // The companion of the resolve, delayed: same version as the write we already applied, and an
      // older last_activity_at.
      await mirror({
        event: "conversation_status_changed",
        ...convPayload(29, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      });
      expect((await mirrored(29)).status).toBe("open");
    });

    // The same undo, from the other side: here the mirror never SAW the resolve, so there is no
    // status change to notice when the customer's message arrives — the row already says open. The
    // delayed resolve then carries a version greater than anything applied and would close a
    // conversation with a customer waiting in it, firing the closing hooks on the way.
    //
    // What rules it out is not a version at all: `last_activity_at` moves only when a message is
    // created, so a row ahead of this event on that axis has seen a message the event knows nothing
    // about — and Chatwoot reopens on a new incoming message, so a `resolved` from before it is
    // already void at the source.
    test("a resolve that predates the customer's message cannot close the conversation", async () => {
      const T = 1_786_496_800;
      await mirror({
        event: "conversation_updated",
        ...convPayload(31, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      await mirror(
        messageEvent(31, "message_created", {
          messageId: 975,
          messageType: "incoming",
          status: "open",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
        }),
      );
      await mirror({
        event: "conversation_resolved",
        ...convPayload(31, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.5,
        }),
      });
      expect((await mirrored(31)).status).toBe("open");
    });

    // The close fence has to key on the CUSTOMER's last message, not on any activity. Only a new
    // incoming message reopens the conversation; an outgoing reply or a private note advances
    // `last_activity_at` and reopens nothing. Treating those as evidence of a reopen would discard a
    // genuine resolve and leave the mirror open, with the follow-up armed and the bot answering.
    test("a resolve delayed behind an outgoing message still closes the conversation", async () => {
      const T = 1_786_504_600;
      await mirror({
        event: "conversation_updated",
        ...convPayload(50, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      // The AGENT replies: last_activity_at moves, nothing reopens.
      await mirror(
        messageEvent(50, "message_created", {
          messageId: 979,
          messageType: "outgoing",
          status: "open",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
        }),
      );
      // The resolve was serialized before that reply and delivered after it.
      await mirror({
        event: "conversation_resolved",
        ...convPayload(50, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 2,
        }),
      });
      expect((await mirrored(50)).status).toBe("resolved");
    });

    // The bags are not the only unversioned field a delayed event carries. The conversation's
    // RELATIONS travel in every payload too, and the graph's thread key is built from the contact
    // inbox — restoring an obsolete one moves the agent's work to another thread.
    test("a delayed conversation event does not restore obsolete relations", async () => {
      const T = 1_786_505_200;
      await mirror({
        event: "conversation_updated",
        ...convPayload(51, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      // A newer message observes the contact inbox after a merge.
      const merged = messageEvent(51, "message_created", {
        messageId: 980,
        messageType: "incoming",
        status: "pending",
        lastActivityAt: T + 5,
        updatedAt: T + 5.4,
      }) as { conversation: { contact_inbox: { id: number } } };
      merged.conversation.contact_inbox = { id: 99_051 };
      await mirror(merged);
      const afterMerge = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 51 },
        select: { contactInboxId: true },
      });
      expect(afterMerge.contactInboxId).toBe(99_051);
      // The handoff, serialized before the merge and delivered after it: newest word on the
      // assignee, and no word at all on which contact inbox this conversation now belongs to.
      await mirror({
        event: "conversation_updated",
        ...convPayload(51, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.9,
          assignee: HUMAN,
        }),
      });
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 51 },
        select: { contactInboxId: true, assigneeType: true },
      });
      expect(row.assigneeType).toBe("User");
      expect(row.contactInboxId).toBe(99_051);
    });

    // The mirror image of the burst above, and the reason ordering beats a blanket "message events
    // are never authoritative": when the handoff's own event is delayed past the first message the
    // human sends, that message's snapshot is the ONLY witness of the new owner. Distrusting it
    // leaves the conversation bot-owned forever, because the delayed event loses to the monotonic
    // guard on arrival, and conversation.handoff never fires for anyone listening.
    test("a handoff event overtaken by a message still lands when it arrives", async () => {
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

    // The same delayed handoff on a row that predates the column. The migration leaves
    // `chatwoot_updated_at` null on every conversation that already exists, so on the deploy that
    // ships this there is no stored version to order against — and a fallback to last_activity_at
    // there would put exactly those rows back under the guard this change exists to remove, which
    // is every conversation live at the moment of the upgrade.
    test("a row with no watermark yet still takes the delayed handoff", async () => {
      const T = 1_786_493_500;
      // Seeded by an event carrying no updated_at, which is the shape a migrated row has: present,
      // and holding no version.
      await mirror({
        event: "conversation_updated",
        ...convPayload(22, { status: "pending", lastActivityAt: T }),
      });
      const seeded = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 22 },
        select: { chatwootStatusAt: true, chatwootAssigneeAt: true },
      });
      expect(seeded.chatwootStatusAt).toBeNull();
      expect(seeded.chatwootAssigneeAt).toBeNull();
      await mirror(
        messageEvent(22, "message_created", {
          messageId: 971,
          status: "open",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
          assignee: HUMAN,
        }),
      );
      await mirror({
        event: "conversation_updated",
        ...convPayload(22, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.9,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(22);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // The attribute bags are ASSIGNED from whichever payload arrives, and the stale check used to be
    // what kept a late delivery away from them. Now that a conversation event can win on version
    // alone, one whose last_activity_at is older than the row's would roll a bag back over the newer
    // payload that already mirrored it — a card jumping back a column after the handoff event lands.
    test("a delayed conversation event does not roll back the attribute bags", async () => {
      const T = 1_786_495_400;
      await mirror({
        event: "conversation_updated",
        ...convPayload(26, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
          customAttributes: { etapa: "novo" },
        }),
      });
      await mirror(
        messageEvent(26, "message_created", {
          messageId: 973,
          status: "pending",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
          customAttributes: { etapa: "em-atendimento" },
        }),
      );
      await mirror({
        event: "conversation_updated",
        ...convPayload(26, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.9,
          assignee: HUMAN,
          customAttributes: { etapa: "novo" },
        }),
      });
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 26 },
        select: { customAttributes: true, assigneeType: true },
      });
      // The handoff still lands — it is the newest word on the assignee...
      expect(row.assigneeType).toBe("User");
      // ...and it is not the newest word on the bag it happened to be carrying.
      expect(row.customAttributes).toEqual({ etapa: "em-atendimento" });
    });

    // What the mirror RETURNS is what the webhook broadcasts and what the conversation list sorts
    // on. A delayed conversation event legitimately carries an older last_activity_at, the row keeps
    // the newer one, and the return has to report the value that was persisted — otherwise every
    // client rewinds the conversation's recency over an event that did not change it.
    test("a delayed conversation event reports the timestamp the row kept", async () => {
      const T = 1_786_494_200;
      await mirror({
        event: "conversation_updated",
        ...convPayload(23, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      await mirror(
        messageEvent(23, "message_created", {
          messageId: 972,
          status: "pending",
          lastActivityAt: T + 5,
          updatedAt: T + 5.4,
        }),
      );
      const res = await mirror({
        event: "conversation_updated",
        ...convPayload(23, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.9,
          assignee: HUMAN,
        }),
      });
      const stored = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 23 },
        select: { lastEventAt: true },
      });
      expect(res.applied).toBe(true);
      expect(res.lastEventAt?.getTime()).toBe(stored.lastEventAt?.getTime());
      expect(res.lastEventAt?.getTime()).toBe((T + 5) * 1000);
    });

    // With no version anywhere, a message snapshot cannot be ordered against the conversation at
    // all, so it moves no conversation state. Trusting it to PROMOTE an assignee was tried and is
    // not safe either: a message a human sent BEFORE the conversation went back to the bot arrives
    // with the same last_activity_at, and would re-take it — a false handoff, fired at whoever is
    // subscribed. Neither direction can be ordered, so the mirror keeps what it has.
    test("without any version, a message that arrives late cannot re-take the conversation", async () => {
      const T = 1_786_497_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(36, {
          status: "open",
          lastActivityAt: T,
          assignee: HUMAN,
        }),
      });
      await mirror({
        event: "conversation_updated",
        ...convPayload(36, { status: "pending", lastActivityAt: T }),
      });
      // The human's message, serialized while they still owned it, delivered after the handback.
      await mirror(
        messageEvent(36, "message_created", {
          messageId: 998,
          status: "open",
          lastActivityAt: T,
          assignee: HUMAN,
        }),
      );
      const row = await mirrored(36);
      expect(row.status).toBe("pending");
      expect(row.assigneeType).toBeNull();
    });

    // The other half of that rule: the frozen tail of a handoff is exactly a message snapshot that
    // would UNDO the takeover, and it stays fenced out even with no version to order by.
    test("without any version, a message still cannot take the conversation back", async () => {
      await handoffBurst(39, 1_786_498_000, 1_786_498_000, 0, { legacy: true });
      const row = await mirrored(39);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // A payload with no `meta` said nothing about the assignee (the degraded shape behind issue
    // #27). It must not apply state — and, more importantly, must not claim to be the version we
    // hold, or it outranks the complete payload that arrives late with the assignment.
    // The degraded shape behind issue #27 drops `meta`, which is the ASSIGNEE. The status field is
    // right there and intact, and a resolve that does not reach the mirror keeps the follow-up armed
    // and the bot answering on a conversation Chatwoot has already closed.
    test("a degraded payload still resolves the conversation", async () => {
      const T = 1_786_499_500;
      await mirror({
        event: "conversation_updated",
        ...convPayload(44, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.1,
          assignee: HUMAN,
        }),
      });
      const degraded = convPayload(44, {
        status: "resolved",
        lastActivityAt: T,
        updatedAt: T + 0.9,
      }) as Record<string, unknown>;
      degraded.meta = undefined;
      await mirror({ event: "conversation_resolved", ...degraded });
      const row = await mirrored(44);
      expect(row.status).toBe("resolved");
      // ...and it still says nothing about the assignee, so the human it does not mention stays.
      expect(row.assigneeType).toBe("User");
    });

    // A degraded event applies its status; a complete one delivered after it, from EARLIER, still
    // owns the assignee. Both are true at once, and with a single mark they cannot be: whichever
    // version the mark holds, one of the two fields is being ordered by a number that does not
    // describe it.
    test("a status from a degraded event is not walked back by an older complete one", async () => {
      const T = 1_786_502_400;
      await mirror({
        event: "conversation_updated",
        ...convPayload(46, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      const degraded = convPayload(46, {
        status: "resolved",
        lastActivityAt: T,
        updatedAt: T + 0.9,
      }) as Record<string, unknown>;
      degraded.meta = undefined;
      await mirror({ event: "conversation_resolved", ...degraded });
      expect((await mirrored(46)).status).toBe("resolved");
      // Serialized BEFORE the resolve and delivered after it.
      await mirror({
        event: "conversation_updated",
        ...convPayload(46, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.5,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(46);
      // The older event owns the assignee it is the only witness of...
      expect(row.assigneeType).toBe("User");
      // ...and does not get to reopen a conversation resolved after it.
      expect(row.status).toBe("resolved");
    });

    // The reopen is the one place a MESSAGE writes state, so it is the one place a message claims a
    // version — and with the marks split it can, because it moves the STATUS mark and leaves the
    // assignee's alone. Inside a single second the `last_activity_at` fence cannot separate the
    // resolve's companion from the reopen (that one-second resolution is the whole issue), so the
    // version is the only thing left that can.
    test("a reopen in the same second as the resolve still outranks its companion", async () => {
      const T = 1_786_503_100;
      await mirror({
        event: "conversation_resolved",
        ...convPayload(47, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      });
      await mirror(
        messageEvent(47, "message_created", {
          messageId: 976,
          messageType: "incoming",
          status: "open",
          // Same whole second, a later fraction: exactly the burst this issue is about.
          lastActivityAt: T,
          updatedAt: T + 0.45,
        }),
      );
      expect((await mirrored(47)).status).toBe("open");
      await mirror({
        event: "conversation_status_changed",
        ...convPayload(47, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      });
      expect((await mirrored(47)).status).toBe("open");
    });

    // The claim needs no "only if it changed" guard, and cannot have one: the mirror often has not
    // SEEN the change yet. Here the resolve is itself delayed, so the row still says `open` when the
    // customer's message reopens — nothing looks different, and withholding the version on that
    // basis leaves the delayed resolve looking newer than the mark. Inside one whole second the
    // last_activity_at fence cannot separate them either.
    test("a reopen claims its version even when the row already looked open", async () => {
      const T = 1_786_503_600;
      await mirror({
        event: "conversation_updated",
        ...convPayload(48, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      // Chatwoot resolved at T+0.5 and that event is still being retried; the mirror never saw it.
      await mirror(
        messageEvent(48, "message_created", {
          messageId: 977,
          messageType: "incoming",
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.7,
        }),
      );
      await mirror({
        event: "conversation_resolved",
        ...convPayload(48, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.5,
        }),
      });
      expect((await mirrored(48)).status).toBe("open");
    });

    // And the other direction, which is what makes the unconditional claim safe: a message serialized
    // BEFORE a conversation event carries a lower version, so it cannot push the mark past it. The
    // reverse — a message with a HIGHER version whose snapshot predates that event — cannot happen:
    // the snapshot is read from the row at dispatch (`set_conversation_activity` runs first), so a
    // newer message always sees the newer state.
    test("a message serialized before a conversation event does not outrank it", async () => {
      const T = 1_786_504_100;
      await mirror({
        event: "conversation_updated",
        ...convPayload(49, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      await mirror(
        messageEvent(49, "message_created", {
          messageId: 978,
          messageType: "incoming",
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      );
      // The handoff, serialized after that message and delivered after it.
      await mirror({
        event: "conversation_updated",
        ...convPayload(49, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.5,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(49);
      expect(row.assigneeType).toBe("User");
      expect(row.status).toBe("open");
    });

    test("a payload that says nothing about the assignee claims no version", async () => {
      const T = 1_786_499_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(42, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.1,
        }),
      });
      const degraded = convPayload(42, {
        status: "open",
        lastActivityAt: T,
        updatedAt: T + 0.9,
      }) as Record<string, unknown>;
      degraded.meta = undefined;
      await mirror({ event: "conversation_updated", ...degraded });
      // Its status applies — that field is intact — and it moves the STATUS mark with it. What it
      // does not touch, and the point of this test, is the assignee it never mentioned, nor the mark
      // that orders one.
      const afterDegraded = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 42 },
        select: {
          status: true,
          assigneeType: true,
          chatwootStatusAt: true,
          chatwootAssigneeAt: true,
        },
      });
      expect(afterDegraded.status).toBe("open");
      expect(afterDegraded.assigneeType).toBeNull();
      expect(afterDegraded.chatwootStatusAt).toBe(T + 0.9);
      expect(afterDegraded.chatwootAssigneeAt).toBe(T + 0.1);
      // The real assignment, serialized EARLIER than the degraded payload and delivered after it.
      await mirror({
        event: "conversation_updated",
        ...convPayload(42, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.5,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(42);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
    });

    // Same rule on the CREATE branch. A row seeded from a degraded event holds a status version and
    // no assignee version at all, so the complete event that follows from EARLIER still owns the
    // assignee it is the only witness of, and still does not get to walk the status back.
    test("a row created from a degraded payload stores only the version it can vouch for", async () => {
      const T = 1_786_500_000;
      const degraded = convPayload(45, {
        status: "pending",
        lastActivityAt: T,
        updatedAt: T + 0.9,
      }) as Record<string, unknown>;
      degraded.meta = undefined;
      await mirror({ event: "conversation_updated", ...degraded });
      expect(
        (
          await suDb.conversation.findFirstOrThrow({
            where: { tenantId, chatwootConversationId: 45 },
            select: { chatwootAssigneeAt: true },
          })
        ).chatwootAssigneeAt,
      ).toBeNull();
      // Serialized EARLIER than the degraded payload, delivered after it.
      await mirror({
        event: "conversation_updated",
        ...convPayload(45, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 0.5,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(45);
      expect(row.assigneeType).toBe("User");
      expect(row.status).toBe("pending");
    });

    // The mirror defaults a created row to `open` when the payload carried no status. That default
    // is ours, not a reading of the source, so it must claim no version: claiming one would protect
    // an invented status against the event that carries the real one.
    test("the created row's default status claims no version, so the real status still lands", async () => {
      const T = 1_786_505_000;
      const noStatus = convPayload(52, {
        status: "open",
        lastActivityAt: T,
        updatedAt: T + 0.9,
      }) as Record<string, unknown>;
      noStatus.status = undefined;
      await mirror({ event: "conversation_updated", ...noStatus });
      const created = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 52 },
        select: { status: true, chatwootStatusAt: true },
      });
      expect(created.status).toBe("open");
      expect(created.chatwootStatusAt).toBeNull();
      // Serialized EARLIER than the one that created the row, delivered after it, and carrying the
      // status the source actually holds.
      await mirror({
        event: "conversation_updated",
        ...convPayload(52, {
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.5,
        }),
      });
      expect((await mirrored(52)).status).toBe("resolved");
    });

    // Chatwoot emits several events for ONE write to the conversation (conversation_updated +
    // conversation_status_changed), all carrying that write's version. They must not fight: the one
    // that arrives second is frequently the one carrying `meta`, so rejecting an equal version
    // would drop the assignee it brought.
    // Chatwoot emits several events for ONE write (conversation_updated +
    // conversation_status_changed), so an equal version is routine, not exotic. The pair must land
    // on the same row state whichever half is delivered first: they describe the same row version,
    // and a real unassignment would carry a strictly greater one. Under a plain `>=` the second
    // delivery simply wins, so the reversed order clears the human and re-opens the very regression
    // this suite is about.
    test.each([
      ["meta last", ["bare", "meta"]],
      ["meta first", ["meta", "bare"]],
    ] as const)(
      "companions of one write converge on the same state (%s)",
      async (_label, order) => {
        const convId = order[0] === "bare" ? 27 : 28;
        const T = 1_786_494_000;
        const U = T + 0.123_456;
        await mirror({
          event: "conversation_updated",
          ...convPayload(convId, {
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const events = {
          bare: {
            event: "conversation_status_changed",
            ...convPayload(convId, {
              status: "open",
              lastActivityAt: T,
              updatedAt: U,
            }),
          },
          meta: {
            event: "conversation_updated",
            ...convPayload(convId, {
              status: "open",
              lastActivityAt: T,
              updatedAt: U,
              assignee: HUMAN,
            }),
          },
        };
        for (const which of order) await mirror(events[which]);
        const row = await mirrored(convId);
        expect(row.status).toBe("open");
        expect(row.assigneeType).toBe("User");
        expect(row.assigneeId).toBe(3);
      },
    );

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
    // A conversation mirrored before this column existed carries no version. Only OUR history is
    // missing, so the first versioned conversation event establishes the mark and ordering runs from
    // there.
    test("a row with no stored version bootstraps from the first conversation event", async () => {
      const T = 1_786_496_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(33, { status: "pending", lastActivityAt: T }),
      });
      expect(
        (
          await suDb.conversation.findFirstOrThrow({
            where: { tenantId, chatwootConversationId: 33 },
            select: { chatwootAssigneeAt: true },
          })
        ).chatwootAssigneeAt,
      ).toBeNull();
      await mirror({
        event: "conversation_updated",
        ...convPayload(33, {
          status: "open",
          lastActivityAt: T,
          updatedAt: T + 5.4,
          assignee: HUMAN,
        }),
      });
      const row = await mirrored(33);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      // And from here ordering holds: an older conversation event no longer wins.
      await mirror({
        event: "conversation_updated",
        ...convPayload(33, {
          status: "pending",
          lastActivityAt: T,
          updatedAt: T + 0.2,
        }),
      });
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

    // The one thing ordering cannot rank: a state write of OUR OWN. The console's buttons write
    // status/assignee straight to this row, and Chatwoot answers them with no version (its REST
    // never serializes a conversation's updated_at), so a snapshot serialized BEFORE the click can
    // still carry a higher version than the row's stamp. It must not undo the click — the mid-turn
    // ownership recheck reads this row, so a wiped assignee is the bot replying over the operator.
    describe("state written from our own console", () => {
      const opCtx = (): TenantContext => ({
        tenantId,
        userId: null,
        role: "TENANT_ADMIN",
      });

      // `live` is what a GET on the conversation answers AFTER the write, which is where the version
      // of our own write comes from: the two write endpoints render the agent / a status blob and
      // never the conversation's updated_at, but the REST show renders the same `updated_at.to_f`
      // the webhook carries. `live: null` stands for a GET that failed.
      function stubClient(
        live?: {
          status: string;
          assignee?: { id: number; name: string } | null;
          lastActivityAt: number;
          updatedAt: number | null;
        } | null,
      ) {
        const calls: string[] = [];
        const client = {
          assignToAgent: async () => {
            calls.push("assignToAgent");
            return {};
          },
          unassignConversation: async () => {
            calls.push("unassignConversation");
            return {};
          },
          toggleStatus: async () => {
            calls.push("toggleStatus");
            return {};
          },
          getConversation: async () => {
            calls.push("getConversation");
            if (live === null) throw new Error("Chatwoot API 502 for GET");
            if (live === undefined) return {};
            return {
              id: 1,
              status: live.status,
              meta: {
                assignee_type: live.assignee ? "User" : null,
                assignee: live.assignee ?? null,
              },
              last_activity_at: live.lastActivityAt,
              ...(live.updatedAt === null
                ? {}
                : { updated_at: live.updatedAt }),
            };
          },
        };
        return {
          calls,
          makeClient: async () => client as never,
        };
      }

      async function rowIdOf(convId: number) {
        const r = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: convId },
          select: { id: true },
        });
        return r.id;
      }

      test("a take-over in the console survives a message tail from before it", async () => {
        const T = 1_786_500_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(40, {
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const stub = stubClient();
        await handoffConversation(
          opCtx(),
          await rowIdOf(40),
          HUMAN.id,
          { makeClient: stub.makeClient },
          appDb,
        );
        expect(stub.calls).toEqual([
          "assignToAgent",
          "toggleStatus",
          "getConversation",
        ]);
        // Serialized after the version we hold, but before the operator clicked. Higher version,
        // older truth.
        await mirror(
          messageEvent(40, "message_updated", {
            messageId: 940,
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 0.3,
          }),
        );
        const row = await mirrored(40);
        expect(row.assigneeType).toBe("User");
        expect(row.assigneeId).toBe(HUMAN.id);
        expect(row.status).toBe("open");
      });

      test("a resolve in the console is not walked back by a message tail", async () => {
        const T = 1_786_501_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(41, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const stub = stubClient();
        await setConversationStatus(
          opCtx(),
          await rowIdOf(41),
          "resolved",
          { makeClient: stub.makeClient },
          appDb,
        );
        await mirror(
          messageEvent(41, "message_updated", {
            messageId: 941,
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.3,
          }),
        );
        expect((await mirrored(41)).status).toBe("resolved");
      });

      // Issue #77. The tails above are MESSAGE events, which stopped writing conversation state in
      // #61. A conversation event is the case that remained: Chatwoot may have serialized one before
      // the operator clicked and still be retrying its delivery (AgentBots::WebhookJob retries 3x at
      // 3s), so it lands after the local write carrying the pre-click truth AND a higher version than
      // the row's stamp — because the local write had no version to claim.
      test("a take-over in the console survives a CONVERSATION event serialized before it", async () => {
        const T = 1_786_504_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(60, {
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        // The GET after the write reports the conversation as it now is, at the version our write
        // produced — later than anything serialized before the click.
        const stub = stubClient({
          status: "open",
          assignee: HUMAN,
          lastActivityAt: T,
          updatedAt: T + 0.5,
        });
        await handoffConversation(
          opCtx(),
          await rowIdOf(60),
          HUMAN.id,
          { makeClient: stub.makeClient },
          appDb,
        );
        expect(stub.calls).toContain("getConversation");
        await mirror({
          event: "conversation_updated",
          ...convPayload(60, {
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 0.3,
          }),
        });
        const row = await mirrored(60);
        expect(row.assigneeType).toBe("User");
        expect(row.assigneeId).toBe(HUMAN.id);
        expect(row.status).toBe("open");
      });

      test("a resolve in the console survives one too", async () => {
        const T = 1_786_505_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(61, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const stub = stubClient({
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 0.5,
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(61),
          "resolved",
          { makeClient: stub.makeClient },
          appDb,
        );
        await mirror({
          event: "conversation_updated",
          ...convPayload(61, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.3,
          }),
        });
        expect((await mirrored(61)).status).toBe("resolved");
      });

      // A snapshot with no version buys nothing and can cost: the reconcile applies the WHOLE snapshot,
      // so a status click would carry back an assignee a webhook has since changed. Without a version
      // the console writes exactly the fields its own action meant to change.
      test("an unversioned snapshot does not let a status change touch the assignee", async () => {
        const T = 1_786_507_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(63, {
            status: "open",
            assignee: HUMAN,
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        // The GET answers without `updated_at` (a Chatwoot too old to serialize it) AND with a stale
        // assignee: unassigned, as it was before the human took it.
        const stub = stubClient({
          status: "resolved",
          assignee: null,
          lastActivityAt: T,
          updatedAt: null,
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(63),
          "resolved",
          { makeClient: stub.makeClient },
          appDb,
        );
        const row = await mirrored(63);
        expect(row.status).toBe("resolved");
        expect(row.assigneeType).toBe("User");
        expect(row.assigneeId).toBe(HUMAN.id);
      });

      // A row with no marks cannot be ordered by version, so the coarse activity comparison decides —
      // and `lastEventAt` may have been synthesized from receipt time, which makes it reject a
      // snapshot that is actually newer. Treating that no-op as success left the operator's action
      // absent from the mirror, and the runtime's ownership recheck reads this row.
      test("a read rejected by activity alone still leaves the console's write applied", async () => {
        const T = 1_786_508_000;
        // Mirrored WITHOUT a version (a Chatwoot too old to send one), so the row keeps null marks
        // and a lastEventAt this test then pushes ahead of the snapshot's activity time.
        await mirror({
          event: "conversation_updated",
          ...convPayload(64, { status: "pending", lastActivityAt: T + 30 }),
        });
        const stub = stubClient({
          status: "open",
          assignee: HUMAN,
          lastActivityAt: T,
          updatedAt: T + 50,
        });
        await handoffConversation(
          opCtx(),
          await rowIdOf(64),
          HUMAN.id,
          { makeClient: stub.makeClient },
          appDb,
        );
        const row = await mirrored(64);
        expect(row.assigneeType).toBe("User");
        expect(row.assigneeId).toBe(HUMAN.id);
        expect(row.status).toBe("open");
      });

      // The version is an improvement on the write, not a precondition for it: when the extra read
      // fails there is nothing to claim, and the console must still reflect what the operator did.
      test("a GET that fails still leaves the console's write applied", async () => {
        const T = 1_786_506_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(62, {
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const stub = stubClient(null);
        await handoffConversation(
          opCtx(),
          await rowIdOf(62),
          HUMAN.id,
          { makeClient: stub.makeClient },
          appDb,
        );
        const row = await mirrored(62);
        expect(row.assigneeType).toBe("User");
        expect(row.assigneeId).toBe(HUMAN.id);
        expect(row.status).toBe("open");
      });

      // Not over-fenced: a brand-new customer message genuinely reopens, and that reopen is
      // Chatwoot's own doing, not a stale snapshot.
      test("a new incoming message still reopens a conversation resolved in the console", async () => {
        const T = 1_786_503_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(43, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const stub = stubClient();
        await setConversationStatus(
          opCtx(),
          await rowIdOf(43),
          "resolved",
          { makeClient: stub.makeClient },
          appDb,
        );
        await mirror(
          messageEvent(43, "message_created", {
            messageId: 943,
            messageType: "incoming",
            status: "open",
            lastActivityAt: T + 5,
            updatedAt: T + 5.1,
          }),
        );
        expect((await mirrored(43)).status).toBe("open");
      });

      // Issue #188: this path resolves with the instance ADMIN token and deliberately does not
      // assign the operator, so status + assignee cannot tell it apart from the agent closing the
      // conversation itself. It is recorded instead.
      test("an operator resolving from the console is recorded as the console's doing", async () => {
        const T = 1_786_511_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(70, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        const stub = stubClient({
          status: "resolved",
          lastActivityAt: T,
          updatedAt: T + 1,
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(70),
          "resolved",
          { makeClient: stub.makeClient },
          appDb,
        );
        const row = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 70 },
          select: { status: true, resolvedBy: true },
        });
        expect(row.status).toBe("resolved");
        expect(row.resolvedBy).toBe("console");
      });

      // Review round 3 on #188/#199: the REST status route and MCP's `conversationStatus` both take
      // `resolved` for a conversation that already is, where Chatwoot's own call is a no-op. The
      // stamp used to be overwritten anyway, turning a genuine agent resolution into a `console`
      // one and removing it from the funnel.
      test("re-resolving from the console keeps the agent's origin", async () => {
        const T = 1_786_513_000;
        await mirror({
          event: "conversation_resolved",
          ...convPayload(72, {
            status: "resolved",
            lastActivityAt: T,
            updatedAt: T + 1,
          }),
        });
        await suDb.conversation.update({
          where: { id: await rowIdOf(72) },
          data: { resolvedBy: "agent" },
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(72),
          "resolved",
          {
            makeClient: stubClient({
              status: "resolved",
              lastActivityAt: T,
              updatedAt: T + 2,
            }).makeClient,
          },
          appDb,
        );
        const row = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 72 },
          select: { status: true, resolvedBy: true },
        });
        expect(row.status).toBe("resolved");
        expect(row.resolvedBy).toBe("agent");
      });

      // The other half of round 4, and the one first-writer-wins does NOT cover: an external close
      // (Chatwoot UI, automation rule, auto_resolve_after) leaves the origin NULL by design, so the
      // NULL predicate alone would happily let the operator's no-op claim it. What refuses is the
      // status the console loaded BEFORE its toggle.
      test("re-resolving a conversation closed outside our code records nothing", async () => {
        const T = 1_786_514_000;
        await mirror({
          event: "conversation_resolved",
          ...convPayload(73, {
            status: "resolved",
            lastActivityAt: T,
            updatedAt: T + 1,
          }),
        });
        expect(
          (
            await suDb.conversation.findFirstOrThrow({
              where: { tenantId, chatwootConversationId: 73 },
              select: { resolvedBy: true },
            })
          ).resolvedBy,
        ).toBeNull();
        await setConversationStatus(
          opCtx(),
          await rowIdOf(73),
          "resolved",
          {
            makeClient: stubClient({
              status: "resolved",
              lastActivityAt: T,
              updatedAt: T + 2,
            }).makeClient,
          },
          appDb,
        );
        const row = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 73 },
          select: { status: true, resolvedBy: true },
        });
        expect(row.status).toBe("resolved");
        expect(row.resolvedBy).toBeNull();
      });

      // Only a CLOSE is a closing. Moving a conversation to pending records nothing, or the column
      // would stop meaning "who closed this".
      test("sending a conversation to pending records no origin", async () => {
        const T = 1_786_515_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(74, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(74),
          "pending",
          {
            makeClient: stubClient({
              status: "pending",
              lastActivityAt: T,
              updatedAt: T + 1,
            }).makeClient,
          },
          appDb,
        );
        const row = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 74 },
          select: { status: true, resolvedBy: true },
        });
        expect(row.status).toBe("pending");
        expect(row.resolvedBy).toBeNull();
      });

      // Reopening from the console has to drop the stamp for the same reason the webhook mirror
      // does. This path is the UNVERSIONED fallback (the live read failed), which is exactly where a
      // clear that only lived in the versioned writer would be missed.
      test("reopening from the console clears the recorded origin", async () => {
        const T = 1_786_512_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(71, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(71),
          "resolved",
          {
            makeClient: stubClient({
              status: "resolved",
              lastActivityAt: T,
              updatedAt: T + 1,
            }).makeClient,
          },
          appDb,
        );
        expect(
          (
            await suDb.conversation.findFirstOrThrow({
              where: { tenantId, chatwootConversationId: 71 },
              select: { resolvedBy: true },
            })
          ).resolvedBy,
        ).toBe("console");
        // The live read throws, so mirrorConsoleWrite falls through to updateMirror with the
        // operator's own intent.
        await setConversationStatus(
          opCtx(),
          await rowIdOf(71),
          "open",
          {
            makeClient: async () =>
              ({
                toggleStatus: async () => ({}),
                getConversation: async () => {
                  throw new Error("live read down");
                },
              }) as never,
          },
          appDb,
        );
        const row = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 71 },
          select: { status: true, resolvedBy: true },
        });
        expect(row.status).toBe("open");
        expect(row.resolvedBy).toBeNull();
      });

      // The same reopen, but with the live read WORKING. A successful versioned reconcile returns
      // before the unversioned fallback runs, so a clear that lived only in the fallback never fired
      // here — and `clearsResolutionOrigin` keeps the stamp on purpose, because the row still shows
      // the pre-resolve status and the live read agrees, so neither says the conversation left
      // "resolved". Nothing in the ordering can see this: the operator's click is the only evidence
      // the resolution is over, which is why the clear belongs to the command.
      test("reopening from the console clears the origin on the versioned path too", async () => {
        const T = 1_786_516_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(76, {
            status: "open",
            lastActivityAt: T,
            updatedAt: T + 0.1,
          }),
        });
        // Our own close, stamped while the mirror still reads the pre-toggle "open" because its
        // webhook has not arrived. The floor is the row's status version at that moment.
        await suDb.conversation.updateMany({
          where: { tenantId, chatwootConversationId: 76 },
          data: { resolvedBy: "agent", resolvedByAt: T + 0.1 },
        });
        await setConversationStatus(
          opCtx(),
          await rowIdOf(76),
          "open",
          {
            makeClient: stubClient({
              status: "open",
              lastActivityAt: T + 2,
              updatedAt: T + 2,
            }).makeClient,
          },
          appDb,
        );
        const row = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: 76 },
          select: { status: true, resolvedBy: true, resolvedByAt: true },
        });
        expect(row.status).toBe("open");
        expect(row.resolvedBy).toBeNull();
        expect(row.resolvedByAt).toBeNull();
      });

      // The console renders the click optimistically off this publish and only reconciles when the
      // inbound webhook arrives, which may be seconds later or (on a conversation Chatwoot has
      // nothing more to say about) never. So a publish of the INTENT after a write that did not land
      // is the last word the operator gets, and it shows a state nobody holds.
      test("the optimistic publish announces the row as stored, not as clicked", async () => {
        const T = 1_786_509_000;
        // A webhook already carried this conversation past the version our own write can claim: it
        // was resolved and unassigned at T+90, and the GET after the handoff still answers with the
        // older T+50 snapshot.
        await mirror({
          event: "conversation_resolved",
          ...convPayload(66, {
            status: "resolved",
            lastActivityAt: T,
            updatedAt: T + 90,
          }),
        });
        const stub = stubClient({
          status: "open",
          assignee: HUMAN,
          lastActivityAt: T,
          updatedAt: T + 50,
        });
        const published: ServerEventLike[] = [];
        setPublisher((_topic, data) => {
          published.push(JSON.parse(data) as ServerEventLike);
        });
        try {
          await handoffConversation(
            opCtx(),
            await rowIdOf(66),
            HUMAN.id,
            { makeClient: stub.makeClient },
            appDb,
          );
        } finally {
          setPublisher(() => undefined);
        }
        const event = published.find((e) => e.type === "conversation");
        expect(event).toBeDefined();
        expect(event?.status).toBe("resolved");
        expect(event?.assigneeId).toBeNull();
        expect(event?.assigneeType).toBeNull();
        // And the row agrees with what was announced: the reconcile wrote nothing over the newer
        // version, and the unversioned fallback did not run behind its back.
        const row = await mirrored(66);
        expect(row.status).toBe("resolved");
        expect(row.assigneeId).toBeNull();
      });

      // Same rule, applied to the field the list SORTS by. The read after the write is the first
      // sight of a message the mirror had not processed yet, so this call is what advances the
      // stored recency — and a publish of the timestamp loaded before the action puts the row back
      // where it was in the ordering, against a mirror that already moved it.
      test("the optimistic publish carries the recency the reconcile stored", async () => {
        const T = 1_786_510_000;
        await mirror({
          event: "conversation_updated",
          ...convPayload(67, {
            status: "pending",
            lastActivityAt: T,
            updatedAt: T + 1,
          }),
        });
        // A customer message landed while the operator was clicking, and the GET is where we see it.
        const stub = stubClient({
          status: "open",
          assignee: HUMAN,
          lastActivityAt: T + 120,
          updatedAt: T + 2,
        });
        const published: ServerEventLike[] = [];
        setPublisher((_topic, data) => {
          published.push(JSON.parse(data) as ServerEventLike);
        });
        try {
          await handoffConversation(
            opCtx(),
            await rowIdOf(67),
            HUMAN.id,
            { makeClient: stub.makeClient },
            appDb,
          );
        } finally {
          setPublisher(() => undefined);
        }
        const row = await mirrored(67);
        expect(row.lastEventAt?.getTime()).toBe((T + 120) * 1000);
        const event = published.find((e) => e.type === "conversation");
        expect(event?.lastEventAt).toBe(
          new Date((T + 120) * 1000).toISOString(),
        );
      });
    });
  },
);
