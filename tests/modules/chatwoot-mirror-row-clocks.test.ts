import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { syncInboxes } from "@/modules/chatwoot/management";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { dbProbeFailed } from "@/tests/db-gate";
import contactA from "../fixtures/chatwoot-row-clocks/001-message_created.json";
import contactB from "../fixtures/chatwoot-row-clocks/003-conversation_status_changed.json";
import inboxN2 from "../fixtures/chatwoot-row-clocks/007-message_created.json";
import { seedChatwootInstance } from "../utils/chatwoot";

// The contact's custom attributes and the inbox's name live on rows many conversations share, so the
// conversation's clocks cannot order them; the mirror orders them by each row's own `updated_at` when
// the payload carries it. The fixtures are wire bodies of the fork, trimmed to what the mirror reads:
// a contact edited ouro -> prata with no message between (both share `last_activity_at`), and an inbox
// renamed. Each test reads the row right after the delayed delivery, with nothing re-applying it.

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

type Body = Record<string, unknown>;
const clone = (b: unknown): Body => structuredClone(b) as Body;

// The conversation object of a body, whichever shape it is.
function convOf(b: Body): Body {
  return (b.conversation as Body | undefined) ?? b;
}

function senderOf(b: Body): Body {
  return (convOf(b).meta as Body).sender as Body;
}

// A fixture moved onto its own contact, conversation and inbox, so tests never share a row.
function onRows(
  b: unknown,
  ids: { contact: number; conv: number; inbox?: number },
): Body {
  const out = clone(b);
  const conv = convOf(out);
  conv.id = ids.conv;
  (conv.contact_inbox as Body).id = ids.conv;
  senderOf(out).id = ids.contact;
  if (out.sender) (out.sender as Body).id = ids.contact;
  if (ids.inbox !== undefined) {
    conv.inbox_id = ids.inbox;
    if (out.inbox) (out.inbox as Body).id = ids.inbox;
  }
  return out;
}

function withContact(b: Body, attrs: Body, clock: number | undefined): Body {
  const s = senderOf(b);
  s.custom_attributes = attrs;
  if (clock === undefined) delete s.updated_at;
  else s.updated_at = clock;
  if (b.sender) {
    (b.sender as Body).custom_attributes = attrs;
    if (clock === undefined) delete (b.sender as Body).updated_at;
    else (b.sender as Body).updated_at = clock;
  }
  return b;
}

function withInbox(b: Body, name: string, clock: number | undefined): Body {
  const inbox = b.inbox as Body;
  inbox.name = name;
  if (clock === undefined) delete inbox.updated_at;
  else inbox.updated_at = clock;
  return b;
}

function at(b: Body, activity: number, version: number): Body {
  const conv = convOf(b);
  conv.last_activity_at = activity;
  conv.updated_at = version;
  return b;
}

async function mirror(payload: Body) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function attrsOf(contact: number) {
  const r = await suDb.contact.findFirstOrThrow({
    where: { tenantId, chatwootContactId: contact },
    select: { customAttributes: true },
  });
  return r.customAttributes;
}

async function inboxOf(inbox: number) {
  return suDb.inbox.findFirstOrThrow({
    where: { tenantId, chatwootInboxId: inbox },
    select: { name: true, channelType: true },
  });
}

describe("normalize: the rows' own clocks", () => {
  test("the contact's clock is read from meta.sender, never from the message's author", () => {
    const b = clone(inboxN2);
    b.message_type = "outgoing";
    b.sender = { id: 3, type: "user", name: "Operador", updated_at: 1.9e9 };
    const n = normalizeChatwootEvent(b);
    expect(n?.contact?.updatedAt).toBe(1791685802.796915);
    expect(n?.inboxUpdatedAt).toBe(1791685803.416985);
  });

  test("a clock that is not a positive number reads as absent", () => {
    // One row per refusal: a numeric string fails the type check, zero fails the positive check.
    for (const bad of ["1791685802.5", 0]) {
      const b = clone(inboxN2);
      senderOf(b).updated_at = bad;
      (b.inbox as Body).updated_at = bad;
      const n = normalizeChatwootEvent(b);
      expect(n?.contact?.updatedAt ?? null).toBeNull();
      expect(n?.inboxUpdatedAt ?? null).toBeNull();
    }
  });
});

describe.skipIf(!dbUp)(
  "mirror: contact and inbox ordered by their own clocks",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: {
          name: "MIRROR-ROW-CLOCKS",
          slug: `mirror-row-clocks-${process.pid}`,
        },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 17,
        baseUrl: "https://row-clocks.chat.example.com",
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

    test("a snapshot from before an attribute edit, delivered after it in the same second, does not write the old value back", async () => {
      // Both captured at last_activity_at 1791685801: the edit moved only the contact's clock.
      await mirror(onRows(contactB, { contact: 101, conv: 1101 }));
      await mirror(onRows(contactA, { contact: 101, conv: 1101 }));
      expect(await attrsOf(101)).toEqual({ plano: "prata" });
    });

    test("the same edit delivered in order is taken, not emptied as a tie", async () => {
      await mirror(onRows(contactA, { contact: 102, conv: 1102 }));
      await mirror(onRows(contactB, { contact: 102, conv: 1102 }));
      expect(await attrsOf(102)).toEqual({ plano: "prata" });
    });

    test("a clock that moved with no attribute change still fences an older state delivered after it", async () => {
      // Every incoming message bumps the contact's `updated_at` (last_activity_at) after dispatch, so
      // the same bag arrives under a newer clock; the prata in between is older than that clock.
      const ids = { contact: 103, conv: 1103 };
      await mirror(
        withContact(onRows(contactA, ids), { plano: "ouro" }, 100.1),
      );
      await mirror(
        withContact(onRows(contactB, ids), { plano: "ouro" }, 100.4),
      );
      await mirror(
        withContact(onRows(contactB, ids), { plano: "prata" }, 100.25),
      );
      expect(await attrsOf(103)).toEqual({ plano: "ouro" });
    });

    test("a newer contact snapshot carried by a quieter conversation is taken", async () => {
      // One contact, two conversations: the busy one serialized the old bag under a newer position.
      const busy = at(
        withContact(
          onRows(contactA, { contact: 104, conv: 1104 }),
          { cidade: "Recife" },
          1791682000.05,
        ),
        1791682100,
        1791682100.9,
      );
      const quiet = at(
        withContact(
          onRows(contactB, { contact: 104, conv: 1105 }),
          { cidade: "Natal" },
          1791682040.2,
        ),
        1791682050,
        1791682050.4,
      );
      await mirror(busy);
      await mirror(quiet);
      expect(await attrsOf(104)).toEqual({ cidade: "Natal" });
    });

    test("without the contact's clock a tie still goes to the last writer", async () => {
      const ids = { contact: 106, conv: 1106 };
      await mirror(
        withContact(onRows(contactB, ids), { plano: "prata" }, undefined),
      );
      await mirror(
        withContact(onRows(contactA, ids), { plano: "ouro" }, undefined),
      );
      expect(await attrsOf(106)).toEqual({ plano: "ouro" });
    });

    test("a row written before the clocks existed is ordered from the first payload carrying one", async () => {
      const ids = { contact: 107, conv: 1107 };
      // A Chatwoot without the clocks, then with them: the clockless value is replaced by position, the clock
      // stamped with it then refuses an older snapshot, and a clockless one positioned earlier still
      // loses on position.
      await mirror(
        at(
          withContact(onRows(contactA, ids), { plano: "ouro" }, undefined),
          3000,
          3000.1,
        ),
      );
      await mirror(
        at(
          withContact(onRows(contactA, ids), { plano: "prata" }, 3010.4),
          3010,
          3010.5,
        ),
      );
      await mirror(
        at(
          withContact(onRows(contactB, ids), { plano: "ouro" }, 3005),
          3010,
          3010.5,
        ),
      );
      expect(await attrsOf(107)).toEqual({ plano: "prata" });
      await mirror(
        at(
          withContact(onRows(contactB, ids), { plano: "bronze" }, undefined),
          2990,
          2990,
        ),
      );
      expect(await attrsOf(107)).toEqual({ plano: "prata" });
    });

    test("an inbox named before the clocks existed takes a clocked name only by position until it has a clock", async () => {
      const ids = { contact: 108, conv: 1108, inbox: 306 };
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Suporte", undefined), 3000, 3000.1),
      );
      // Clocked, but positioned before the clockless write: nothing says it is newer than "Suporte".
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Velho", 2500), 2990, 2990),
      );
      expect((await inboxOf(306)).name).toBe("Suporte");
      await mirror(
        at(
          withInbox(onRows(inboxN2, ids), "Atendimento", 3010.2),
          3010,
          3010.5,
        ),
      );
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Suporte", 3005), 3020, 3020.5),
      );
      expect((await inboxOf(306)).name).toBe("Atendimento");
    });

    test("a delayed delivery naming the old inbox name under a busier conversation's position does not restore it", async () => {
      // Renamed Vendas -> Comercial. The busy conversation serialized Vendas before the rename and is
      // delivered late, positioned after the quiet conversation that carried Comercial.
      const quiet = at(
        withInbox(
          onRows(inboxN2, { contact: 201, conv: 2201, inbox: 301 }),
          "Comercial",
          1791682200.5,
        ),
        1791682250,
        1791682250.1,
      );
      const busy = at(
        withInbox(
          onRows(inboxN2, { contact: 202, conv: 2202, inbox: 301 }),
          "Vendas",
          1791682000,
        ),
        1791682300,
        1791682300.9,
      );
      await mirror(quiet);
      await mirror(busy);
      expect(await inboxOf(301)).toEqual({
        name: "Comercial",
        channelType: "Channel::Api",
      });
    });

    test("a rename carried by a quieter conversation is taken", async () => {
      const busy = at(
        withInbox(
          onRows(inboxN2, { contact: 203, conv: 2203, inbox: 302 }),
          "Vendas",
          1791682000,
        ),
        1791682300,
        1791682300.9,
      );
      const quiet = at(
        withInbox(
          onRows(inboxN2, { contact: 204, conv: 2204, inbox: 302 }),
          "Comercial",
          1791682200.5,
        ),
        1791682250,
        1791682250.1,
      );
      await mirror(busy);
      await mirror(quiet);
      expect((await inboxOf(302)).name).toBe("Comercial");
      // The clock moved with the rename: a name serialized between the two versions is older still.
      const between = at(
        withInbox(
          onRows(inboxN2, { contact: 209, conv: 2209, inbox: 302 }),
          "Loja",
          1791682100,
        ),
        1791682400,
        1791682400.5,
      );
      await mirror(between);
      expect((await inboxOf(302)).name).toBe("Comercial");
    });

    test("an inbox clock that arrives without the name does not fence the name it versions", async () => {
      const ids = { contact: 213, conv: 2213, inbox: 308 };
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Suporte", 100), 500, 500.1),
      );
      const nameless = at(
        withInbox(onRows(inboxN2, ids), "x", 200),
        600,
        600.1,
      );
      delete (nameless.inbox as Body).name;
      await mirror(nameless);
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Atendimento", 200), 610, 610.1),
      );
      expect((await inboxOf(308)).name).toBe("Atendimento");
      // The same when the nameless payload creates the row: its clock is not stored over the
      // placeholder, so an older name that fills the placeholder does not inherit it.
      const fresh = { contact: 214, conv: 2214, inbox: 309 };
      const first = at(withInbox(onRows(inboxN2, fresh), "x", 200), 600, 600.1);
      delete (first.inbox as Body).name;
      await mirror(first);
      await mirror(
        at(withInbox(onRows(inboxN2, fresh), "Suporte", 150), 700, 700.1),
      );
      await mirror(
        at(withInbox(onRows(inboxN2, fresh), "Atendimento", 200), 710, 710.1),
      );
      expect((await inboxOf(309)).name).toBe("Atendimento");
    });

    test("an inbox-list sync that renames the inbox keeps a delivery older than its read from writing the old name back", async () => {
      // The list carries no inbox clock; the clock stored described the name the sync replaced.
      const ids = { contact: 210, conv: 2210, inbox: 305 };
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Suporte", 100), 500, 500.1),
      );
      await syncInboxes(
        { tenantId, userId: null, role: "TENANT_ADMIN" } as TenantContext,
        instanceId,
        {
          makeClient: async () =>
            ({
              listInboxes: async () => [
                { id: 305, name: "Renomeada", channel_type: "Channel::Api" },
              ],
            }) as unknown as ChatwootClient,
        },
        appDb,
      );
      // Serialized before the rename the sync read (clock 600 < the live one), delivered after it.
      await mirror(
        at(withInbox(onRows(inboxN2, ids), "Suporte 2", 600), 200, 200.1),
      );
      expect((await inboxOf(305)).name).toBe("Renomeada");
    });

    test("a write without a clock that replaces the values clears the clock that described the old ones", async () => {
      // Contact: clock 100 at position 500, then a clockless bag at 700, then a clocked snapshot
      // (600, newer than the stored clock) serialized before the clockless one, at 550.
      const c = { contact: 211, conv: 2211 };
      await mirror(
        at(
          withContact(onRows(contactA, c), { plano: "ouro" }, 100),
          500,
          500.1,
        ),
      );
      await mirror(
        at(
          withContact(onRows(contactA, c), { plano: "cobre" }, undefined),
          700,
          700.1,
        ),
      );
      await mirror(
        at(
          withContact(onRows(contactB, c), { plano: "prata" }, 600),
          550,
          550.1,
        ),
      );
      expect(await attrsOf(211)).toEqual({ plano: "cobre" });
      // Inbox: the same sequence with names.
      const i = { contact: 212, conv: 2212, inbox: 307 };
      await mirror(
        at(withInbox(onRows(inboxN2, i), "Suporte", 100), 500, 500.1),
      );
      await mirror(
        at(withInbox(onRows(inboxN2, i), "Vendas", undefined), 700, 700.1),
      );
      await mirror(
        at(withInbox(onRows(inboxN2, i), "Comercial", 600), 550, 550.1),
      );
      expect((await inboxOf(307)).name).toBe("Vendas");
    });

    test("a conversation event, which carries no inbox clock, does not hold back a later rename", async () => {
      // `conversation_*` bodies name the inbox only by id and channel; one positioned after the
      // rename must not turn the rename's delivery into a stale one. The first body states no channel,
      // so the conversation event has a field to fill and does write the row.
      const first = at(
        withInbox(
          onRows(inboxN2, { contact: 205, conv: 2205, inbox: 303 }),
          "Suporte",
          1791682600.1,
        ),
        1791682600,
        1791682600.2,
      );
      delete convOf(first).channel;
      await mirror(first);
      await mirror(
        at(
          onRows(contactB, { contact: 206, conv: 2206, inbox: 303 }),
          1791682700,
          1791682700.9,
        ),
      );
      await mirror(
        at(
          withInbox(
            onRows(inboxN2, { contact: 207, conv: 2207, inbox: 303 }),
            "Atendimento",
            1791682650.3,
          ),
          1791682660,
          1791682660,
        ),
      );
      expect((await inboxOf(303)).name).toBe("Atendimento");
    });

    test("a receipt repeating the stored clocks writes neither row", async () => {
      const b = onRows(inboxN2, { contact: 208, conv: 2208, inbox: 304 });
      await mirror(b);
      const xmin = () =>
        suDb.$queryRaw<{ c: string; i: string }[]>`
        SELECT (SELECT xmin::text FROM contacts WHERE tenant_id = ${tenantId} AND chatwoot_contact_id = 208) AS c,
               (SELECT xmin::text FROM inboxes WHERE tenant_id = ${tenantId} AND chatwoot_inbox_id = 304) AS i`;
      const before = await xmin();
      const receipt = clone(b);
      receipt.event = "message_updated";
      await mirror(receipt);
      expect(await xmin()).toEqual(before);
    });

    test("a payload with the contact's clock and no conversation clock is ordered by the contact's clock", async () => {
      // No position at all: the clock is the only thing to order by, and the statement must not
      // trip over the missing one.
      const ids = { contact: 109, conv: 1109 };
      const undated = (attrs: Body, clock: number) => {
        const b = withContact(onRows(contactB, ids), attrs, clock);
        delete convOf(b).last_activity_at;
        delete convOf(b).updated_at;
        return b;
      };
      await mirror(undated({ plano: "ouro" }, 500.1));
      await mirror(undated({ plano: "prata" }, 500.5));
      await mirror(undated({ plano: "ouro" }, 500.3));
      expect(await attrsOf(109)).toEqual({ plano: "prata" });
    });
  },
);
