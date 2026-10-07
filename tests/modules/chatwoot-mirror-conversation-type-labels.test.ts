import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// The fork's conversation block (`Conversations::EventDataPresenter#push_data`) carries `group_type`
// and `labels` on every message and conversation event. The contact gate decides on both, and three
// of its callers run with no payload in hand (the debounce flush, a nudge, a re-engagement), so the
// mirror keeps them on the conversation row.

interface ConvOver {
  lastActivityAt: number;
  groupType?: unknown;
  labels?: unknown;
}

function convPayload(convId: number, over: ConvOver) {
  return {
    id: convId,
    inbox_id: 93,
    status: "open",
    contact_inbox: { id: 93_000 + convId },
    meta: {
      assignee_type: null,
      assignee: null,
      sender: { id: 930 + convId, name: "Grupo", identifier: `${convId}@g.us` },
    },
    channel: "Channel::Whatsapp",
    last_activity_at: over.lastActivityAt,
    ...(over.groupType !== undefined ? { group_type: over.groupType } : {}),
    ...(over.labels !== undefined ? { labels: over.labels } : {}),
  };
}

function message(convId: number, messageId: number, over: ConvOver) {
  return {
    event: "message_created",
    id: messageId,
    content: "oi",
    message_type: "incoming",
    private: false,
    conversation: convPayload(convId, over),
  };
}

describe("normalizing the conversation's type and labels", () => {
  test("both are read from the conversation block", () => {
    const n = normalizeChatwootEvent(
      message(1, 1, {
        lastActivityAt: 1,
        groupType: "group",
        labels: ["Suporte", "vip"],
      }),
    );
    expect(n?.conversationType).toBe("group");
    expect(n?.labels).toEqual(["suporte", "vip"]);
  });

  test("an absent key says nothing, and an empty list is a clear", () => {
    const absent = normalizeChatwootEvent(message(1, 1, { lastActivityAt: 1 }));
    expect(absent?.conversationType).toBeUndefined();
    expect(absent?.labels).toBeUndefined();
    const cleared = normalizeChatwootEvent(
      message(1, 1, { lastActivityAt: 1, labels: [] }),
    );
    expect(cleared?.labels).toEqual([]);
  });

  test("a value that is not one of the two types, or a list that is not one of strings, says nothing", () => {
    for (const groupType of ["channel", 1, null, "Group"]) {
      expect(
        normalizeChatwootEvent(message(1, 1, { lastActivityAt: 1, groupType }))
          ?.conversationType,
      ).toBeUndefined();
    }
    for (const labels of ["vip", { 0: "vip" }, null, [1, "vip"]]) {
      expect(
        normalizeChatwootEvent(message(1, 1, { lastActivityAt: 1, labels }))
          ?.labels,
      ).toBeUndefined();
    }
  });

  test("a conversation event carries them at the top level", () => {
    const n = normalizeChatwootEvent({
      event: "conversation_updated",
      ...convPayload(2, {
        lastActivityAt: 1,
        groupType: "individual",
        labels: ["a"],
      }),
    });
    expect(n?.conversationType).toBe("individual");
    expect(n?.labels).toEqual(["a"]);
  });
});

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

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function stored(convId: number) {
  return suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { conversationType: true, labels: true },
  });
}

describe.skipIf(!dbUp)("mirror: the conversation's type and labels", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "MIRROR-CONV-SCOPE",
        slug: `mirror-conv-scope-${process.pid}`,
      },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 93,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a new row takes both, and a later payload replaces the label list wholesale", async () => {
    const T = 1_786_600_000;
    await mirror(
      message(50, 9001, {
        lastActivityAt: T,
        groupType: "group",
        labels: ["suporte"],
      }),
    );
    expect(await stored(50)).toEqual({
      conversationType: "group",
      labels: ["suporte"],
    });
    await mirror(
      message(50, 9002, {
        lastActivityAt: T + 5,
        groupType: "group",
        labels: ["vip", "triagem"],
      }),
    );
    expect(await stored(50)).toEqual({
      conversationType: "group",
      labels: ["vip", "triagem"],
    });
  });

  test("a payload without the keys leaves both alone, and an empty list clears the labels", async () => {
    const T = 1_786_610_000;
    await mirror(
      message(51, 9101, {
        lastActivityAt: T,
        groupType: "group",
        labels: ["suporte"],
      }),
    );
    await mirror(message(51, 9102, { lastActivityAt: T + 5 }));
    expect(await stored(51)).toEqual({
      conversationType: "group",
      labels: ["suporte"],
    });
    await mirror(message(51, 9103, { lastActivityAt: T + 9, labels: [] }));
    expect(await stored(51)).toEqual({
      conversationType: "group",
      labels: [],
    });
  });

  test("a stale delivery does not walk the labels back", async () => {
    const T = 1_786_620_000;
    await mirror(
      message(52, 9201, { lastActivityAt: T + 10, labels: ["novo"] }),
    );
    await mirror(message(52, 9200, { lastActivityAt: T, labels: ["velho"] }));
    expect((await stored(52)).labels).toEqual(["novo"]);
  });

  // A conversation event is ordered by its version, so it applies even when its `last_activity_at` is
  // behind the row; the label list it carries is then a snapshot older than the message already
  // mirrored, and must not replace it.
  test("a conversation event serialized before a newer message keeps the message's labels", async () => {
    const T = 1_786_640_000;
    await mirror(
      message(54, 9401, { lastActivityAt: T + 10, labels: ["novo"] }),
    );
    await mirror({
      event: "conversation_updated",
      ...convPayload(54, { lastActivityAt: T + 5, labels: ["velho"] }),
      updated_at: T + 5.5,
    });
    expect((await stored(54)).labels).toEqual(["novo"]);
  });

  test("an existing row learns its type when a payload first states it", async () => {
    const T = 1_786_650_000;
    await mirror(message(55, 9501, { lastActivityAt: T }));
    await mirror(
      message(55, 9502, { lastActivityAt: T + 5, groupType: "group" }),
    );
    expect((await stored(55)).conversationType).toBe("group");
  });

  test("a Chatwoot that never sends the type leaves it unknown, not individual", async () => {
    await mirror(message(53, 9301, { lastActivityAt: 1_786_630_000 }));
    expect(await stored(53)).toEqual({ conversationType: null, labels: [] });
  });
});
