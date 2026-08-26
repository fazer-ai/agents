import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  identifierQueueKey,
  runRedirectGate,
} from "@/modules/channel-redirect/gate";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// The redirect gate stamps `redirectSentAt` and spends one of `maxResends` the moment it believes the
// link went out — and that belief came from a `send` that could not report otherwise. Since the
// webhook's public post can now decline to send (the conversation stopped being the bot's mid-flight),
// a stamp on an undelivered link costs the lead the link entirely: the one-shot rule suppresses every
// later attempt, permanently when maxResends is 0. These pin the stamp to the delivery, not to the
// attempt.

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

// TEST-NET-3 on a closed port: passes the SSRF check without a DNS lookup, and nothing can reach it
// even if a call escaped the double.
const BASE_URL = "https://203.0.113.22:9";
const WIDGET_INBOX = 555;
const ENTRY_INBOX = 556;

let tenantId: bigint;
let instanceId: bigint;
let realFetch: typeof globalThis.fetch;

// Chatwoot's contact identity, as the fork actually implements it. `identifier` is unique per account
// (`uniq_identifier_per_account_contact`, and `validates :identifier, uniqueness: { scope: :account_id }`),
// so `PUT /contacts/:id` answers 422 with the Rails validation message the moment another contact holds
// the value — and answers 200 when the SAME contact already holds it, because uniqueness excludes the
// record being saved. `POST /contacts/filter` answers an exact question, case-insensitively.
// `POST /actions/contact_merge` destroys the mergee and the base keeps the attributes it already had,
// inheriting only the blank ones.
const contacts = new Map<number, { identifier: string | null }>();
// What the double was ASKED to do, so a test can assert the recovery ran (or did not).
const calls: {
  merges: Array<{ base: number; mergee: number }>;
  stamps: number;
  // The two acts of the recovery, counted so a test can prove one did not happen. "Did not merge" is
  // not the same as "did not run": the recovery has a second, non-destructive half.
  searches: number;
  unlinks: number;
  mintedFor: string[];
  // The conversation each token names as the redirect's ORIGIN (#222). The mint is the only moment
  // the two halves of an episode are known together, so a token minted without it produces a link
  // whose episode can never be paired.
  mintedOrigin: Array<number | undefined>;
  // The CONTACT each token names (fazer-ai/agents#286). The identifier is guessable and can move, so
  // it cannot say whose identity the link carries; the mint is admin-authenticated and can.
  mintedContact: Array<number | undefined>;
  selfReads: number;
} = {
  merges: [],
  stamps: 0,
  searches: 0,
  unlinks: 0,
  mintedFor: [],
  mintedOrigin: [],
  mintedContact: [],
  selfReads: 0,
};
// The race the recovery has to survive: the holder released the identifier between the 422 and the
// lookup that asks who holds it. Set by the test that pins what happens when nobody is found.
let releaseHolderAfterCollision = false;
// Answers the stamp with this status instead of looking at identity at all. Used to pin which
// failures are allowed to reach the recovery.
let failStampWith: number | null = null;
// Fails only the FIRST stamp, so what the recovery does afterwards is observable instead of being
// swallowed by a double that refuses everything.
let failFirstStampWith: number | null = null;
// Fails the Nth PUT to a contact, counting them all: the stamp that gets refused, the unlink, and the
// stamp after it. Lets a test land the first half of the transfer and refuse the second.
let failNthStampWith: { n: number; status: number } | null = null;
let contactWrites = 0;

function seedChatwootContact(id: number, identifier: string | null): void {
  contacts.set(id, { identifier });
}

function ownerOf(identifier: string): number | undefined {
  for (const [id, c] of contacts) if (c.identifier === identifier) return id;
  return undefined;
}

function installChatwootDouble(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith("/redirect_tokens") && init?.method === "POST") {
      // What the token was minted FOR. The widget identifies with this value, so a token carrying the
      // old identifier would hand the lead to whoever holds it.
      calls.mintedFor.push(String(body.identifier));
      calls.mintedOrigin.push(
        body.origin_display_id === undefined
          ? undefined
          : Number(body.origin_display_id),
      );
      calls.mintedContact.push(
        body.contact_id === undefined ? undefined : Number(body.contact_id),
      );
      return json({
        token: "tok-123",
        website_url: "https://chat.example.com",
      });
    }

    if (url.endsWith("/contacts/filter") && init?.method === "POST") {
      calls.searches++;
      // Case-INSENSITIVE, the way the fork's filter is for this attribute (`text_case_insensitive`,
      // and `filter_values` downcases the input), so the double can answer with a contact the client
      // has to reject itself.
      const wanted = String(
        body?.payload?.[0]?.values?.[0] ?? "",
      ).toLowerCase();
      const payload = [...contacts.entries()]
        .filter(([, c]) => c.identifier?.toLowerCase() === wanted)
        .map(([id, c]) => ({ id, identifier: c.identifier }));
      return json({ meta: { count: payload.length }, payload });
    }

    if (url.endsWith("/actions/contact_merge") && init?.method === "POST") {
      const base = Number(body.base_contact_id);
      const mergee = Number(body.mergee_contact_id);
      calls.merges.push({ base, mergee });
      const m = contacts.get(mergee);
      const b = contacts.get(base);
      if (!m || !b) return json({ message: "not found" }, 404);
      // merge_and_remove_mergee_contact: the mergee is destroyed, and the BASE's attributes win
      // (`mergee_attributes.deep_merge(base_attributes)` after compact_blank). So the mergee's
      // identifier survives onto the base only when the base had none.
      if (!b.identifier) b.identifier = m.identifier;
      contacts.delete(mergee);
      return json({ id: base });
    }

    const get = url.match(/\/contacts\/(\d+)$/);
    if (get && (init?.method ?? "GET") === "GET") {
      calls.selfReads++;
      const c = contacts.get(Number(get[1]));
      return json({
        payload: { id: Number(get[1]), identifier: c?.identifier },
      });
    }

    const put = url.match(/\/contacts\/(\d+)$/);
    if (
      put &&
      init?.method === "PUT" &&
      (typeof body.identifier === "string" || body.identifier === null)
    ) {
      const id = Number(put[1]);
      // A null identifier is the UNLINK, not a stamp of ours.
      if (body.identifier !== null) calls.stamps++;
      if (failStampWith !== null)
        return json({ message: "boom" }, failStampWith);
      if (failFirstStampWith !== null) {
        const status = failFirstStampWith;
        failFirstStampWith = null;
        return json({ message: "boom" }, status);
      }
      contactWrites++;
      if (failNthStampWith !== null && contactWrites === failNthStampWith.n) {
        return json({ message: "boom" }, failNthStampWith.status);
      }
      // Clearing is always allowed: `allow_blank` skips the validation and Postgres does not consider
      // two NULLs equal, so no unique index stands in the way.
      if (body.identifier === null) {
        calls.unlinks++;
        const cleared = contacts.get(id);
        if (cleared) cleared.identifier = null;
        return json({ id });
      }
      const holder = ownerOf(body.identifier);
      if (holder !== undefined && holder !== id) {
        if (releaseHolderAfterCollision) contacts.delete(holder);
        return json(
          {
            message: "Identifier has already been taken",
            attributes: ["identifier"],
          },
          422,
        );
      }
      const c = contacts.get(id) ?? { identifier: null };
      c.identifier = body.identifier;
      contacts.set(id, c);
      return json({ id });
    }

    return json({});
  }) as typeof globalThis.fetch;
}

const cfg = readChannelRedirectConfig({
  channelRedirect: {
    enabled: true,
    entryInboxId: ENTRY_INBOX,
    widgetInboxId: WIDGET_INBOX,
    redirectMessage: "Fale com a gente por aqui: {link}",
    maxResends: 0,
  },
});

async function seedConversation(
  chatwootConversationId: number,
): Promise<{ id: bigint; contactId: bigint; chatwootContactId: number }> {
  const contact = await suDb.contact.create({
    data: {
      chatwootInstanceId: instanceId,
      tenantId,
      chatwootContactId: 4000 + chatwootConversationId,
      name: "Lead",
    },
    select: { id: true },
  });
  const inbox = await suDb.inbox.upsert({
    where: {
      tenantId_chatwootInstanceId_chatwootInboxId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ENTRY_INBOX,
      },
    },
    create: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId: ENTRY_INBOX,
      name: "WhatsApp",
    },
    update: {},
    select: { id: true },
  });
  const conv = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox.id,
      contactId: contact.id,
      chatwootConversationId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
    },
    select: { id: true },
  });
  return {
    id: conv.id,
    contactId: contact.id,
    chatwootContactId: 4000 + chatwootConversationId,
  };
}

describe.skipIf(!dbUp)("runRedirectGate delivery accounting", () => {
  beforeAll(async () => {
    installChatwootDouble();
    const t = await suDb.tenant.create({
      data: { name: "REDIR", slug: `redir-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: BASE_URL,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  beforeEach(() => {
    contacts.clear();
    calls.merges = [];
    calls.stamps = 0;
    calls.searches = 0;
    calls.unlinks = 0;
    calls.mintedFor = [];
    calls.mintedOrigin = [];
    calls.mintedContact = [];
    calls.selfReads = 0;
    releaseHolderAfterCollision = false;
    failStampWith = null;
    failFirstStampWith = null;
    failNthStampWith = null;
    contactWrites = 0;
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (dbUp) {
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
      await suDb.$disconnect();
      await appDb.$disconnect();
    }
  });

  test("a link that was not delivered does not spend the resend budget", async () => {
    const conv = await seedConversation(7301);
    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7301,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async () => false,
    });

    expect(outcome).toBe("withheld");
    const row = await suDb.conversation.findUnique({
      where: { id: conv.id },
      select: { redirectSentAt: true, redirectCount: true },
    });
    // Untouched, so the lead is still owed the link: with maxResends at 0 a stamp here is permanent.
    expect(row?.redirectSentAt).toBeNull();
    expect(row?.redirectCount).toBe(0);
  });

  test("a delivered link is stamped and spends one", async () => {
    const conv = await seedConversation(7302);
    const sent: string[] = [];
    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7302,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
    });

    expect(outcome).toBe("sent");
    expect(sent[0]).toContain("https://chat.example.com");
    const row = await suDb.conversation.findUnique({
      where: { id: conv.id },
      select: { redirectSentAt: true, redirectCount: true },
    });
    expect(row?.redirectSentAt).not.toBeNull();
    expect(row?.redirectCount).toBe(1);
  });

  test("a contact already carrying the value is not written to again", async () => {
    const conv = await seedConversation(7305);
    // The ordinary case for a lead already stamped: the value is in place, a live token was minted
    // for it, and re-deriving or re-writing it buys nothing.
    seedChatwootContact(
      conv.chatwootContactId,
      `fzwa:${conv.chatwootContactId}`,
    );
    const sent: string[] = [];

    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7305,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
    });

    expect(outcome).toBe("sent");
    expect(calls.stamps).toBe(0);
    expect(calls.mintedFor).toEqual([`fzwa:${conv.chatwootContactId}`]);
    // The token names the conversation the gate is running on, which IS the episode's entry half.
    expect(calls.mintedOrigin).toEqual([7305]);
    // And WHOSE identity it carries. Without this the widget side has only the identifier to go on,
    // and an identifier that has moved off the contact makes it create a second one for this lead
    // instead of merging onto it (#286).
    expect(calls.mintedContact).toEqual([conv.chatwootContactId]);
  });
  test("a WhatsApp contact that already carries another identifier still ends up holding ours", async () => {
    const conv = await seedConversation(7306);
    // The state the report describes: the WhatsApp contact carries a WhatsApp LID identifier of its
    // own, which the stamp overwrites. What it must NOT do is leave the contact on that LID while the
    // token is minted for something else, since the widget identifies by the token's value.
    seedChatwootContact(conv.chatwootContactId, "554899990000@lid");
    seedChatwootContact(99003, `fzwa:${conv.chatwootContactId}`);
    const sent: string[] = [];

    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7306,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
    });

    expect(outcome).toBe("sent");
    const taken = contacts.get(conv.chatwootContactId)?.identifier;
    expect(taken).toMatch(
      new RegExp(`^fzwa:${conv.chatwootContactId}:[0-9a-f]{8}$`),
    );
    expect(calls.mintedFor).toEqual([taken as string]);
    // The VALUE moved; whose link it is did not. A token naming the squatter — or naming none — would
    // send the widget to unify this lead onto somebody else, or onto nobody (#286).
    expect(calls.mintedContact).toEqual([conv.chatwootContactId]);
    // The holder keeps what it had; nothing here writes to a contact that is not ours.
    expect(contacts.get(99003)?.identifier).toBe(
      `fzwa:${conv.chatwootContactId}`,
    );
  });

  test("a stamp that fails for any reason other than the identifier reaches no recovery at all", async () => {
    const conv = await seedConversation(7307);
    seedChatwootContact(conv.chatwootContactId, null);
    seedChatwootContact(99004, `fzwa:${conv.chatwootContactId}`);
    // A 500 is transient and says nothing about the identifier, so it is not answered by taking a
    // different one: the lead would end up on a value it moved to for no reason, and a transient
    // failure would silently rotate the identifier of every lead it touched. Only the FIRST write
    // fails here, so a second attempt would visibly succeed if the guard were not there.
    failFirstStampWith = 500;
    const sent: string[] = [];

    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7307,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
    });

    expect(outcome).toBe("misconfigured");
    expect(sent).toEqual([]);
    // Nothing moved: our contact holds no identifier, no token was minted, and the contact that
    // happens to hold the value is untouched.
    expect(contacts.get(conv.chatwootContactId)?.identifier).toBeNull();
    expect(calls.mintedFor).toEqual([]);
    expect(contacts.get(99004)?.identifier).toBe(
      `fzwa:${conv.chatwootContactId}`,
    );
  });

  test("a held identifier is answered by taking a different one, and the token carries it", async () => {
    const conv = await seedConversation(7303);
    // The state the report measured: the WhatsApp contact does not hold `fzwa:<its own id>`, and some
    // other contact does. Every later redirect for this lead used to die on the 422 that answers it.
    seedChatwootContact(conv.chatwootContactId, null);
    seedChatwootContact(99001, `fzwa:${conv.chatwootContactId}`);
    const sent: string[] = [];

    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7303,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async (text: string) => {
        sent.push(text);
        return true;
      },
    });

    expect(outcome).toBe("sent");
    expect(sent[0]).toContain("https://chat.example.com");

    // Ours now, under a value nobody could have claimed in advance.
    const taken = contacts.get(conv.chatwootContactId)?.identifier;
    expect(taken).toMatch(
      new RegExp(`^fzwa:${conv.chatwootContactId}:[0-9a-f]{8}$`),
    );
    // THE TOKEN CARRIES THAT ONE. Minting for the original value would send the widget to identify as
    // the contact still holding it, handing the lead to a stranger.
    expect(calls.mintedFor).toEqual([taken as string]);
    // And the other contact is left exactly as it was: not merged, not stripped, not read.
    expect(contacts.get(99001)?.identifier).toBe(
      `fzwa:${conv.chatwootContactId}`,
    );
    expect(calls.merges).toEqual([]);
    expect(calls.unlinks).toBe(0);
    expect(calls.searches).toBe(0);
  });

  test("two leads colliding on the same value both get served, with different ones", async () => {
    const first = await seedConversation(7312);
    const second = await seedConversation(7313);
    seedChatwootContact(first.chatwootContactId, null);
    seedChatwootContact(second.chatwootContactId, null);
    seedChatwootContact(99007, `fzwa:${first.chatwootContactId}`);
    seedChatwootContact(99008, `fzwa:${second.chatwootContactId}`);

    for (const [convId, conv] of [
      [7312, first],
      [7313, second],
    ] as const) {
      const outcome = await runRedirectGate({
        tenantId,
        instanceId,
        conversationId: convId,
        conv: {
          id: conv.id,
          contactId: conv.contactId,
          redirectSentAt: null,
          redirectCount: 0,
        },
        cfg,
        clonedMessage: null,
        now: new Date(),
        base: appDb,
        send: async () => true,
      });
      expect(outcome).toBe("sent");
    }

    const a = contacts.get(first.chatwootContactId)?.identifier;
    const b = contacts.get(second.chatwootContactId)?.identifier;
    expect(a).not.toBe(b);
    expect(calls.mintedFor).toEqual([a as string, b as string]);
  });
  test("a contact that already moved keeps the value it moved to", async () => {
    const conv = await seedConversation(7319);
    // The second delivery for a lead whose base value is held elsewhere. Minting a fresh suffix here
    // would leave the link issued minutes ago pointing at a value this contact no longer has, and
    // links outlive the resend cooldown by design (24h).
    seedChatwootContact(conv.chatwootContactId, null);
    seedChatwootContact(99013, `fzwa:${conv.chatwootContactId}`);

    const run = () =>
      runRedirectGate({
        tenantId,
        instanceId,
        conversationId: 7319,
        conv: {
          id: conv.id,
          contactId: conv.contactId,
          redirectSentAt: null,
          redirectCount: 0,
        },
        cfg,
        clonedMessage: null,
        now: new Date(),
        base: appDb,
        send: async () => true,
      });

    expect(await run()).toBe("sent");
    const first = contacts.get(conv.chatwootContactId)?.identifier;
    expect(await run()).toBe("sent");
    const second = contacts.get(conv.chatwootContactId)?.identifier;

    expect(second).toBe(first as string);
    // Both tokens carry it, so either link resolves onto this contact.
    expect(calls.mintedFor).toEqual([first as string, first as string]);
  });

  test("an identifier that is not one of ours is not reused", async () => {
    const conv = await seedConversation(7320);
    // A WhatsApp LID, or any other value: the base is held elsewhere, and what this contact happens to
    // carry says nothing about a link this gate ever issued.
    seedChatwootContact(conv.chatwootContactId, "554899990000@lid");
    seedChatwootContact(99014, `fzwa:${conv.chatwootContactId}`);

    const outcome = await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7320,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async () => true,
    });

    expect(outcome).toBe("sent");
    const taken = contacts.get(conv.chatwootContactId)?.identifier;
    expect(taken).toMatch(
      new RegExp(`^fzwa:${conv.chatwootContactId}:[0-9a-f]{8}$`),
    );
    expect(calls.mintedFor).toEqual([taken as string]);
  });

  test("the ordinary path reads, and writes only what is not there yet", async () => {
    const conv = await seedConversation(7321);
    seedChatwootContact(conv.chatwootContactId, null);

    await runRedirectGate({
      tenantId,
      instanceId,
      conversationId: 7321,
      conv: {
        id: conv.id,
        contactId: conv.contactId,
        redirectSentAt: null,
        redirectCount: 0,
      },
      cfg,
      clonedMessage: null,
      now: new Date(),
      base: appDb,
      send: async () => true,
    });

    // One read to see what the contact carries, one write because it carried nothing.
    expect(calls.selfReads).toBe(1);
    expect(calls.stamps).toBe(1);
  });
  test("a contact that moved keeps its value even after the base becomes free", async () => {
    const conv = await seedConversation(7322);
    seedChatwootContact(conv.chatwootContactId, null);
    seedChatwootContact(99015, `fzwa:${conv.chatwootContactId}`);

    const run = () =>
      runRedirectGate({
        tenantId,
        instanceId,
        conversationId: 7322,
        conv: {
          id: conv.id,
          contactId: conv.contactId,
          redirectSentAt: null,
          redirectCount: 0,
        },
        cfg,
        clonedMessage: null,
        now: new Date(),
        base: appDb,
        send: async () => true,
      });

    expect(await run()).toBe("sent");
    const moved = contacts.get(conv.chatwootContactId)?.identifier;
    expect(moved).toMatch(
      new RegExp(`^fzwa:${conv.chatwootContactId}:[0-9a-f]{8}$`),
    );

    // The holder goes away: deleted, merged, or simply cleared. The base value is free now, and
    // reclaiming it would strand the token minted for the suffix, which is live for 24h.
    contacts.delete(99015);
    expect(await run()).toBe("sent");

    expect(contacts.get(conv.chatwootContactId)?.identifier).toBe(
      moved as string,
    );
    expect(calls.mintedFor).toEqual([moved as string, moved as string]);
  });

  test("two deliveries recovering the same contact at once settle on one value", async () => {
    const conv = await seedConversation(7323);
    seedChatwootContact(conv.chatwootContactId, null);
    seedChatwootContact(99016, `fzwa:${conv.chatwootContactId}`);

    // Both read the contact before either has written, if nothing serializes them, and each mints a
    // token for its own suffix: one of the two links is dead on arrival.
    const both = await Promise.all(
      [7323, 7323].map(() =>
        runRedirectGate({
          tenantId,
          instanceId,
          conversationId: 7323,
          conv: {
            id: conv.id,
            contactId: conv.contactId,
            redirectSentAt: null,
            redirectCount: 0,
          },
          cfg,
          clonedMessage: null,
          now: new Date(),
          base: appDb,
          send: async () => true,
        }),
      ),
    );

    expect(both).toEqual(["sent", "sent"]);
    const settled = contacts.get(conv.chatwootContactId)?.identifier;
    expect(new Set(calls.mintedFor)).toEqual(new Set([settled as string]));
  });
  test("the queue key separates instances that share a contact number", async () => {
    // A Chatwoot contact id is unique inside one account and not beyond it, so two tenants can both
    // have contact 42. Sharing a queue between them means a slow round trip on one Chatwoot server
    // holds up a redirect on another.
    expect(identifierQueueKey(1n, 42)).not.toBe(identifierQueueKey(2n, 42));
    expect(identifierQueueKey(1n, 42)).toBe(identifierQueueKey(1n, 42));
    expect(identifierQueueKey(1n, 42)).not.toBe(identifierQueueKey(1n, 43));
  });
});
