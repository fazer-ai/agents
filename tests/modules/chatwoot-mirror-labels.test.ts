import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE CONVERSATION'S LABELS, MIRRORED. Every conversation payload carries the whole
// label list (`push_data.labels`), so the mirror assigns it as it does the attribute bags: whole, by
// recency, and only when the payload carries it. The dashboard's outcome-by-label view reads this.

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

function convEvent(
  event: string,
  convId: number,
  over: { lastActivityAt: number; updatedAt?: number; labels?: unknown },
) {
  return {
    event,
    id: convId,
    inbox_id: 92,
    status: "open",
    contact_inbox: { id: 88_000 + convId },
    meta: {
      assignee_type: null,
      assignee: null,
      sender: {
        id: 700 + convId,
        name: "Lead",
        phone_number: "+5511977776666",
      },
    },
    channel: "Channel::Whatsapp",
    last_activity_at: over.lastActivityAt,
    ...(over.updatedAt !== undefined ? { updated_at: over.updatedAt } : {}),
    ...(over.labels !== undefined ? { labels: over.labels } : {}),
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function stored(convId: number): Promise<string[]> {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { labels: true },
  });
  return row.labels;
}

describe.skipIf(!dbUp)("mirror: the conversation's labels", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MIRROR-LABELS", slug: `mirror-labels-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: "https://labels.chat.example.com",
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

  const T = 1_786_600_000;

  test("the list a conversation is born with is stored", async () => {
    await mirror(
      convEvent("conversation_created", 1, {
        lastActivityAt: T,
        updatedAt: T,
        labels: ["cobranca", "pix"],
      }),
    );
    expect(await stored(1)).toEqual(["cobranca", "pix"]);
  });

  test("a later list replaces it whole, an empty one clears it", async () => {
    await mirror(
      convEvent("conversation_updated", 1, {
        lastActivityAt: T,
        updatedAt: T + 1,
        labels: ["cancelamento"],
      }),
    );
    expect(await stored(1)).toEqual(["cancelamento"]);
    await mirror(
      convEvent("conversation_updated", 1, {
        lastActivityAt: T,
        updatedAt: T + 2,
        labels: [],
      }),
    );
    expect(await stored(1)).toEqual([]);
  });

  test("a payload that carries no list keeps the stored one", async () => {
    await mirror(
      convEvent("conversation_created", 2, {
        lastActivityAt: T,
        updatedAt: T,
        labels: ["vip"],
      }),
    );
    await mirror(
      convEvent("conversation_updated", 2, {
        lastActivityAt: T + 5,
        updatedAt: T + 5,
      }),
    );
    expect(await stored(2)).toEqual(["vip"]);
    // Not a list: says nothing either.
    await mirror(
      convEvent("conversation_updated", 2, {
        lastActivityAt: T + 6,
        updatedAt: T + 6,
        labels: "vip",
      }),
    );
    expect(await stored(2)).toEqual(["vip"]);
  });

  test("an older delivery does not bring back the labels a newer one replaced", async () => {
    await mirror(
      convEvent("conversation_created", 3, {
        lastActivityAt: T + 10,
        updatedAt: T + 10,
        labels: ["novo"],
      }),
    );
    await mirror(
      convEvent("conversation_updated", 3, {
        lastActivityAt: T + 1,
        updatedAt: T + 1,
        labels: ["antigo"],
      }),
    );
    expect(await stored(3)).toEqual(["novo"]);
  });

  test("a newer version serialized from an older activity keeps the stored list, as the bags do", async () => {
    await mirror(
      convEvent("conversation_created", 4, {
        lastActivityAt: T + 20,
        updatedAt: T + 20,
        labels: ["atual"],
      }),
    );
    await mirror(
      convEvent("conversation_updated", 4, {
        lastActivityAt: T + 1,
        updatedAt: T + 21,
        labels: ["defasado"],
      }),
    );
    expect(await stored(4)).toEqual(["atual"]);
  });

  test("a recovery's create-only facts land on the row they create and never update one", async () => {
    // A recovery reads these before it mirrors; a webhook that created the row since is newer.
    await mirror({
      ...convEvent("conversation_updated", 5, {
        lastActivityAt: T + 10,
        updatedAt: T + 10,
        labels: ["lido-pela-recuperacao"],
      }),
      fazer_facts_on_create_only: true,
    });
    expect(await stored(5)).toEqual(["lido-pela-recuperacao"]);
    await mirror(
      convEvent("conversation_updated", 6, {
        lastActivityAt: T + 10,
        updatedAt: T + 10,
        labels: ["do-webhook"],
      }),
    );
    await mirror({
      ...convEvent("conversation_updated", 6, {
        lastActivityAt: T + 30,
        updatedAt: T + 30,
        labels: ["lido-pela-recuperacao"],
      }),
      fazer_facts_on_create_only: true,
    });
    expect(await stored(6)).toEqual(["do-webhook"]);
  });

  test("a recovery's row is stamped no older than the live reading, so a delayed event loses", async () => {
    await mirror({
      ...convEvent("conversation_updated", 7, {
        lastActivityAt: T + 10,
        labels: ["lido-ao-vivo"],
      }),
      fazer_facts_on_create_only: true,
      fazer_create_activity_at: T + 50,
    });
    // Newer than the stranded message, older than the live reading the facts came from.
    await mirror(
      convEvent("conversation_updated", 7, {
        lastActivityAt: T + 30,
        labels: ["defasado"],
      }),
    );
    expect(await stored(7)).toEqual(["lido-ao-vivo"]);
  });

  test("a recovery's contact identity is positioned at the live reading, so a delayed event loses", async () => {
    const live = convEvent("conversation_updated", 8, {
      lastActivityAt: T + 10,
    });
    await mirror({
      ...live,
      meta: {
        ...live.meta,
        sender: { id: 708, name: "Lead", phone_number: "+5511900000001" },
      },
      fazer_facts_on_create_only: true,
      fazer_create_activity_at: T + 50,
    });
    // Newer than the stranded message, older than the live reading the identity came from.
    const delayed = convEvent("conversation_updated", 8, {
      lastActivityAt: T + 30,
    });
    await mirror({
      ...delayed,
      meta: {
        ...delayed.meta,
        sender: { id: 708, name: "Lead", phone_number: "+5511900000002" },
      },
    });
    const contact = await suDb.contact.findFirstOrThrow({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: 708,
      },
      select: { phone: true },
    });
    expect(contact.phone).toBe("+5511900000001");
  });
});
