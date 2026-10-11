import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// A delayed snapshot from the same `last_activity_at` second must not rewrite the conversation's
// labels, attribute bags, card or type with older values, and the mirror has to refuse it on its own:
// each test reads the row right after the delayed delivery, with nothing re-applying the newer state.
// The sequences are the fork's (4.18): a label or attribute write moves `updated_at` and leaves
// `last_activity_at` alone, and editing the linked card moves only the card's own `updated_at`.

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
  labels?: string[];
  customAttributes?: Record<string, unknown>;
  groupType?: "group" | "individual";
  card?: { id: number; updatedAt: string; attrs: Record<string, unknown> };
}

function conversation(convId: number, s: Snapshot) {
  return {
    id: convId,
    inbox_id: 93,
    status: "pending",
    contact_inbox: { id: 89_000 + convId },
    meta: {
      assignee_type: "AgentBot",
      assignee: null,
      sender: { id: 800 + convId, name: "Lead" },
    },
    channel: "Channel::Api",
    last_activity_at: T,
    ...(s.updatedAt !== undefined ? { updated_at: s.updatedAt } : {}),
    ...(s.labels !== undefined ? { labels: s.labels } : {}),
    ...(s.customAttributes !== undefined
      ? { custom_attributes: s.customAttributes }
      : {}),
    ...(s.groupType !== undefined ? { group_type: s.groupType } : {}),
    ...(s.card
      ? {
          kanban_task: {
            id: s.card.id,
            updated_at: s.card.updatedAt,
            custom_attributes: s.card.attrs,
          },
        }
      : {}),
  };
}

// A bot reply and its updates: the reply's own snapshot, then the conversation as each later
// delivery of the same message serializes it.
function reply(event: string, convId: number, s: Snapshot) {
  return {
    event,
    id: 50_000 + convId,
    message_type: "outgoing",
    content: "resposta do bot",
    private: false,
    inbox: { id: 93, name: "facts-order" },
    conversation: conversation(convId, s),
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function row(convId: number) {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      labels: true,
      customAttributes: true,
      kanbanAttributes: true,
      conversationType: true,
    },
  });
}

describe.skipIf(!dbUp)(
  "mirror: facts ordered by the conversation's version",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: {
          name: "MIRROR-FACTS-ORDER",
          slug: `mirror-facts-order-${process.pid}`,
        },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 13,
        baseUrl: "https://facts-order.chat.example.com",
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

    test("the reply's delayed first snapshot does not bring back the labels it predates", async () => {
      const first = { updatedAt: T + 0.972487, labels: ["x"] };
      await mirror(reply("message_created", 1, first));
      await mirror(
        reply("message_updated", 1, {
          updatedAt: T + 2.230159,
          labels: ["x", "y"],
        }),
      );
      expect((await row(1)).labels).toEqual(["x", "y"]);
      await mirror(reply("message_created", 1, first));
      expect((await row(1)).labels).toEqual(["x", "y"]);
    });

    test("nor the conversation's custom attributes, nor its type", async () => {
      const first = {
        updatedAt: T + 0.1,
        customAttributes: { etapa: "a" },
        groupType: "individual" as const,
      };
      await mirror(reply("message_created", 2, first));
      await mirror(
        reply("message_updated", 2, {
          updatedAt: T + 0.2,
          customAttributes: { etapa: "b" },
          groupType: "group",
        }),
      );
      await mirror(reply("message_created", 2, first));
      const r = await row(2);
      expect(r.customAttributes).toEqual({ etapa: "b" });
      expect(r.conversationType).toBe("group");
    });

    test("a cleared label list is not refilled by the snapshot before the clear", async () => {
      const first = { updatedAt: T + 0.1, labels: ["vip"] };
      await mirror(reply("message_created", 3, first));
      await mirror(
        reply("message_updated", 3, { updatedAt: T + 0.2, labels: [] }),
      );
      await mirror(reply("message_created", 3, first));
      expect((await row(3)).labels).toEqual([]);
    });

    test("an older state of the linked card at the same conversation version is refused", async () => {
      const version = T + 2.29108;
      const before = {
        updatedAt: version,
        card: {
          id: 1361,
          updatedAt: "2026-10-10T22:42:23.270Z",
          attrs: { k: "a" },
        },
      };
      await mirror(reply("message_updated", 4, before));
      await mirror(
        reply("message_updated", 4, {
          updatedAt: version,
          card: {
            id: 1361,
            updatedAt: "2026-10-10T22:42:26.077Z",
            attrs: { k: "b" },
          },
        }),
      );
      expect((await row(4)).kanbanAttributes).toEqual({ k: "b" });
      await mirror(reply("message_updated", 4, before));
      expect((await row(4)).kanbanAttributes).toEqual({ k: "b" });
    });

    test("another card linked at the same conversation version is written, even with an older clock", async () => {
      const version = T + 2.29108;
      await mirror(
        reply("message_updated", 5, {
          updatedAt: version,
          card: {
            id: 1361,
            updatedAt: "2026-10-10T22:42:26.077Z",
            attrs: { k: "b" },
          },
        }),
      );
      await mirror(
        reply("message_updated", 5, {
          updatedAt: version,
          card: {
            id: 1362,
            updatedAt: "2026-10-10T22:42:23.620Z",
            attrs: { k: "z" },
          },
        }),
      );
      expect((await row(5)).kanbanAttributes).toEqual({ k: "z" });
    });

    test("a row born from the newer snapshot refuses the older one that arrives after it", async () => {
      await mirror(
        reply("message_updated", 8, { updatedAt: T + 0.2, labels: ["x", "y"] }),
      );
      await mirror(
        reply("message_created", 8, { updatedAt: T + 0.1, labels: ["x"] }),
      );
      expect((await row(8)).labels).toEqual(["x", "y"]);
    });

    test("a newer payload that omits the labels does not shut out an older one that carries them", async () => {
      const degraded = reply("message_updated", 9, {
        updatedAt: T + 0.2,
        customAttributes: { etapa: "b" },
      });
      await mirror(degraded);
      await mirror(
        reply("message_created", 9, {
          updatedAt: T + 0.1,
          labels: ["vip"],
          customAttributes: { etapa: "a" },
        }),
      );
      const r = await row(9);
      expect(r.labels).toEqual(["vip"]);
      expect(r.customAttributes).toEqual({ etapa: "b" });
    });

    test("the newer snapshot arriving last still applies, in the same second", async () => {
      await mirror(
        reply("message_created", 6, { updatedAt: T + 0.1, labels: ["a"] }),
      );
      await mirror(
        reply("message_updated", 6, { updatedAt: T + 0.2, labels: ["a", "b"] }),
      );
      expect((await row(6)).labels).toEqual(["a", "b"]);
    });

    test("without versions (Chatwoot < 4.0.2) a tie still goes to the last writer", async () => {
      await mirror(reply("message_created", 7, { labels: ["old"] }));
      await mirror(reply("message_updated", 7, { labels: ["new"] }));
      await mirror(reply("message_created", 7, { labels: ["old"] }));
      expect((await row(7)).labels).toEqual(["old"]);
    });
  },
);
