import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { episodeOriginQuery } from "@/modules/channel-redirect/episode";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A stated null on a conversation that never had a pairing does not answer the pairing question (it
// would stamp the mark on every live conversation and close the recency fallback of
// `episodeOriginQuery`), but it is still the newest word: a delayed conversation_updated serialized
// before it, naming an older origin, must not install that pairing. Each test reads the row right
// after the delayed delivery, with nothing restating the null.

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
let instanceId = 0n;
const INBOX = 94;
const T = 1_786_800_000;

function conv(
  convId: number,
  updatedAt: number | undefined,
  origin: number | null,
) {
  return {
    id: convId,
    inbox_id: INBOX,
    status: "open",
    contact_inbox: { id: 78_000 + convId },
    meta: {
      assignee_type: null,
      assignee: null,
      sender: { id: 650 + convId, name: "Lead" },
    },
    channel: "Channel::WebWidget",
    last_activity_at: T,
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
    redirect_origin_display_id: origin,
  };
}

function conversationUpdated(
  convId: number,
  updatedAt: number | undefined,
  origin: number | null,
) {
  return { event: "conversation_updated", ...conv(convId, updatedAt, origin) };
}

function message(
  convId: number,
  messageId: number,
  updatedAt: number | undefined,
  origin: number | null,
) {
  return {
    event: "message_created",
    id: messageId,
    content: "oi",
    message_type: "incoming",
    private: false,
    conversation: conv(convId, updatedAt, origin),
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function pairing(convId: number) {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      redirectOriginDisplayId: true,
      chatwootRedirectOriginAt: true,
      contactId: true,
    },
  });
  return {
    origin: row.redirectOriginDisplayId,
    by:
      episodeOriginQuery({
        tenantId,
        instanceId,
        entryInboxId: 31,
        widget: {
          redirectOriginDisplayId: row.redirectOriginDisplayId,
          chatwootRedirectOriginAt: row.chatwootRedirectOriginAt,
          contactId: row.contactId,
        },
      })?.by ?? null,
  };
}

describe.skipIf(!dbUp)(
  "mirror: a stated null orders a delayed older pairing",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: {
          name: "MIRROR-REDIRECT-NULL",
          slug: `mirror-redirect-null-${process.pid}`,
        },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 14,
        baseUrl: "https://redirect-null.chat.example.com",
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

    test("a delayed conversation_updated naming an older origin does not pair a row that was told there is none", async () => {
      await mirror(message(1, 9500, T + 0.2, null));
      await mirror(conversationUpdated(1, T + 0.15, 77));
      expect(await pairing(1)).toEqual({ origin: null, by: "recency" });
    });

    test("the same, when the null reached a row that already existed", async () => {
      await mirror(message(2, 9600, T + 0.1, null));
      await mirror(message(2, 9601, T + 0.2, null));
      await mirror(conversationUpdated(2, T + 0.15, 77));
      expect(await pairing(2)).toEqual({ origin: null, by: "recency" });
    });

    test("a null carried by a payload behind on activity still dates the pairing", async () => {
      await mirror({
        ...message(6, 9950, T + 0.3, null),
        conversation: { ...conv(6, T + 0.3, null), last_activity_at: T + 10 },
      });
      await mirror(message(6, 9951, T + 0.4, null));
      await mirror(conversationUpdated(6, T + 0.35, 77));
      expect(await pairing(6)).toEqual({ origin: null, by: "recency" });
    });

    test("an origin newer than the null still installs", async () => {
      await mirror(message(3, 9700, T + 0.2, null));
      await mirror(conversationUpdated(3, T + 0.3, 77));
      expect(await pairing(3)).toEqual({ origin: 77, by: "stored" });
    });

    test("the null alone leaves the recency fallback open", async () => {
      await mirror(message(4, 9800, T + 0.2, null));
      await mirror(message(4, 9801, T + 0.3, null));
      expect(await pairing(4)).toEqual({ origin: null, by: "recency" });
    });

    test("without versions the last writer still wins", async () => {
      await mirror(message(5, 9900, undefined, null));
      await mirror(conversationUpdated(5, undefined, 77));
      expect(await pairing(5)).toEqual({ origin: 77, by: "stored" });
    });
  },
);
