import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// Two routes deliver the same first message of a new contact milliseconds apart (an observer beside
// a responder, issue #476), and the mirror's contact upsert — a select then an insert, ahead of the
// per-conversation lock — loses the insert on one of them. The transaction is aborted by then, so
// the recovery is the whole mirror run again, once. Reproduced here deterministically by making the
// first upsert lose the way the database makes it lose.

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

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`tenant_id`,`chatwoot_instance_id`,`chatwoot_contact_id`)",
    { code: "P2002", clientVersion: "test" },
  );
}

// An app client whose contact upsert loses `losses` times before it works — the race, on demand.
function losingClient(losses: number): {
  db: PrismaClient;
  upserts: () => number;
} {
  let left = losses;
  let count = 0;
  const db = appDb.$extends({
    query: {
      contact: {
        async upsert({ args, query }) {
          count += 1;
          if (left > 0) {
            left -= 1;
            throw uniqueViolation();
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
  return { db, upserts: () => count };
}

function messageEvent(convId: number, messageId: number, contactId: number) {
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: messageId,
    private: false,
    content: "oi, quero cancelar",
    message_type: "incoming",
    sender: { id: contactId, name: "Cliente", type: "contact" },
    conversation: {
      id: convId,
      inbox_id: 7,
      status: "open",
      contact_inbox: { id: 7_000 + convId },
      meta: { assignee: null, sender: { id: contactId, name: "Cliente" } },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: Date.now() / 1000,
    },
  });
  if (!n) throw new Error("payload did not normalize");
  return n;
}

describe.skipIf(!dbUp)(
  "the mirror under two routes racing on a new contact",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "MIRROR-RACE", slug: `mirror-race-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 71,
        baseUrl: "https://chat.mirror-race.example",
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

    test("a lost insert runs the mirror again, and the delivery lands on the row the other route made", async () => {
      // The winner: the row exists after this.
      await mirrorChatwootEvent(
        tenantId,
        instanceId,
        messageEvent(31, 3101, 501),
        appDb,
      );
      const loser = losingClient(1);
      const r = await mirrorChatwootEvent(
        tenantId,
        instanceId,
        messageEvent(31, 3102, 501),
        loser.db,
      );
      expect(r.conversationRowId).not.toBeNull();
      expect(loser.upserts()).toBe(2);
      expect(
        await suDb.contact.count({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootContactId: 501,
          },
        }),
      ).toBe(1);
      expect(
        await suDb.conversation.count({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: 31,
          },
        }),
      ).toBe(1);
    });

    test("a second loss is the caller's failure, not an endless retry", async () => {
      const loser = losingClient(2);
      await expect(
        mirrorChatwootEvent(
          tenantId,
          instanceId,
          messageEvent(32, 3201, 502),
          loser.db,
        ),
      ).rejects.toMatchObject({ code: "P2002" });
      expect(loser.upserts()).toBe(2);
    });

    test("any other failure is not retried", async () => {
      let count = 0;
      const db = appDb.$extends({
        query: {
          contact: {
            async upsert() {
              count += 1;
              throw new Error("boom");
            },
          },
        },
      }) as unknown as PrismaClient;
      await expect(
        mirrorChatwootEvent(
          tenantId,
          instanceId,
          messageEvent(33, 3301, 503),
          db,
        ),
      ).rejects.toThrow("boom");
      expect(count).toBe(1);
    });
  },
);
