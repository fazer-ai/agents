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

  // ── Review round 5 of #355: the pairing is the EPISODE'S IDENTITY, so the row's per-episode
  //    watermarks have to move with it. `redirectLinkedAt` and `redirectClosedAt` are one-shots
  //    scoped to "this redirect episode": the first gates the cross-link, the second is the
  //    at-most-once claim for the goodbye. Neither knew which origin it was stamped for, because
  //    until #222 nothing on this side did. ──

  async function setWatermarks(convId: number, at: Date | null) {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: convId },
      data: { redirectLinkedAt: at, redirectClosedAt: at },
    });
  }

  async function watermarks(convId: number) {
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { redirectLinkedAt: true, redirectClosedAt: true },
    });
    return {
      linked: row.redirectLinkedAt !== null,
      closed: row.redirectClosedAt !== null,
    };
  }

  // The defect this releases. Without it the second episode never gets its cross-link (the one-shot
  // reads a watermark the FIRST episode set) and never gets its goodbye (the closing CAS asks for
  // `redirectClosedAt: null` and the first episode already spent it).
  test("a different origin releases the previous episode's watermarks", async () => {
    const T = 1_786_600_000;
    await mirror(
      clonedMessage(50, {
        messageId: 8500,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await setWatermarks(50, new Date());

    await mirror({
      event: "conversation_updated",
      ...convPayload(50, { lastActivityAt: T, updatedAt: T + 5, origin: 91 }),
    });

    expect(await storedOrigin(50)).toBe(91);
    expect(await watermarks(50)).toEqual({ linked: false, closed: false });
  });

  // The other half, and the one that keeps this from being a wipe on every delivery: the retried
  // snapshot of the SAME episode says nothing new, so the episode it describes is still running.
  test("a retry of the same origin leaves the episode standing", async () => {
    const T = 1_786_610_000;
    await mirror(
      clonedMessage(51, {
        messageId: 8600,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await setWatermarks(51, new Date());

    await mirror(
      clonedMessage(51, {
        messageId: 8601,
        lastActivityAt: T + 30,
        updatedAt: T + 30.1,
        origin: 77,
      }),
    );

    expect(await storedOrigin(51)).toBe(77);
    expect(await watermarks(51)).toEqual({ linked: true, closed: true });
  });

  // LEARNING a pairing is not a new episode, and the column alone cannot tell the two apart: stored
  // null is both "the fork never spoke about this conversation" and "the fork said there is none".
  // `chatwootRedirectOriginAt` is what separates them — it is set the first time we are TOLD — and
  // the direction of the mistake decides which way to lean. Releasing here would re-run the
  // cross-link on a live episode and post its private notes a second time, on every conversation, the
  // day fazer-ai/chatwoot#418 is deployed; not releasing leaves exactly the behaviour of today.
  test("the first pairing ever stated leaves the episode standing", async () => {
    const T = 1_786_620_000;
    await mirror(
      clonedMessage(52, {
        messageId: 8700,
        lastActivityAt: T,
        updatedAt: T + 0.1,
      }),
    );
    await setWatermarks(52, new Date());

    await mirror(
      clonedMessage(52, {
        messageId: 8701,
        lastActivityAt: T + 30,
        updatedAt: T + 30.1,
        origin: 77,
      }),
    );

    expect(await storedOrigin(52)).toBe(77);
    expect(await watermarks(52)).toEqual({ linked: true, closed: true });
  });

  // A stated clear IS an episode change: the fork writes it when a token resumes this conversation
  // naming no origin, which is a resume with no WhatsApp half. What must not follow is the previous
  // episode's ladder closing a thread this conversation is no longer paired with.
  test("a stated clear releases the episode too", async () => {
    const T = 1_786_630_000;
    await mirror(
      clonedMessage(53, {
        messageId: 8800,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await setWatermarks(53, new Date());

    await mirror({
      event: "conversation_updated",
      ...convPayload(53, { lastActivityAt: T, updatedAt: T + 5, origin: null }),
    });

    expect(await storedOrigin(53)).toBeNull();
    expect(await watermarks(53)).toEqual({ linked: false, closed: false });
  });

  // The release rides with the WRITE, so it has to reach the stale branch as well: that branch is
  // where the pairing's own `conversation_updated` lands whenever the payload is behind on activity,
  // which is the ordinary case for it (`last_activity_at` does not move on a column write).
  test("the stale branch releases the episode with the pairing it writes", async () => {
    const T = 1_786_640_000;
    await mirror(
      clonedMessage(54, {
        messageId: 8900,
        lastActivityAt: T + 600,
        updatedAt: T + 600.1,
        origin: 77,
      }),
    );
    await setWatermarks(54, new Date());

    // Older on activity than what is stored — this is the stale branch — but newer on the pairing's
    // own mark, so the pairing applies and the episode goes with it.
    await mirror({
      event: "conversation_updated",
      ...convPayload(54, {
        lastActivityAt: T,
        updatedAt: T + 700,
        origin: 91,
      }),
    });

    expect(await storedOrigin(54)).toBe(91);
    expect(await watermarks(54)).toEqual({ linked: false, closed: false });
  });

  // The release rides on the pairing being APPLIED, and both halves of that matter. A payload that
  // says nothing about the pairing is not an episode change — it is every ordinary message from a
  // Chatwoot without fazer-ai/chatwoot#418, and reading its silence as "no origin, therefore
  // different" would release the episode of every conversation on every delivery.
  test("a payload that omits the key leaves the episode standing", async () => {
    const T = 1_786_650_000;
    await mirror(
      clonedMessage(55, {
        messageId: 9000,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await setWatermarks(55, new Date());

    await mirror(
      clonedMessage(55, {
        messageId: 9001,
        lastActivityAt: T + 60,
        updatedAt: T + 60.1,
      }),
    );

    expect(await storedOrigin(55)).toBe(77);
    expect(await watermarks(55)).toEqual({ linked: true, closed: true });
  });

  // And the other half: a pairing the version fence REFUSES describes an episode that already ended,
  // so it cannot end the one running now. Releasing on a value that is not written would let the
  // retried delivery of a previous episode wipe the current episode's one-shots.
  test("a refused older pairing leaves the episode standing", async () => {
    const T = 1_786_660_000;
    await mirror(
      clonedMessage(56, {
        messageId: 9100,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );
    await mirror(
      clonedMessage(56, {
        messageId: 9101,
        lastActivityAt: T,
        updatedAt: T + 0.62,
        origin: 91,
      }),
    );
    await setWatermarks(56, new Date());

    // The retry of the first delivery: a DIFFERENT origin, and one this row already moved past.
    await mirror(
      clonedMessage(56, {
        messageId: 9100,
        lastActivityAt: T,
        updatedAt: T + 0.11,
        origin: 77,
      }),
    );

    expect(await storedOrigin(56)).toBe(91);
    expect(await watermarks(56)).toEqual({ linked: true, closed: true });
  });

  // ── Review round 8 of #355: the upgrade day. ──

  async function marks(convId: number) {
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: {
        redirectOriginDisplayId: true,
        chatwootRedirectOriginAt: true,
        redirectLinkedAt: true,
        redirectClosedAt: true,
      },
    });
    return row;
  }

  // The regression this guards, and it fires on EVERY conversation at once. A redirect episode that
  // began before the fork carried the field has a NULL column in Chatwoot, and once the fork ships,
  // every payload for it carries the key with nil. Read as a stated clear, that stamps the mark, and
  // a stamped mark is what tells `episodeOriginQuery` to refuse the recency fallback — so the first
  // inbound after the upgrade loses its cross-link and every later WhatsApp touch loses its sibling.
  //
  // A clear is a TRANSITION, and there is nothing to transition from here. Silence and the column's
  // default arrive as the same bytes, so the only thing that separates them is whether we were ever
  // told about a pairing on this conversation.
  test("a null on a conversation we were never told about is not a clear", async () => {
    const T = 1_786_700_000;
    await mirror(
      clonedMessage(57, {
        messageId: 9200,
        lastActivityAt: T,
        updatedAt: T + 0.1,
      }),
    );
    await setWatermarks(57, new Date());

    // The fork is deployed: the key is present on every payload from now on, and nil.
    await mirror(
      clonedMessage(57, {
        messageId: 9201,
        lastActivityAt: T + 60,
        updatedAt: T + 60.1,
        origin: null,
      }),
    );

    const row = await marks(57);
    expect(row.redirectOriginDisplayId).toBeNull();
    // Not stamped: nothing was stated, so the fallback this episode has always used stays open.
    expect(row.chatwootRedirectOriginAt).toBeNull();
    expect(row.redirectLinkedAt).not.toBeNull();
  });

  // And the clear that IS a transition still counts, mark and all.
  test("a null after a pairing we were told about is a clear", async () => {
    const T = 1_786_710_000;
    await mirror(
      clonedMessage(58, {
        messageId: 9300,
        lastActivityAt: T,
        updatedAt: T + 0.1,
        origin: 77,
      }),
    );
    await mirror(
      clonedMessage(58, {
        messageId: 9301,
        lastActivityAt: T + 60,
        updatedAt: T + 60.1,
        origin: null,
      }),
    );
    const row = await marks(58);
    expect(row.redirectOriginDisplayId).toBeNull();
    expect(row.chatwootRedirectOriginAt).toBe(T + 60.1);
  });

  // The other half of round 8: a stored pairing with no mark. A Chatwoot too old to send
  // `updated_at` writes the value and stamps nothing, so the mark cannot be the only evidence that
  // we were told — the stored origin is evidence of its own, and a change away from it is a new
  // episode exactly as it would be with a mark.
  test("a versionless pairing that changes still releases the episode", async () => {
    const T = 1_786_720_000;
    await mirror(
      clonedMessage(59, { messageId: 9400, lastActivityAt: T, origin: 77 }),
    );
    let row = await marks(59);
    expect(row.redirectOriginDisplayId).toBe(77);
    // No `updated_at` on that payload, so nothing to stamp: this is the state the finding is about.
    expect(row.chatwootRedirectOriginAt).toBeNull();

    await setWatermarks(59, new Date());
    await mirror(
      clonedMessage(59, {
        messageId: 9401,
        lastActivityAt: T + 60,
        origin: 91,
      }),
    );

    row = await marks(59);
    expect(row.redirectOriginDisplayId).toBe(91);
    expect(row.redirectLinkedAt).toBeNull();
    expect(row.redirectClosedAt).toBeNull();
  });
});
