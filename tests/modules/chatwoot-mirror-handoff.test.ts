import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #61. After a handoff, Chatwoot delivers a burst of conversation_* events and then a
// message_updated tail whose embedded conversation snapshot is frozen at MESSAGE CREATION time —
// and handoff_to_human posts the customer message BEFORE it changes the status, so that snapshot is
// always the pre-handoff one. Whether the mirror survived came down to luck: `last_activity_at` has
// one-second resolution and does not advance on a status or assignee change, so when the whole burst
// landed inside one second the monotonic guard could not order it and the stale tail won, rewriting
// the row to pending and CLEARING a real human assignee. Two conversations twenty minutes apart, the
// same code path and the same event sequence, ended differently.

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
  lastActivityAt: number;
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

// The burst as delivered, in order. `tail` is when the frozen message_updated pair carries its
// (pre-handoff) snapshot: equal to the conversation events, or one second behind them.
async function handoffBurst(convId: number, t: number, tail: number) {
  await mirror({
    event: "conversation_updated",
    ...convPayload(convId, { status: "pending", lastActivityAt: t }),
  });
  for (const event of [
    "conversation_updated",
    "conversation_opened",
    "conversation_status_changed",
  ] as const) {
    await mirror({
      event,
      ...convPayload(convId, { status: "open", lastActivityAt: t }),
    });
  }
  await mirror({
    event: "conversation_updated",
    ...convPayload(convId, {
      status: "open",
      lastActivityAt: t,
      assignee: { id: 3, name: "Atendente Humana" },
    }),
  });
  for (let i = 0; i < 2; i++) {
    await mirror(
      messageEvent(convId, "message_updated", {
        messageId: 900 + convId,
        status: "pending",
        lastActivityAt: tail,
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
    });

    afterAll(async () => {
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await su?.$disconnect();
      await app?.$disconnect();
    });

    // The conversation from the report that broke: every event, stale tail included, on 1786483614.
    test("the whole burst inside one second still leaves the human owning it", async () => {
      await handoffBurst(6, 1_786_483_614, 1_786_483_614);
      const row = await mirrored(6);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // The conversation that survived on luck: its tail was one second behind, so the monotonic guard
    // discarded it. It must keep working for the same reason it worked before, not by accident.
    test("a tail one second behind is still discarded", async () => {
      await handoffBurst(9, 1_786_484_801, 1_786_484_800);
      const row = await mirrored(9);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
      expect(row.assigneeId).toBe(3);
    });

    // Chatwoot's ReopenService really does reopen on a new customer message, so THAT snapshot's
    // status is a fact about the conversation and must keep being mirrored (guardrail from the
    // resolved-conversation follow-up chain).
    test("a brand-new incoming message still reopens a resolved conversation", async () => {
      const T = 1_786_490_000;
      await mirror({
        event: "conversation_resolved",
        ...convPayload(12, { status: "resolved", lastActivityAt: T }),
      });
      await mirror(
        messageEvent(12, "message_created", {
          messageId: 950,
          messageType: "incoming",
          status: "open",
          lastActivityAt: T + 60,
        }),
      );
      expect((await mirrored(12)).status).toBe("open");
    });

    // An outgoing message_created carries the same frozen copy with no reopen semantics behind it.
    test("an outgoing message never moves the conversation's own state", async () => {
      const T = 1_786_491_000;
      await mirror({
        event: "conversation_updated",
        ...convPayload(15, {
          status: "open",
          lastActivityAt: T,
          assignee: { id: 3, name: "Atendente Humana" },
        }),
      });
      await mirror(
        messageEvent(15, "message_created", {
          messageId: 960,
          status: "pending",
          lastActivityAt: T,
        }),
      );
      const row = await mirrored(15);
      expect(row.status).toBe("open");
      expect(row.assigneeType).toBe("User");
    });
  },
);
