import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #222, review round 1 of #355. The pairing is written by the fork's token resolve and read
// by the closing stage, which MESSAGES and RESOLVES the conversation it names — so a pairing that
// regresses to a previous episode's origin acts destructively on the wrong WhatsApp thread.
//
// A widget conversation can be re-entered from a second WhatsApp thread, and every payload that
// carries the conversation carries whatever the pairing was when it was SERIALIZED. Delivery is not
// serialization order: `AgentBots::WebhookJob` retries 3 times, 3s apart. `last_activity_at` cannot
// separate two re-entries inside one second (whole-second resolution), so the only key that can is
// the conversation's own `updated_at`, which moves on every write to the row — the update that
// records the pairing included.

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
const INBOX = 91;

interface ConvOver {
  lastActivityAt: number;
  updatedAt?: number;
  // Omitted ⇒ the key is absent from the payload (a Chatwoot that does not speak about pairings);
  // `null` ⇒ the key is present and states "no pairing", which is how the fork announces a clear.
  origin?: number | null;
}

function convPayload(convId: number, over: ConvOver) {
  return {
    id: convId,
    inbox_id: INBOX,
    status: "open",
    contact_inbox: { id: 77_000 + convId },
    meta: {
      assignee_type: null,
      assignee: null,
      sender: {
        id: 600 + convId,
        name: "Lead",
        phone_number: "+5511988887777",
      },
    },
    channel: "Channel::WebWidget",
    last_activity_at: over.lastActivityAt,
    ...(over.updatedAt !== undefined ? { updated_at: over.updatedAt } : {}),
    ...(over.origin !== undefined
      ? { redirect_origin_display_id: over.origin }
      : {}),
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  expect(n).not.toBeNull();
  if (!n) throw new Error("unreachable");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

// A cloned message arriving for a widget conversation: the snapshot embeds the pairing as it stood
// when the message fired.
function clonedMessage(convId: number, over: ConvOver & { messageId: number }) {
  return {
    event: "message_created",
    id: over.messageId,
    content: "Oi, vim do WhatsApp",
    message_type: "incoming",
    private: false,
    conversation: convPayload(convId, over),
  };
}

async function storedOrigin(convId: number) {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { redirectOriginDisplayId: true },
  });
  return row.redirectOriginDisplayId;
}

describe.skipIf(!dbUp)("mirror: the redirect pairing never regresses", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "MIRROR-REDIRECT-ORIGIN",
        slug: `mirror-redirect-origin-${process.pid}`,
      },
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

  // The race the fence exists for. Both re-entries land in ONE second, so `last_activity_at` cannot
  // separate them; the retried delivery of the FIRST arrives after the second and carries origin 77.
  test("a retried snapshot cannot overwrite a newer origin inside one second", async () => {
    const T = 1_786_500_000;
    await mirror(
      clonedMessage(40, {
        messageId: 8001,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );
    await mirror(
      clonedMessage(40, {
        messageId: 8002,
        lastActivityAt: T,
        updatedAt: T + 0.62,
        origin: 91,
      }),
    );
    expect(await storedOrigin(40)).toBe(91);

    // The retry of the first delivery, unchanged, ~9s late.
    await mirror(
      clonedMessage(40, {
        messageId: 8001,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );
    expect(await storedOrigin(40)).toBe(91);
  });

  // The fork emits a conversation_updated of its own when the pairing changes on an existing
  // conversation (fazer-ai/chatwoot#418). It carries a FRESH `updated_at` and the FROZEN
  // `last_activity_at` — the column write does not move that one — so recency cannot order it and
  // the version must.
  test("the pairing's own conversation_updated applies despite a frozen last_activity_at", async () => {
    const T = 1_786_510_000;
    await mirror(
      clonedMessage(41, {
        messageId: 8100,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    expect(await storedOrigin(41)).toBe(77);

    await mirror({
      event: "conversation_updated",
      ...convPayload(41, {
        lastActivityAt: T,
        updatedAt: T + 5.4,
        origin: 91,
      }),
    });
    expect(await storedOrigin(41)).toBe(91);
  });

  // Ordinary forward motion still works: a later episode's snapshot, serialized after the write,
  // carries the newer origin and takes it.
  test("a newer origin still takes over", async () => {
    const T = 1_786_520_000;
    await mirror(
      clonedMessage(42, {
        messageId: 8200,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await mirror(
      clonedMessage(42, {
        messageId: 8201,
        lastActivityAt: T + 600,
        updatedAt: T + 600.1,
        origin: 91,
      }),
    );
    expect(await storedOrigin(42)).toBe(91);
  });

  // The mirror creates the row from whatever event it sees FIRST, which is not necessarily the
  // oldest one: a retry can put the newer re-entry ahead of the older. The mark has to be stamped at
  // creation too, or the row is born unprotected and the delayed payload regresses it.
  test("a row born from the newer payload is already protected from the older one", async () => {
    const T = 1_786_525_000;
    await mirror(
      clonedMessage(45, {
        messageId: 8250,
        lastActivityAt: T,
        updatedAt: T + 0.62,
        origin: 91,
      }),
    );
    expect(await storedOrigin(45)).toBe(91);

    await mirror(
      clonedMessage(45, {
        messageId: 8249,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );
    expect(await storedOrigin(45)).toBe(91);
  });

  // The pairing rides on payloads whose STATE is old news, and the two questions are independent. A
  // conversation the mirror has been following for a while has newer status/assignee/activity marks
  // and no redirect mark at all — the shape of every conversation live when the fork gains the field,
  // and of a rolling deploy. The first payload to carry the pairing can easily be behind on those
  // other axes (a retry, a frozen message snapshot), and discarding it wholesale would leave the
  // episode unpaired and send the caller to the recency fallback this whole change exists to remove.
  test("a payload behind on state still delivers a pairing it is the first to carry", async () => {
    const T = 1_786_550_000;
    // A conversation already being mirrored, with no pairing yet.
    await mirror(
      clonedMessage(46, {
        messageId: 8500,
        lastActivityAt: T + 600,
        updatedAt: T + 600.5,
      }),
    );
    expect(await storedOrigin(46)).toBeNull();

    // The delayed delivery: older on every axis the row already holds, and the only witness of the
    // pairing.
    await mirror(
      clonedMessage(46, {
        messageId: 8499,
        lastActivityAt: T,
        updatedAt: T + 0.5,
        origin: 77,
      }),
    );
    expect(await storedOrigin(46)).toBe(77);
  });

  // ...and being let through for the pairing does not let the rest of that payload in. A brand-new
  // incoming message normally reopens a conversation, which is the one status a message snapshot
  // carries faithfully; a DELAYED one must not, and the pairing must not become the loophole.
  test("...without letting the stale payload move any other state", async () => {
    const T = 1_786_560_000;
    await mirror({
      event: "conversation_resolved",
      ...convPayload(47, {
        lastActivityAt: T + 600,
        updatedAt: T + 600.5,
      }),
      status: "resolved",
    });
    await mirror(
      clonedMessage(47, {
        messageId: 8599,
        lastActivityAt: T,
        updatedAt: T + 0.5,
        origin: 77,
      }),
    );
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 47 },
      select: {
        redirectOriginDisplayId: true,
        status: true,
        lastEventAt: true,
      },
    });
    expect(row.redirectOriginDisplayId).toBe(77);
    expect(row.status).toBe("resolved");
    // And the activity watermark does not rewind to the delayed payload's.
    expect(row.lastEventAt).toEqual(new Date((T + 600) * 1000));
  });

  // A Chatwoot too old to send `updated_at` has nothing to order by. It keeps the pre-fence
  // behaviour — last write wins — rather than losing the pairing outright.
  test("without a version the payload still writes the pairing", async () => {
    const T = 1_786_530_000;
    await mirror(
      clonedMessage(43, { messageId: 8300, lastActivityAt: T, origin: 77 }),
    );
    expect(await storedOrigin(43)).toBe(77);
    await mirror(
      clonedMessage(43, { messageId: 8301, lastActivityAt: T, origin: 91 }),
    );
    expect(await storedOrigin(43)).toBe(91);
  });

  // The fork CLEARS the pairing when a re-entry's token names no origin (fazer-ai/chatwoot#418), and
  // states that clear as an explicit null rather than by omitting the key. Mirroring it is the whole
  // point: the consumer holding the previous pairing is the one that has to stop acting on it.
  test("an explicit null clears the stored pairing", async () => {
    const T = 1_786_570_000;
    await mirror(
      clonedMessage(48, {
        messageId: 8700,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    expect(await storedOrigin(48)).toBe(77);

    await mirror({
      event: "conversation_updated",
      ...convPayload(48, {
        lastActivityAt: T,
        updatedAt: T + 5.4,
        origin: null,
      }),
    });
    expect(await storedOrigin(48)).toBeNull();
  });

  // ...and the clear is ordered like any other statement about the pairing: a retried delivery of the
  // payload that set it cannot bring it back.
  test("a stale payload cannot undo a clear", async () => {
    const T = 1_786_580_000;
    await mirror(
      clonedMessage(49, {
        messageId: 8800,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );
    await mirror({
      event: "conversation_updated",
      ...convPayload(49, {
        lastActivityAt: T,
        updatedAt: T + 0.62,
        origin: null,
      }),
    });
    expect(await storedOrigin(49)).toBeNull();

    await mirror(
      clonedMessage(49, {
        messageId: 8800,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );
    expect(await storedOrigin(49)).toBeNull();
  });

  // A payload that OMITS the key leaves the stored one alone. Absent is not null: it is what a
  // Chatwoot without fazer-ai/chatwoot#418 sends on every event, and reading it as a clear would wipe
  // the pairing of every episode on the first ordinary message.
  test("a payload with no origin key leaves the pairing standing", async () => {
    const T = 1_786_540_000;
    await mirror(
      clonedMessage(44, {
        messageId: 8400,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await mirror(
      clonedMessage(44, {
        messageId: 8401,
        lastActivityAt: T + 60,
        updatedAt: T + 60.1,
      }),
    );
    expect(await storedOrigin(44)).toBe(77);
  });
});
