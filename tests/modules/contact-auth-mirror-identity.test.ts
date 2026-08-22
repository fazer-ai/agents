import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// The mirrored contact is what the authorization gate sends to the operator's endpoint, so these
// are not prompt-quality questions: getting them wrong asks about the wrong person.
//
//   - a Chatwoot contact id is unique inside ONE account, so two accounts under one tenant used to
//     collapse contact 42 into a single row and the last write left one person's name over
//     another's phone;
//   - a CLEARED identifier used to be indistinguishable from an absent one, so an unlinked contact
//     went on being checked under the customer id it no longer has;
//   - and the write was unconditional, so a delivery arriving late could restore what a newer one
//     had already cleared.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

let tenantId = 0n;
let instA = 0n;
let instB = 0n;
let instC = 0n;

const CONTACT_ID = 42;
const INBOX = 71;

// Built as Chatwoot sends it and put through the real normalizer: the absent-vs-cleared distinction
// this file is about lives in `normalizeChatwootEvent`, so a hand-made normalized event would test
// the wrong half.
function payload(over: {
  conversationId: number;
  identifier?: string | null;
  identifierAbsent?: boolean;
  phone?: string | null;
  phoneAbsent?: boolean;
  updatedAt: number;
  // A degraded payload: no `last_activity_at`, so nothing positions it in time.
  undated?: boolean;
}) {
  return {
    event: "conversation_updated",
    id: over.conversationId,
    inbox_id: INBOX,
    status: "pending",
    contact_inbox: { id: 88_000 + over.conversationId },
    meta: {
      assignee_type: null,
      assignee: null,
      sender: {
        id: CONTACT_ID,
        name: "Cliente",
        ...(over.phoneAbsent ? {} : { phone_number: over.phone ?? null }),
        ...(over.identifierAbsent
          ? {}
          : { identifier: over.identifier ?? null }),
      },
    },
    channel: "Channel::Email",
    ...(over.undated ? {} : { last_activity_at: over.updatedAt }),
    updated_at: over.updatedAt,
  };
}

async function mirror(instanceId: bigint, over: Parameters<typeof payload>[0]) {
  const n = normalizeChatwootEvent(payload(over));
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, suDb);
}

const contactOf = (instanceId: bigint) =>
  suDb.contact.findUniqueOrThrow({
    where: {
      tenantId_chatwootInstanceId_chatwootContactId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: CONTACT_ID,
      },
    },
  });

describe.if(dbUp)("the identity the gate is given", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: {
          name: "MIRROR-IDENTITY",
          slug: `mirror-identity-${process.pid}`,
        },
      })
    ).id;
    instA = (await seedChatwootInstance(suDb, { tenantId, accountId: 1 })).id;
    instB = (await seedChatwootInstance(suDb, { tenantId, accountId: 2 })).id;
    instC = (await seedChatwootInstance(suDb, { tenantId, accountId: 3 })).id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
  });

  test("the same contact id in two accounts is two people", async () => {
    await mirror(instA, {
      conversationId: 8001,
      phone: "+5511900000001",
      identifier: "cliente-da-conta-a",
      updatedAt: 1787036000,
    });
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: "cliente-da-conta-b",
      updatedAt: 1787036000,
    });
    const a = await contactOf(instA);
    const b = await contactOf(instB);
    expect(a.id).not.toBe(b.id);
    expect(a.phone).toBe("+5511900000001");
    expect(b.phone).toBe("+5511900000002");
    expect(a.attributes).toEqual({ identifier: "cliente-da-conta-a" });
    expect(b.attributes).toEqual({ identifier: "cliente-da-conta-b" });
  });

  test("an unlink clears the stored identifier", async () => {
    await mirror(instA, {
      conversationId: 8001,
      phone: "+5511900000001",
      identifier: null,
      updatedAt: 1787039600,
    });
    expect((await contactOf(instA)).attributes).toEqual({});
  });

  test("a payload that does not carry the field keeps what is stored", async () => {
    await mirror(instA, {
      conversationId: 8001,
      phone: "+5511900000001",
      identifier: "religado",
      updatedAt: 1787043200,
    });
    await mirror(instA, {
      conversationId: 8001,
      phone: "+5511900000001",
      identifierAbsent: true,
      updatedAt: 1787046800,
    });
    expect((await contactOf(instA)).attributes).toEqual({
      identifier: "religado",
    });
  });

  // The gate reads phone and e-mail as identity too, so they follow the same rule the identifier
  // does: this was fixed for the identifier alone first, and a removed phone went on being the
  // identity the endpoint was asked about.
  test("a removed phone is removed, and an absent one is kept", async () => {
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: "cliente-da-conta-b",
      updatedAt: 1787060000,
    });
    await mirror(instB, {
      conversationId: 8002,
      phone: null,
      identifier: "cliente-da-conta-b",
      updatedAt: 1787063600,
    });
    expect((await contactOf(instB)).phone).toBeNull();
    await mirror(instB, {
      conversationId: 8002,
      phoneAbsent: true,
      identifier: "cliente-da-conta-b",
      updatedAt: 1787067200,
    });
    expect((await contactOf(instB)).phone).toBeNull();
  });

  // `last_activity_at` has one-second resolution, so two events inside one second cannot be ordered
  // by it at all. The two directions are not symmetric: a clear that loses leaves the gate asking
  // about an identity the customer no longer has.
  test("inside the same second, the clear wins", async () => {
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: "ainda-vinculado",
      updatedAt: 1787070800,
    });
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: null,
      updatedAt: 1787070800,
    });
    expect((await contactOf(instB)).attributes).toEqual({});
    // And the losing direction stays lost: a same-second payload cannot put it back.
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: "ainda-vinculado",
      updatedAt: 1787070800,
    });
    expect((await contactOf(instB)).attributes).toEqual({});
  });

  // The tie is decided per FIELD. A row-wide flag let an older snapshot carrying an unrelated
  // `email: null` rewrite everything it carried at an equal timestamp, restoring a phone a newer one
  // had just cleared.
  test("inside the same second, a clear elsewhere does not restore a cleared field", async () => {
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: "vinculado",
      updatedAt: 1787074400,
    });
    // Newer: clears the phone.
    await mirror(instB, {
      conversationId: 8002,
      phone: null,
      identifier: "vinculado",
      updatedAt: 1787078000,
    });
    expect((await contactOf(instB)).phone).toBeNull();
    // Older-but-same-second snapshot that still has the phone AND clears something else. The clear
    // it carries is the identifier's; the phone must not ride along on it.
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000002",
      identifier: null,
      updatedAt: 1787078000,
    });
    const row = await contactOf(instB);
    expect(row.phone).toBeNull();
    expect(row.attributes).toEqual({});
  });

  // The tie is not about clearing, it is about DISAGREEING. Two snapshots inside one second, each
  // naming a different phone: nothing can order them, so keeping either would be a coin toss about
  // whose number this is — and the gate would carry the winner to the operator's endpoint as fact.
  test("inside the same second, two different phones both lose", async () => {
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000010",
      identifier: "mesmo-cliente",
      updatedAt: 1787081600,
    });
    await mirror(instB, {
      conversationId: 8002,
      phone: "+5511900000011",
      identifier: "mesmo-cliente",
      updatedAt: 1787081600,
    });
    const row = await contactOf(instB);
    expect(row.phone).toBeNull();
    // Only the field they disagree on: the identifier they BOTH state is not in dispute.
    expect(row.attributes).toEqual({ identifier: "mesmo-cliente" });
  });

  // And the other half of the same rule, which is what keeps it from being "clear on every tie":
  // a re-delivery is two payloads at one timestamp that agree, and agreement is not a conflict.
  test("the same delivery twice keeps the identity it stated", async () => {
    const again = {
      conversationId: 8002,
      phone: "+5511900000012",
      identifier: "reentrega",
      updatedAt: 1787085200,
    };
    await mirror(instB, again);
    await mirror(instB, again);
    const row = await contactOf(instB);
    expect(row.phone).toBe("+5511900000012");
    expect(row.attributes).toEqual({ identifier: "reentrega" });
  });

  // An undated payload has no position at all, and a write with no position is a write decided by
  // arrival order. The bootstrap is the row's creation, which happens once; after that a degraded
  // delivery must not be able to rewrite what it cannot claim to be newer than.
  test("an undated payload seeds a new row and then stops writing", async () => {
    await mirror(instC, {
      conversationId: 8010,
      phone: "+5511900000020",
      identifier: "primeiro",
      updatedAt: 1787090000,
      undated: true,
    });
    const seeded = await contactOf(instC);
    expect(seeded.phone).toBe("+5511900000020");
    expect(seeded.phoneAt).toBeNull();

    await mirror(instC, {
      conversationId: 8010,
      phone: "+5511900000021",
      identifier: "segundo",
      updatedAt: 1787093600,
      undated: true,
    });
    const after = await contactOf(instC);
    expect(after.phone).toBe("+5511900000020");
    expect(after.attributes).toEqual({ identifier: "primeiro" });

    // And a dated event still takes over from a row nothing had positioned.
    await mirror(instC, {
      conversationId: 8010,
      phone: "+5511900000022",
      identifier: "datado",
      updatedAt: 1787097200,
    });
    const positioned = await contactOf(instC);
    expect(positioned.phone).toBe("+5511900000022");
    expect(positioned.phoneAt).not.toBeNull();
  });

  // A payload states a SUBSET of the identity, so one field's position may not be moved by an event
  // that never mentioned it. With a row-wide watermark, the name-only event below would have
  // rejected the phone clear behind it and left the gate asking about a number that is gone.
  test("a name-only event does not move the phone's position", async () => {
    await mirror(instC, {
      conversationId: 8020,
      phone: "+5511900000030",
      identifier: "com-telefone",
      updatedAt: 1787100000,
    });
    // Newer, and says nothing about the phone: only the name is stated.
    await mirror(instC, {
      conversationId: 8020,
      phoneAbsent: true,
      identifierAbsent: true,
      updatedAt: 1787103600,
    });
    // Older than that one, but newer than the phone's OWN position: the clear must land.
    await mirror(instC, {
      conversationId: 8020,
      phone: null,
      identifierAbsent: true,
      updatedAt: 1787101800,
    });
    const row = await contactOf(instC);
    expect(row.phone).toBeNull();
    // And the identifier, which neither of the two later events mentioned, is untouched.
    expect(row.attributes).toEqual({ identifier: "com-telefone" });
  });

  // Deliveries do arrive out of order, and this write runs before the conversation's stale guard.
  test("a late delivery does not restore an identifier a newer one cleared", async () => {
    await mirror(instA, {
      conversationId: 8001,
      phone: "+5511900000001",
      identifier: null,
      updatedAt: 1787054000,
    });
    expect((await contactOf(instA)).attributes).toEqual({});
    await mirror(instA, {
      conversationId: 8001,
      phone: "+5511900000001",
      identifier: "o-antigo",
      updatedAt: 1787050400,
    });
    expect((await contactOf(instA)).attributes).toEqual({});
  });
});
