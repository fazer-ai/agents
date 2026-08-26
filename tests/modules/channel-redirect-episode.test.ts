import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn } from "@/lib/tenancy";
import {
  episodeOriginQuery,
  episodeTestActivatedAt,
  hasStoredOrigin,
  needsEpisodeLookup,
  redirectSide,
} from "@/modules/channel-redirect/episode";
import {
  CHANNEL_REDIRECT_DEFAULTS,
  type ChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import { seedChatwootInstance } from "../utils/chatwoot";

const ENTRY_INBOX = 210;
const WIDGET_INBOX = 211;

const cfg: ChannelRedirectConfig = {
  ...CHANNEL_REDIRECT_DEFAULTS,
  enabled: true,
  entryInboxId: ENTRY_INBOX,
  widgetInboxId: WIDGET_INBOX,
};

describe("redirectSide", () => {
  test("names the half a conversation is by its inbox", () => {
    expect(redirectSide(cfg, ENTRY_INBOX)).toBe("entry");
    expect(redirectSide(cfg, WIDGET_INBOX)).toBe("widget");
  });

  test("an inbox outside the pair is not part of an episode", () => {
    expect(redirectSide(cfg, 999)).toBeNull();
    expect(redirectSide(cfg, null)).toBeNull();
  });

  // The feature switched off makes every conversation a plain one, whatever the inbox ids still say.
  // This is what keeps a deployment that never used the redirect from paying for a sibling read.
  test("a disabled redirect has no sides at all", () => {
    expect(redirectSide({ ...cfg, enabled: false }, ENTRY_INBOX)).toBeNull();
  });

  test("a half that is not provisioned yet is not a side", () => {
    expect(
      redirectSide({ ...cfg, widgetInboxId: null }, WIDGET_INBOX),
    ).toBeNull(
      // Null must not match a null inbox id either — the guard is on the id, not on the pairing.
    );
    expect(redirectSide({ ...cfg, entryInboxId: null }, null)).toBeNull();
  });
});

// Each row is a reason NOT to touch the database, and the reactive gate runs on every inbound
// message, so this is the predicate that keeps that path free.
// Issue #222. WHICH conversation is the entry half is the one question the cross-link and the ladder
// share, and the ladder's closing RESOLVES the row it names — so a decision table, not a fixture.
describe("episodeOriginQuery", () => {
  const base = {
    tenantId: 1n,
    instanceId: 7n,
    entryInboxId: ENTRY_INBOX,
  };

  // Review round 6 of #355. Two different facts arrive as the same stored null, and only one of them
  // means "ask the old predicate". `chatwootRedirectOriginAt` is what separates them: it is set the
  // first time the fork speaks about this conversation, whatever it says.
  test("a STATED clear has no sibling: it is an answer, not a gap", () => {
    const q = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: 1_786_000_000.5,
        redirectOriginDisplayId: null,
        contactId: 9n,
      },
    });
    // Not a recency fallback. The source said this episode has no WhatsApp half, and the consumers
    // of this answer MESSAGE and RESOLVE what it names.
    expect(q).toBeNull();
  });

  test("never having been told still falls back to recency", () => {
    const q = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: null,
        contactId: 9n,
      },
    });
    expect(q?.by).toBe("recency");
  });

  // A stated pairing is the answer whether or not we hold a mark for it — a Chatwoot too old to send
  // `updated_at` writes the value and stamps nothing.
  test("a stored pairing with no mark is still the answer", () => {
    const q = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: 41,
        contactId: 9n,
      },
    });
    expect(q?.by).toBe("stored");
  });

  test("a stored pairing IS the answer: looked up by id, with no ordering to lose it", () => {
    const q = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: 41,
        contactId: 9n,
      },
    });
    expect(q?.by).toBe("stored");
    expect(q?.where).toEqual({
      chatwootInstanceId: 7n,
      chatwootConversationId: 41,
    });
    // No orderBy: one row answers, so there is nothing to rank — which is the whole point.
    expect(q?.orderBy).toBeUndefined();
    // And the contact is not part of the question, so a merge that moved it cannot change the answer.
    expect(Object.keys(q?.where ?? {})).not.toContain("contactId");
  });

  test("the stored pairing wins even when a newer entry conversation exists", () => {
    // Same inputs as the fallback case below, plus the fact. The fact is what changes the answer.
    const stored = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: 41,
        contactId: 9n,
      },
    });
    const inferred = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: null,
        contactId: 9n,
      },
    });
    expect(stored?.by).toBe("stored");
    expect(inferred?.by).toBe("recency");
    expect(stored?.where).not.toEqual(inferred?.where);
  });

  test("no stored pairing falls back to the old most-recently-active predicate", () => {
    const q = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: null,
        contactId: 9n,
      },
    });
    expect(q?.by).toBe("recency");
    expect(q?.where).toEqual({
      chatwootInstanceId: 7n,
      contactId: 9n,
      inbox: { chatwootInboxId: ENTRY_INBOX },
    });
    expect(q?.orderBy).toEqual({ lastEventAt: "desc" });
  });

  test("no pairing and no contact ⇒ nothing to look up at all", () => {
    expect(
      episodeOriginQuery({
        ...base,
        widget: {
          chatwootRedirectOriginAt: null,
          redirectOriginDisplayId: null,
          contactId: null,
        },
      }),
    ).toBeNull();
  });

  // A contactless widget row still answers when the pairing is stored: the fact does not need the
  // contact, and refusing there would strand exactly the episodes this change exists to pair.
  test("a stored pairing answers even with no contact on the row", () => {
    const q = episodeOriginQuery({
      ...base,
      widget: {
        chatwootRedirectOriginAt: null,
        redirectOriginDisplayId: 41,
        contactId: null,
      },
    });
    expect(q?.by).toBe("stored");
  });
});

describe("hasStoredOrigin", () => {
  test("separates a fact from an inference", () => {
    expect(hasStoredOrigin(41)).toBe(true);
    expect(hasStoredOrigin(null)).toBe(false);
  });
});

describe("needsEpisodeLookup", () => {
  const base = {
    agentMode: "test",
    ownTestActivatedAt: null,
    side: "widget" as const,
  };

  test("asks only when all three hold", () => {
    expect(needsEpisodeLookup(base)).toBe(true);
  });

  test("a production agent has no activation question", () => {
    expect(needsEpisodeLookup({ ...base, agentMode: "production" })).toBe(
      false,
    );
  });

  // A stamped row is the whole answer: the episode is activated as soon as EITHER half is, so no
  // sibling can overturn it. Reading one would be a query whose result cannot change the outcome.
  test("a row already stamped is the answer", () => {
    expect(
      needsEpisodeLookup({ ...base, ownTestActivatedAt: new Date() }),
    ).toBe(false);
  });

  test("a conversation outside an episode has no sibling to ask", () => {
    expect(needsEpisodeLookup({ ...base, side: null })).toBe(false);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.TEST_MIGRATION_DATABASE_URL;
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

describe.skipIf(!dbUp)("episodeTestActivatedAt", () => {
  let tenantId = 0n;
  let instanceId = 0n;
  let contactId: bigint | null = null;
  const ENTRY_CONV = 8101;
  const WIDGET_CONV = 8102;
  // A SECOND conversation of the same contact on the entry inbox, more recent than the first. The
  // pairing this module inherits picks among these, and the ordering rule below is what stops a
  // newer unstamped row from hiding the activation.
  const ENTRY_CONV_NEWER = 8103;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "EPI", slug: `epi-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 21,
      baseUrl: "https://203.0.113.21:9",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: { tenantId, name: "A", systemPrompt: "x", mode: "test" },
    });
    const entryInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ENTRY_INBOX,
        name: "WhatsApp",
        agentId: agent.id,
      },
    });
    const widgetInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: WIDGET_INBOX,
        name: "Site",
        agentId: agent.id,
      },
    });
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: 8100,
        name: "Cliente",
      },
    });
    contactId = contact.id;
    for (const [conv, inboxId, lastEventAt] of [
      [ENTRY_CONV, entryInbox.id, new Date(Date.now() - 60_000)],
      [ENTRY_CONV_NEWER, entryInbox.id, new Date()],
      [WIDGET_CONV, widgetInbox.id, new Date()],
    ] as const) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId,
          contactId: contact.id,
          chatwootConversationId: conv,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${conv}`,
          lastEventAt,
        },
      });
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  });

  const stampEntry = async (conv: number, at: Date | null) => {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: conv },
      data: { testActivatedAt: at },
    });
  };
  const clearEntries = async () => {
    await stampEntry(ENTRY_CONV, null);
    await stampEntry(ENTRY_CONV_NEWER, null);
  };
  const askFromWidget = (
    own: Date | null,
    over: Partial<Parameters<typeof episodeTestActivatedAt>[0]> = {},
  ) =>
    episodeTestActivatedAt({
      tenantId,
      instanceId,
      cfg,
      agentMode: "test",
      conv: {
        testActivatedAt: own,
        contactId,
        chatwootInboxId: WIDGET_INBOX,
      },
      base: appDb,
      ...over,
    });

  test("an unstamped widget inherits the entry side's activation", async () => {
    const at = new Date("2026-08-20T10:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    try {
      expect((await askFromWidget(null))?.toISOString()).toBe(at.toISOString());
    } finally {
      await clearEntries();
    }
  });

  // The other direction, which the link-time propagation has never covered: `/teste` typed in the
  // chat is the same person saying the same thing.
  test("an unstamped entry inherits the widget side's activation", async () => {
    const at = new Date("2026-08-20T11:00:00Z");
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { testActivatedAt: at },
    });
    try {
      const got = await episodeTestActivatedAt({
        tenantId,
        instanceId,
        cfg,
        agentMode: "test",
        conv: {
          testActivatedAt: null,
          contactId,
          chatwootInboxId: ENTRY_INBOX,
        },
        base: appDb,
      });
      expect(got?.toISOString()).toBe(at.toISOString());
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { testActivatedAt: null },
      });
    }
  });

  // The ordering rule, and the only test that can fail if it is dropped: the NEWER entry conversation
  // is unstamped and the older one carries the activation. Picked by recency — which is how the
  // destination is picked — this answers null and the episode reads as never activated.
  test("an activation on an older sibling is not hidden by a newer unstamped one", async () => {
    const at = new Date("2026-08-20T12:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    await stampEntry(ENTRY_CONV_NEWER, null);
    try {
      expect((await askFromWidget(null))?.toISOString()).toBe(at.toISOString());
    } finally {
      await clearEntries();
    }
  });

  test("no activation anywhere in the episode answers null", async () => {
    expect(await askFromWidget(null)).toBeNull();
  });

  test("a row that carries its own stamp answers with it", async () => {
    const own = new Date("2026-08-20T09:00:00Z");
    expect((await askFromWidget(own))?.toISOString()).toBe(own.toISOString());
  });

  // A production agent is never silenced, so the question does not arise and the row's own value —
  // whatever it is — comes straight back.
  test("a production agent never asks", async () => {
    const at = new Date("2026-08-20T13:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    try {
      expect(await askFromWidget(null, { agentMode: "production" })).toBeNull();
    } finally {
      await clearEntries();
    }
  });

  test("a conversation outside the pair never asks", async () => {
    const at = new Date("2026-08-20T14:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    try {
      expect(
        await askFromWidget(null, {
          conv: { testActivatedAt: null, contactId, chatwootInboxId: 999 },
        }),
      ).toBeNull();
    } finally {
      await clearEntries();
    }
  });

  // A contactless conversation has no pairing to follow, so there is nothing to inherit.
  test("a conversation with no contact answers with its own value", async () => {
    const at = new Date("2026-08-20T15:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    try {
      expect(
        await askFromWidget(null, {
          conv: {
            testActivatedAt: null,
            contactId: null,
            chatwootInboxId: WIDGET_INBOX,
          },
        }),
      ).toBeNull();
    } finally {
      await clearEntries();
    }
  });

  // The failure direction, and it is the OPPOSITE of the ladder's liveness fence. There an unknown
  // answer means "send anyway", because the cost is a follow-up the customer should have had. Here an
  // unknown answer means silence, because the cost is a test agent messaging a real lead — and it is
  // exactly the behaviour this call replaced, so a failed read can lose the fix, never invent a
  // refusal.
  // The reason this module takes the caller's connection at all, measured rather than argued. Every
  // call site asks from inside a scoped transaction, and `runScopedOn` PINS a pooled connection for
  // the length of it — the ladder's fences hold an advisory lock in that same transaction. A sibling
  // read that opens its OWN asks a pinned pool for a second connection, and `DB_POOL_MAX=1` is a
  // supported setting.
  //
  // What makes that worth a test rather than a comment is the failure being SILENT. The read is
  // swallowed as "no activation" (the test above), so on that setting the agent goes straight back
  // to judging by the row alone: the very defect this module exists to fix, reintroduced by the
  // connection it asked on, with nothing failing anywhere to say so.
  test("the sibling read answers inside a pinned transaction, on a pool of one", async () => {
    const at = new Date("2026-08-20T17:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    const onePool = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl as string, max: 1 }),
    });
    try {
      const answers = await runScopedOn(
        onePool,
        { tenantId, userId: null, role: "TENANT_ADMIN" } as never,
        async (scoped) => ({
          // Handed the transaction's own connection: reads the sibling and sees the activation.
          shared: await askFromWidget(null, { base: onePool, scoped }),
          // Opening its own from in here is the bug, and the swallow turns it into "not activated".
          own: await askFromWidget(null, { base: onePool }),
        }),
      );
      expect(answers.shared?.toISOString()).toBe(at.toISOString());
      expect(answers.own).toBeNull();
    } finally {
      await onePool.$disconnect();
      await clearEntries();
    }
  });

  test("a sibling read that fails leaves the row's own answer standing", async () => {
    const at = new Date("2026-08-20T16:00:00Z");
    await stampEntry(ENTRY_CONV, at);
    const failing = appDb.$extends({
      query: {
        conversation: {
          async findFirst() {
            throw new Error("sibling read is down");
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      expect(await askFromWidget(null, { base: failing })).toBeNull();
    } finally {
      await clearEntries();
    }
  });
});
