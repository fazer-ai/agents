import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { deliverRedirectClosing } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

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

const WIDGET_CONV = 501;
let tenantId = 0n;
let instanceId = 0n;

function stubClient() {
  const statuses: Array<[number, string]> = [];
  const client = {
    sendMessage: async () => ({}),
    toggleStatus: async (c: number, s: string) => {
      statuses.push([c, s]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { statuses, makeClient: async () => client };
}

// The redirect ladder's closing stage resolves the conversation the episode moved AWAY from. That is
// housekeeping, not an outcome the agent decided, and before the origin was recorded it landed in
// the dashboard's Resolution funnel exactly like a real resolution.
describe.skipIf(!dbUp)("the redirect closing records its own origin", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "REDIR", slug: `redir-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 31,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 41,
        name: "Site",
        agentId: agent.id,
        channelType: "Channel::WebWidget",
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: WIDGET_CONV,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${WIDGET_CONV}`,
        lastInboundAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the widget conversation it closes is not credited to the agent", async () => {
    const s = stubClient();
    const outcome = await deliverRedirectClosing({
      tenantId,
      instanceId,
      widgetConversationId: WIDGET_CONV,
      // No sibling seeded: the entry inbox has no conversation, so only the widget is closed, which
      // is the half this test is about.
      entryInboxId: 99,
      closingMessage: "Até logo!",
      closeChat: true,
      base: appDb,
      deps: { makeClient: s.makeClient },
    });
    expect(outcome).toBe("delivered");
    expect(s.statuses).toEqual([[WIDGET_CONV, "resolved"]]);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      select: { resolvedBy: true },
    });
    expect(row.resolvedBy).toBe("redirect_closing");
  });

  // The OTHER conversation the closing stage touches: the WhatsApp sibling on the entry inbox. It
  // takes the same path and needs the same two halves recorded, and the floor is the one the
  // sibling lookup read — the version this close was decided against, not the row's at write time.
  test("the WhatsApp sibling it closes records the same origin, with its floor", async () => {
    const SIBLING_CONV = 8802;
    const SIBLING_AT = 1_700_300_000.25;
    // Its own widget row: the one above is already resolved by the previous test, and the closing
    // stage answers "already-closed" before it reaches the sibling.
    const WIDGET_CONV_2 = 502;
    const contact = await suDb.contact.create({
      // Scoped by instance: a Chatwoot contact id is unique inside one account.
      data: { tenantId, chatwootInstanceId: instanceId, chatwootContactId: 77 },
    });
    const widgetInbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: 41 },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: widgetInbox.id,
        contactId: contact.id,
        chatwootConversationId: WIDGET_CONV_2,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${WIDGET_CONV_2}`,
        lastInboundAt: new Date(),
        redirectLinkedAt: new Date(Date.now() - 59_000),
      },
    });
    const waInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 42,
        name: "WhatsApp",
        channelType: "Channel::Whatsapp",
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: waInbox.id,
        contactId: contact.id,
        chatwootConversationId: SIBLING_CONV,
        status: "open",
        chatwootStatusAt: SIBLING_AT,
        threadId: `${tenantId}:${instanceId}:${SIBLING_CONV}`,
        lastInboundAt: new Date(),
        redirectSentAt: new Date(Date.now() - 60_000),
      },
    });
    const s = stubClient();
    const outcome = await deliverRedirectClosing({
      tenantId,
      instanceId,
      widgetConversationId: WIDGET_CONV_2,
      entryInboxId: 42,
      closingMessage: "Até logo!",
      closeChat: false,
      base: appDb,
      deps: { makeClient: s.makeClient },
    });
    expect(outcome).toBe("delivered");
    expect(s.statuses).toEqual([[SIBLING_CONV, "resolved"]]);
    const row = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: SIBLING_CONV },
      select: { resolvedBy: true, resolvedByAt: true },
    });
    expect(row.resolvedBy).toBe("redirect_closing");
    expect(row.resolvedByAt).toBe(SIBLING_AT);
  });
});

// The OTHER way the redirect's goodbye reaches a customer: not the ladder's timed closing stage, but
// a resolve on the widget conversation, which the receiver turns into a closing on the WhatsApp
// sibling. It sends fixed text with no nudge behind it, so the agent's own switch is asked here or
// nowhere (issue #219). The real receiver is driven, because the gate lives on that wiring and a call
// to `deliverRedirectClosing` would skip the very code under test.
describe.skipIf(!dbUp)(
  "a resolve-triggered closing asks the agent's switch",
  () => {
    let tid = 0n;
    let iid = 0n;
    let agent = 0n;
    const WIDGET = 5501;
    const SIBLING = 5502;
    const WIDGET_INBOX = 51;
    const ENTRY_INBOX = 50;
    let seq = 0;

    const originalFetch = globalThis.fetch;
    const wire: string[] = [];
    const httpDouble = (async (input: RequestInfo | URL) => {
      wire.push(String(input));
      return new Response(JSON.stringify({ id: 1, payload: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "RCLOSE", slug: `rclose-${process.pid}` },
      });
      tid = t.id;
      // An IP literal on the discard port: the SSRF guard never reaches DNS, and nothing is dialed
      // because fetch is the double above.
      const inst = await seedChatwootInstance(suDb, {
        tenantId: tid,
        accountId: 32,
        baseUrl: "https://203.0.113.13:9",
        adminToken: encryptJson("ADMIN"),
      });
      iid = inst.id;
      const a = await suDb.agent.create({
        data: {
          tenantId: tid,
          name: "Atendente",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {
            channelRedirect: {
              enabled: true,
              entryInboxId: ENTRY_INBOX,
              widgetInboxId: WIDGET_INBOX,
              closingEnabled: true,
              closingMessage: "Vamos encerrar por aqui.",
            },
          },
        },
      });
      agent = a.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          agentId: agent,
          chatwootAgentBotId: 12,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `rclose-${process.pid}`,
          name: "Atendente",
        },
      });
      const widgetInbox = await suDb.inbox.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          chatwootInboxId: WIDGET_INBOX,
          name: "Site",
          agentId: agent,
          channelType: "Channel::WebWidget",
        },
      });
      const entryInbox = await suDb.inbox.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          chatwootInboxId: ENTRY_INBOX,
          name: "WhatsApp",
          agentId: agent,
        },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          chatwootContactId: 992,
          name: "Cliente",
        },
      });
      await suDb.conversation.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          inboxId: entryInbox.id,
          contactId: contact.id,
          chatwootConversationId: SIBLING,
          status: "pending",
          threadId: `${tid}:${iid}:${SIBLING}`,
          lastEventAt: new Date(),
          lastInboundAt: new Date(),
          redirectSentAt: new Date(Date.now() - 60_000),
        },
      });
      await suDb.conversation.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          inboxId: widgetInbox.id,
          contactId: contact.id,
          chatwootConversationId: WIDGET,
          status: "pending",
          threadId: `${tid}:${iid}:${WIDGET}`,
          lastEventAt: new Date(),
          lastInboundAt: new Date(),
          redirectLinkedAt: new Date(Date.now() - 59_000),
        },
      });
    });

    afterAll(async () => {
      globalThis.fetch = originalFetch;
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tid } }).catch(() => {});
    });

    // The widget conversation transitions pending -> resolved, which is the trigger the receiver reads.
    const resolveWidget = async (db: PrismaClient = appDb) => {
      seq += 1;
      const n = normalizeChatwootEvent({
        event: "conversation_resolved",
        id: WIDGET,
        inbox_id: WIDGET_INBOX,
        status: "resolved",
        contact_inbox: { id: 77_000 + seq },
        meta: { assignee_type: null, assignee: null },
        channel: "Channel::WebWidget",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Date.now() / 1000,
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId: tid,
          chatwootInstanceId: iid,
          deliveryId: `rclose-${process.pid}-${seq}`,
          event: "conversation_resolved",
          status: "PENDING",
        },
        select: { id: true },
      });
      wire.length = 0;
      globalThis.fetch = httpDouble;
      try {
        await processChatwootDelivery({
          tenantId: tid,
          instanceId: iid,
          deliveryRowId: delivery.id,
          agentBotId: 12,
          normalized: n,
          base: db,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    };

    // Back to pending, and the at-most-once anchor cleared: the closing is CAS-guarded per conversation,
    // so without this the second run would answer "already-closed" and prove nothing.
    const rearm = async () => {
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: WIDGET },
        data: { status: "pending", redirectClosedAt: null },
      });
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: SIBLING },
        data: { status: "pending", redirectClosedAt: null },
      });
    };

    // Review round 9 of #355, and it is round 7's fix read back. The mark is a VERSION: it advances
    // on every payload that states the pairing, the ones that state the SAME pairing included. Used
    // as an equality token it turns any ordinary webhook arriving mid-run into "the episode moved",
    // and on this path that is permanent — the ladder is already cancelled, so the resolve trigger is
    // the only closing this episode will ever get.
    test("an ordinary same-origin update does not cost the closing its claim", async () => {
      await rearm();
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: WIDGET },
        data: {
          redirectOriginDisplayId: SIBLING,
          chatwootRedirectOriginAt: 1_786_000_000.5,
        },
      });
      const bumping = appDb.$extends({
        query: {
          conversation: {
            async findUnique({ args, query }) {
              const res = await query(args);
              const sel = args.select as Record<string, unknown> | undefined;
              if (sel?.chatwootStatusAt && sel?.lastInboundAt && sel?.inbox) {
                // Same origin, newer version: the shape of every retried or ordinary delivery.
                await suDb.conversation.updateMany({
                  where: { tenantId: tid, chatwootConversationId: WIDGET },
                  data: { chatwootRedirectOriginAt: 1_786_000_090.5 },
                });
              }
              return res;
            },
          },
        },
      }) as unknown as PrismaClient;
      try {
        await resolveWidget(bumping);
        // The episode never changed, so the goodbye goes out and the anchor is spent.
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          select: { redirectClosedAt: true },
        });
        expect(widget.redirectClosedAt).not.toBeNull();
        expect(
          wire.filter((u) => u.includes(`/conversations/${SIBLING}/messages`)),
        ).not.toEqual([]);
      } finally {
        await suDb.conversation.updateMany({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          data: {
            redirectOriginDisplayId: null,
            chatwootRedirectOriginAt: null,
          },
        });
      }
    });

    // Review round 7 of #355, and the same question one state deeper. A closing that starts from
    // `(origin=null, mark=null)` resolved its sibling through the recency fallback; a stated clear
    // landing under it makes that answer wrong, and the claim compares only the origin, so both
    // nulls match and the goodbye goes out on a thread the source just disowned.
    test("a stated clear landing under the closing stops the claim", async () => {
      await rearm();
      const flipping = appDb.$extends({
        query: {
          conversation: {
            async findUnique({ args, query }) {
              const res = await query(args);
              const sel = args.select as Record<string, unknown> | undefined;
              if (sel?.chatwootStatusAt && sel?.lastInboundAt && sel?.inbox) {
                await suDb.conversation.updateMany({
                  where: { tenantId: tid, chatwootConversationId: WIDGET },
                  data: { chatwootRedirectOriginAt: 1_786_000_000.5 },
                });
              }
              return res;
            },
          },
        },
      }) as unknown as PrismaClient;
      try {
        await resolveWidget(flipping);
        expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          select: { redirectClosedAt: true },
        });
        expect(widget.redirectClosedAt).toBeNull();
      } finally {
        await suDb.conversation.updateMany({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          data: { chatwootRedirectOriginAt: null },
        });
      }
    });

    // Review round 6 of #355, and the effect rather than the decision table. A STATED clear reaches
    // this consumer as a stored null, which is also what "the fork never spoke about this
    // conversation" looks like — and the old predicate answers the second one. Read as a gap it
    // hands the closing the contact's most recent WhatsApp thread and that thread gets a goodbye and
    // a resolve, on an episode the source said has no WhatsApp half at all.
    test("a stated clear leaves the closing with no sibling to post on", async () => {
      await rearm();
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: WIDGET },
        data: {
          redirectOriginDisplayId: null,
          // The mark is the whole difference: we have been told, and the answer was "none".
          chatwootRedirectOriginAt: 1_786_000_000.5,
        },
      });
      try {
        await resolveWidget();
        // The sibling exists and recency would have found it. Nothing is posted on it.
        expect(
          wire.filter((u) => u.includes(`/conversations/${SIBLING}/`)),
        ).toEqual([]);
      } finally {
        await suDb.conversation.updateMany({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          data: { chatwootRedirectOriginAt: null },
        });
      }
    });

    // Review round 5 of #355. The closing RESOLVES the WhatsApp conversation it names, and on this
    // path there is no job to ask about — the resolve webhook enters it directly — so the claim CAS is
    // the only thing standing between a run that read one episode and a conversation that is now in
    // another. The pairing is read at the top and the claim is written after the agent read, the bot
    // load and the client build; a re-entry accepted in that window re-points the episode, and a
    // goodbye sent afterwards resolves a thread this conversation is no longer paired with.
    test("the pairing moving under the closing stops the claim", async () => {
      await rearm();
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: WIDGET },
        data: { redirectOriginDisplayId: SIBLING },
      });
      // The rendezvous is the closing's OWN read of the widget conversation — identified by the
      // select only it makes — so the flip lands strictly between that read and the claim.
      const flipping = appDb.$extends({
        query: {
          conversation: {
            async findUnique({ args, query }) {
              const res = await query(args);
              const sel = args.select as Record<string, unknown> | undefined;
              if (sel?.chatwootStatusAt && sel?.lastInboundAt && sel?.inbox) {
                await suDb.conversation.updateMany({
                  where: { tenantId: tid, chatwootConversationId: WIDGET },
                  data: { redirectOriginDisplayId: SIBLING + 100 },
                });
              }
              return res;
            },
          },
        },
      }) as unknown as PrismaClient;
      try {
        await resolveWidget(flipping);
        expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          select: { redirectClosedAt: true },
        });
        // Not burned either: the episode that is current now still gets its own goodbye.
        expect(widget.redirectClosedAt).toBeNull();
      } finally {
        await suDb.conversation.updateMany({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          data: { redirectOriginDisplayId: null },
        });
      }
    });

    test("a switched-off agent posts no goodbye on the sibling", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: false },
      });
      await rearm();
      await resolveWidget();
      expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
      const sibling = await suDb.conversation.findFirstOrThrow({
        where: { tenantId: tid, chatwootConversationId: SIBLING },
        select: { redirectClosedAt: true },
      });
      // The at-most-once anchor is untouched, so the closing is still available if the agent comes back.
      expect(sibling.redirectClosedAt).toBeNull();
    });

    // The other half of the same predicate, and the branch that decides whether the stamp is even
    // read: a test agent whose widget conversation was never activated with /teste is silent here too.
    test("a test agent nobody activated posts no goodbye either", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: true, mode: "test" },
      });
      await rearm();
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: WIDGET },
        data: { testActivatedAt: null },
      });
      try {
        await resolveWidget();
        expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agent },
          data: { mode: "production" },
        });
      }
    });

    // Issue #249: the activation the operator gave is on the OTHER half of the episode. This gate's
    // own conversation is the widget, but what it protects is a message to the WhatsApp SIBLING
    // (`closeChat: false`) — the conversation that carries the stamp. Judged by the widget row alone
    // it reads as "never activated" and the goodbye is dropped on an episode that is activated, on
    // the very channel it would have messaged.
    test("a test agent activated on the sibling still posts the goodbye", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: true, mode: "test" },
      });
      await rearm();
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: WIDGET },
        data: { testActivatedAt: null },
      });
      await suDb.conversation.updateMany({
        where: { tenantId: tid, chatwootConversationId: SIBLING },
        data: { testActivatedAt: new Date() },
      });
      try {
        await resolveWidget();
        expect(wire.filter((u) => u.includes("/messages"))).not.toEqual([]);
      } finally {
        await suDb.agent.update({
          where: { id: agent },
          data: { mode: "production" },
        });
        await suDb.conversation.updateMany({
          where: { tenantId: tid, chatwootConversationId: SIBLING },
          data: { testActivatedAt: null },
        });
      }
    });

    // Issue #246: the runtime is read, and then compaction arming, the ladder cancel and the closing's
    // own reads all run before anything is posted. The switch is re-asked from inside for that window.
    test("switched off while the closing reads posts nothing", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: true },
      });
      await rearm();
      // The rendezvous is the receiver's OWN agent read — the one that answers the gate. The switch
      // flips the instant after it returns, so the gate sees a live agent and everything the closing
      // does afterwards (the sibling lookup, the client build, its own reads) happens under an answer
      // that is already false.
      let reads = 0;
      const flipping = appDb.$extends({
        query: {
          agent: {
            async findUnique({ args, query }) {
              const res = await query(args);
              reads += 1;
              if (reads === 1) {
                await suDb.agent.update({
                  where: { id: agent },
                  data: { enabled: false },
                });
              }
              return res;
            },
          },
        },
      }) as unknown as PrismaClient;
      try {
        await resolveWidget(flipping);
        expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          select: { redirectClosedAt: true },
        });
        // Released rather than burned: the anchor is what makes the closing at-most-once, and a
        // stand-down is not a delivery.
        expect(widget.redirectClosedAt).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agent },
          data: { enabled: true },
        });
      }
    });

    // The stretch the gate at the top cannot cover on this path: with `closeChat: false` nothing has
    // been said when the fence answers, and the sibling lookup is a round trip in front of the only
    // send the resolve trigger makes.
    test("switched off during the sibling lookup posts nothing", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: true },
      });
      await rearm();
      let flipped = false;
      const flipping = appDb.$extends({
        query: {
          conversation: {
            async findFirst({ args, query }) {
              const res = await query(args);
              if (!flipped) {
                flipped = true;
                await suDb.agent.update({
                  where: { id: agent },
                  data: { enabled: false },
                });
              }
              return res;
            },
          },
        },
      }) as unknown as PrismaClient;
      try {
        await resolveWidget(flipping);
        // The lookup really ran, so this is the window and not a path that stopped earlier.
        expect(flipped).toBe(true);
        expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
        // And the anchor is handed back. A stand-down that keeps it burns the at-most-once mark on a
        // goodbye nobody delivered, which is a funnel that can never close.
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          select: { redirectClosedAt: true },
        });
        expect(widget.redirectClosedAt).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agent },
          data: { enabled: true },
        });
      }
    });

    // Which of the two questions is asked LAST is a decision, and this is the case that shows it: the
    // switch flips from inside the watermark count itself, so a fence asked before it would answer
    // "go" and the goodbye would go out. A stale watermark costs a duplicate goodbye in a race the
    // CAS already makes rare; a stale fence costs a message from an agent the operator switched off.
    test("switched off from inside the watermark check posts nothing", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: true },
      });
      await rearm();
      let claimReads = 0;
      const flipping = appDb.$extends({
        query: {
          conversation: {
            async count({ args, query }) {
              const where =
                (args as { where?: Record<string, unknown> }).where ?? {};
              const res = await query(args);
              // The SECOND claim read: this function checks the watermark once before its sends and
              // again inside the sibling branch, and only the second one is the round trip the fence
              // is being ordered against. Flipping on the first would be caught by the fence that
              // follows it, and the ordering would go untested.
              if (where.redirectClosedAt instanceof Date) {
                claimReads += 1;
              }
              if (claimReads === 2) {
                await suDb.agent.update({
                  where: { id: agent },
                  data: { enabled: false },
                });
              }
              return res;
            },
          },
        },
      }) as unknown as PrismaClient;
      try {
        await resolveWidget(flipping);
        expect(claimReads).toBeGreaterThanOrEqual(2);
        expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
        const widget = await suDb.conversation.findFirstOrThrow({
          where: { tenantId: tid, chatwootConversationId: WIDGET },
          select: { redirectClosedAt: true },
        });
        expect(widget.redirectClosedAt).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agent },
          data: { enabled: true },
        });
      }
    });

    // The control: the same resolve, agent on, does reach the customer — otherwise the assertion above
    // would pass on a path that never delivers anything.
    test("the same resolve with the agent on does post it", async () => {
      await suDb.agent.update({
        where: { id: agent },
        data: { enabled: true },
      });
      await rearm();
      await resolveWidget();
      expect(wire.some((u) => u.includes("/messages"))).toBe(true);
    });
  },
);
