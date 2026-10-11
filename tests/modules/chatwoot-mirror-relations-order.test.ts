import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// A delayed snapshot from the same `last_activity_at` second must not write back the contact, contact
// inbox or inbox a newer one moved, and a row a degraded event created without them must still be
// filled. Each test reads the row right after the delayed delivery, with nothing re-applying the
// newer state. Moving a relation in the fork (a contact merge, a WhatsApp consolidation) is an
// `update!` on the conversation: `updated_at` moves and `last_activity_at` does not.

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

const T = 1_791_672_119;

interface Snapshot {
  updatedAt?: number;
  activityAt?: number;
  // Absent: the degraded shape, with no `meta` and no contact inbox.
  contact?: number;
  contactInbox?: number;
  inbox?: number;
  recovery?: boolean;
}

function message(event: string, convId: number, s: Snapshot) {
  const inbox = s.inbox ?? 93;
  return {
    event,
    id: 60_000 + convId,
    message_type: "incoming",
    content: "oi",
    private: false,
    inbox: { id: inbox, name: `relations-order ${inbox}` },
    conversation: {
      id: convId,
      inbox_id: inbox,
      status: "pending",
      channel: "Channel::Api",
      last_activity_at: s.activityAt ?? T,
      ...(s.updatedAt !== undefined ? { updated_at: s.updatedAt } : {}),
      ...(s.contactInbox !== undefined
        ? { contact_inbox: { id: s.contactInbox } }
        : {}),
      ...(s.contact !== undefined
        ? {
            meta: {
              assignee_type: "AgentBot",
              assignee: null,
              sender: { id: s.contact, name: "Lead" },
            },
          }
        : {}),
      ...(s.recovery ? { fazer_facts_on_create_only: true } : {}),
    },
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

// The row's relations in the source's ids, so a test reads what Chatwoot would.
async function relations(convId: number) {
  const r = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      contactInboxId: true,
      contact: { select: { chatwootContactId: true } },
      inbox: { select: { chatwootInboxId: true } },
    },
  });
  return {
    contact: r.contact?.chatwootContactId ?? null,
    contactInbox: r.contactInboxId,
    inbox: r.inbox?.chatwootInboxId ?? null,
  };
}

describe.skipIf(!dbUp)(
  "mirror: relations ordered by the conversation's version",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: {
          name: "MIRROR-RELATIONS-ORDER",
          slug: `mirror-relations-order-${process.pid}`,
        },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 13,
        baseUrl: "https://relations-order.chat.example.com",
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

    test("the snapshot from before a contact merge does not bring the old contact back", async () => {
      const beforeMerge = {
        updatedAt: T + 0.2,
        contact: 500,
        contactInbox: 7001,
        inbox: 93,
      };
      await mirror(message("message_created", 1, beforeMerge));
      await mirror(
        message("message_updated", 1, {
          updatedAt: T + 0.8,
          contact: 501,
          contactInbox: 7002,
          inbox: 94,
        }),
      );
      await mirror(message("message_created", 1, beforeMerge));
      expect(await relations(1)).toEqual({
        contact: 501,
        contactInbox: 7002,
        inbox: 94,
      });
    });

    test("a row a newer degraded event created is filled by the older complete one", async () => {
      await mirror(message("message_updated", 2, { updatedAt: T + 0.7 }));
      expect(await relations(2)).toMatchObject({
        contact: null,
        contactInbox: null,
      });
      await mirror(
        message("message_created", 2, {
          updatedAt: T + 0.3,
          contact: 520,
          contactInbox: 7020,
        }),
      );
      expect(await relations(2)).toMatchObject({
        contact: 520,
        contactInbox: 7020,
      });
    });

    test("...also when the complete one is a second older, which leaves the rest of the row alone", async () => {
      await mirror(message("message_updated", 9, { updatedAt: T + 0.7 }));
      await mirror(
        message("message_created", 9, {
          updatedAt: T - 0.6,
          activityAt: T - 1,
          contact: 590,
          contactInbox: 7090,
        }),
      );
      expect(await relations(9)).toMatchObject({
        contact: 590,
        contactInbox: 7090,
      });
    });

    test("...and the fill keeps a still older snapshot out", async () => {
      await mirror(message("message_updated", 3, { updatedAt: T + 0.7 }));
      await mirror(
        message("message_created", 3, {
          updatedAt: T + 0.3,
          contact: 531,
          contactInbox: 7031,
        }),
      );
      await mirror(
        message("message_created", 3, {
          updatedAt: T + 0.1,
          contact: 530,
          contactInbox: 7030,
        }),
      );
      expect(await relations(3)).toMatchObject({
        contact: 531,
        contactInbox: 7031,
      });
    });

    test("a degraded event between them does not shut out a relation newer than the last one named", async () => {
      await mirror(
        message("message_created", 4, {
          updatedAt: T + 0.2,
          contact: 541,
          contactInbox: 7041,
        }),
      );
      await mirror(message("message_updated", 4, { updatedAt: T + 0.8 }));
      await mirror(
        message("message_updated", 4, {
          updatedAt: T + 0.5,
          contact: 542,
          contactInbox: 7042,
        }),
      );
      expect(await relations(4)).toMatchObject({
        contact: 542,
        contactInbox: 7042,
      });
    });

    test("a recovery's inherited pairing does not refuse the pairing a webhook names after it", async () => {
      await mirror(
        message("message_created", 5, {
          updatedAt: T + 0.6,
          contactInbox: 7050,
          recovery: true,
        }),
      );
      await mirror(
        message("message_updated", 5, {
          updatedAt: T + 0.4,
          contact: 551,
          contactInbox: 7051,
        }),
      );
      expect((await relations(5)).contactInbox).toBe(7051);
    });

    test("a row born from the post-merge snapshot refuses the pre-merge one that arrives after it", async () => {
      await mirror(
        message("message_updated", 7, {
          updatedAt: T + 0.8,
          contact: 571,
          contactInbox: 7071,
        }),
      );
      await mirror(
        message("message_created", 7, {
          updatedAt: T + 0.2,
          contact: 570,
          contactInbox: 7070,
        }),
      );
      expect(await relations(7)).toMatchObject({
        contact: 571,
        contactInbox: 7071,
      });
    });

    test("a recovery's inherited pairing never replaces the one a webhook stored", async () => {
      await mirror(
        message("message_created", 8, {
          updatedAt: T + 0.2,
          contact: 580,
          contactInbox: 7080,
        }),
      );
      await mirror(
        message("message_created", 8, {
          updatedAt: T + 0.9,
          contactInbox: 7089,
          recovery: true,
        }),
      );
      expect((await relations(8)).contactInbox).toBe(7080);
    });

    test("without versions (Chatwoot < 4.0.2) a tie still goes to the last writer", async () => {
      await mirror(
        message("message_created", 6, { contact: 560, contactInbox: 7060 }),
      );
      await mirror(
        message("message_updated", 6, { contact: 561, contactInbox: 7061 }),
      );
      await mirror(
        message("message_created", 6, { contact: 560, contactInbox: 7060 }),
      );
      expect(await relations(6)).toMatchObject({
        contact: 560,
        contactInbox: 7060,
      });
    });
  },
);
