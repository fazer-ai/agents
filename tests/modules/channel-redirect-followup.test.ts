import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  armRedirectChatFollowUp,
  chatFollowupNudge,
  deliverRedirectClosing,
  isRedirectFollowUpLive,
  minutesFromNow,
  parseRedirectFollowUpPayload,
  redirectFollowUpHandler,
  retireRedirectFollowUp,
} from "@/modules/channel-redirect/followup";
import { CHANNEL_REDIRECT_DEFAULTS } from "@/modules/channel-redirect/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type ClaimedJob,
  type enqueueJob,
  rescheduleJob,
} from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

describe("parseRedirectFollowUpPayload", () => {
  test("valid chat-stage payload", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryInboxId: 7,
      }),
    ).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: 7,
    });
  });

  // The stage advance rebuilds this payload field by field, so a state parse drops is gone from the
  // job for good — and the one it would drop is the episode the retirement reads.
  test("the episode survives the round trip in all three states", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: "9",
        originDisplayId: 6203,
      }),
    ).toMatchObject({ originDisplayId: 6203 });
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: "9",
        originDisplayId: null,
      }),
    ).toMatchObject({ originDisplayId: null });
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).not.toHaveProperty("originDisplayId");
  });

  test("valid whatsapp-stage payload with a null entryInboxId", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "whatsapp",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).toEqual({
      stage: "whatsapp",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: null,
    });
  });

  test("valid closing-stage payload", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "closing",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryInboxId: 7,
      }),
    ).toEqual({
      stage: "closing",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: 7,
    });
  });

  test("rejects a missing/invalid stage", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "bogus",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({ widgetThreadId: "1:2:3", agentId: "9" }),
    ).toBeNull();
  });

  test("rejects a missing widgetThreadId or agentId", () => {
    expect(
      parseRedirectFollowUpPayload({ stage: "chat", agentId: "9" }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
      }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: 9, // wrong type (must be a string)
      }),
    ).toBeNull();
  });
});

describe("nudge builders", () => {
  test("chatFollowupNudge carries the redirect source + kind + instructions", () => {
    const n = chatFollowupNudge("Pergunte se ainda precisa de ajuda.");
    expect(n.source).toBe("channel-redirect");
    expect(n.kind).toBe("chat-followup");
    expect(n.instructions).toBe("Pergunte se ainda precisa de ajuda.");
  });
});

describe("minutesFromNow", () => {
  test("adds N minutes to the given instant", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    expect(minutesFromNow(60, now).toISOString()).toBe(
      "2026-07-05T13:00:00.000Z",
    );
    expect(minutesFromNow(0, now).toISOString()).toBe(now.toISOString());
  });
});

describe("armRedirectChatFollowUp", () => {
  function fakeEnqueue() {
    const calls: Array<Parameters<typeof enqueueJob>[0]> = [];
    const fn = (async (p: Parameters<typeof enqueueJob>[0]) => {
      calls.push(p);
      return 1n;
    }) as typeof enqueueJob;
    return { fn, calls };
  }

  const cfg = {
    ...CHANNEL_REDIRECT_DEFAULTS,
    chatFollowupEnabled: true,
    chatFollowupDelayValue: 30,
  };
  const now = new Date("2026-07-05T12:00:00Z");

  test("enqueues a REDIRECT_FOLLOWUP stage=chat job, dedupeKey by widgetThreadId, runAt = now + delay", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      fn,
    );
    expect(armed).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.kind).toBe("REDIRECT_FOLLOWUP");
    expect(call?.dedupeKey).toBe("redirect-followup:1:2:30");
    expect(call?.runAt.toISOString()).toBe("2026-07-05T12:30:00.000Z");
    expect(call?.payload).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:30",
      agentId: "9",
      entryInboxId: 7,
    });
  });

  // Review round 12 of #355. The stamp is what lets the mirror's retirement tell the ladder it is
  // ending from the one it is starting, and both directions matter: an event that states an episode
  // must put it on the job, and an event that states none must leave the key OFF rather than write
  // a null that reads as "the cleared episode".
  test("stamps the episode the arming event stated", async () => {
    const { fn, calls } = fakeEnqueue();
    await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        originDisplayId: 6203,
        cfg,
        now,
      },
      fn,
    );
    expect(calls[0]?.payload).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:30",
      agentId: "9",
      entryInboxId: 7,
      originDisplayId: 6203,
    });
  });

  test("a stated clear is stamped as the episode it is; silence is stamped not at all", async () => {
    const cleared = fakeEnqueue();
    await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        originDisplayId: null,
        cfg,
        now,
      },
      cleared.fn,
    );
    expect(cleared.calls[0]?.payload).toMatchObject({ originDisplayId: null });

    const silent = fakeEnqueue();
    await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      silent.fn,
    );
    expect(silent.calls[0]?.payload).not.toHaveProperty("originDisplayId");
  });

  test("no-ops only when EVERY follow-up step is disabled", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg: {
          ...cfg,
          chatFollowupEnabled: false,
          waFollowupEnabled: false,
          closingEnabled: false,
        },
        now,
      },
      fn,
    );
    expect(armed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("still arms (at stage chat) when the chat step is off but a later stage is on", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg: {
          ...cfg,
          chatFollowupEnabled: false,
          waFollowupEnabled: true,
          closingEnabled: false,
        },
        now,
      },
      fn,
    );
    expect(armed).toBe(true);
    expect(calls[0]?.payload).toMatchObject({ stage: "chat" });
  });

  test("no-ops (defense in depth) when the thread's tenant/instance doesn't match — never enqueues across a tenant fence", async () => {
    const { fn, calls } = fakeEnqueue();
    const wrongTenant = await armRedirectChatFollowUp(
      {
        tenantId: 999n,
        instanceId: 2n,
        widgetThreadId: "1:2:30", // tenant 1, not 999
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      fn,
    );
    const wrongInstance = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 999n, // thread says instance 2
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        cfg,
        now,
      },
      fn,
    );
    expect(wrongTenant).toBe(false);
    expect(wrongInstance).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ── The claimed-ladder fence, DB-backed. ──────────────────────────────────────────────────────────
//
// Cancelling reaches PENDING rows only, so a ladder the worker had already claimed runs to
// completion — and this ladder's terminal stage posts a closing on BOTH conversations and resolves
// them. `retireRedirectFollowUp` stamps every row of the key, claimed ones included; the handler is
// what reads the stamp.

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

describe.skipIf(!dbUp)("a ladder retired while claimed", () => {
  let tenantId = 0n;
  let instanceId = 0n;
  let agentId = 0n;
  const WIDGET_CONV = 7171;
  const ENTRY_CONV = 7172;
  let widgetThread = "";

  const stubClient = () => {
    const sent: Array<[number, string]> = [];
    const resolved: number[] = [];
    const client = {
      getConversation: async (c: number) => ({
        id: c,
        status: "pending",
        meta: {},
      }),
      sendMessage: async (c: number, t: string) => {
        sent.push([c, t]);
        return {};
      },
      sendPrivateNote: async () => ({}),
      getConversationLabels: async () => [],
      setConversationLabels: async () => ({}),
      toggleStatus: async (c: number) => {
        resolved.push(c);
        return {};
      },
    } as unknown as ChatwootClient;
    return { sent, resolved, makeClient: async () => client };
  };

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "LAD", slug: `lad-${process.pid}` },
    });
    tenantId = t.id;
    // TEST-NET-3 on the discard port: an IP literal keeps the SSRF guard off DNS (a hostname here
    // makes every outbound call die in resolution before it can be observed), and nothing is dialed
    // because globalThis.fetch is the double below.
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: "https://203.0.113.12:9",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    widgetThread = `${tenantId}:${instanceId}:${WIDGET_CONV}`;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          channelRedirect: {
            enabled: true,
            entryInboxId: 110,
            widgetInboxId: 111,
            chatFollowupEnabled: true,
            // Stage 2 is a no-op unless it is switched on and has something to say, and a stage that
            // does nothing would pass its own fence's test without ever reaching it.
            waFollowupEnabled: true,
            waFollowupMessage: "Ainda dá tempo: {link}",
            closingEnabled: true,
            closingMessage: "Vamos encerrar por aqui.",
          },
        },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 11,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `lad-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 111,
        name: "Site",
        agentId: agent.id,
      },
    });
    // Both sides of the pair: stages 2 and 3 message the WhatsApp sibling, and stage 3 resolves both,
    // so without the entry side those stages have nothing to do and prove nothing.
    const contact = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: 991,
        name: "Cliente",
      },
    });
    const entryInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 110,
        name: "WhatsApp",
        agentId: agent.id,
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: entryInbox.id,
        contactId: contact.id,
        chatwootConversationId: ENTRY_CONV,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${ENTRY_CONV}`,
        lastEventAt: new Date(),
        lastInboundAt: new Date(),
        redirectSentAt: new Date(Date.now() - 60_000),
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        contactId: contact.id,
        chatwootConversationId: WIDGET_CONV,
        status: "pending",
        threadId: widgetThread,
        lastEventAt: new Date(),
        lastInboundAt: new Date(),
        redirectLinkedAt: new Date(Date.now() - 59_000),
      },
    });
  });

  // Stage 2 builds its OWN Chatwoot client (it is not routed through deps.makeClient), so the only
  // place to see whether it sent anything is the wire.
  const originalFetch = globalThis.fetch;
  const wire: string[] = [];
  const httpDouble = (async (input: RequestInfo | URL) => {
    const url = String(input);
    wire.push(url);
    // The widget inbox has to carry a website_url or the link cannot be built and the stage returns
    // "misconfigured" before ever reaching the fence under test.
    const body = url.includes("/redirect_tokens")
      ? { token: "tok-1", website_url: "https://loja.example" }
      : url.includes("/inboxes")
        ? { id: 111, website_url: "https://loja.example" }
        : { id: 1, payload: {} };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  });

  // The caller with no job to ask about. A widget resolve reaches the closing straight from a webhook,
  // so every `stillWanted` fence inside is one this path skips — while /reset CLEARS the at-most-once
  // anchor on purpose, so the funnel can be tested again. Between this run's claim and its sends, that
  // clear used to leave it free to post the goodbye and resolve the sibling on an episode the operator
  // had just been told was erased.
  //
  // The reset lands in exactly that window. The rendezvous is the claim re-read itself, because the
  // claim's own write holds the row until it commits: a second connection writing there first blocks
  // on the lock instead of simulating anything.
  const restoreAnchor = async () => {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { redirectClosedAt: null },
    });
  };

  // Review round 10 of #355. A timed close (`closeChat: true`) posts the goodbye on the chat and
  // resolves it BEFORE it looks the WhatsApp sibling up, and every fence past that first send is
  // deliberately skipped — half a goodbye is worse than a duplicate. So the sibling lookup is the one
  // read that happens after this run is already committed to an episode, and re-reading the pairing
  // there lets a re-entry landing inside those round trips redirect the WhatsApp half: a move sends
  // the goodbye to, and RESOLVES, the conversation the NEW episode just paired with.
  test("a re-entry during the chat close cannot move which sibling is closed", async () => {
    await restoreAnchor();
    const DECOY_CONV = 7173;
    const entry = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: ENTRY_CONV },
      select: { inboxId: true, contactId: true },
    });
    await suDb.conversation.upsert({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: DECOY_CONV,
        },
      },
      create: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: entry.inboxId,
        contactId: entry.contactId,
        chatwootConversationId: DECOY_CONV,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${DECOY_CONV}`,
        lastEventAt: new Date(Date.now() + 120_000),
        lastInboundAt: new Date(),
      },
      update: {},
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: {
        redirectOriginDisplayId: ENTRY_CONV,
        chatwootRedirectOriginAt: 1_786_000_000.5,
      },
    });

    const s = stubClient();
    const moving = {
      ...s,
      makeClient: async () => {
        const inner = await s.makeClient();
        return {
          ...inner,
          sendMessage: async (c: number, t: string) => {
            // The chat half has left. From here the run cannot stop, and this is where a second
            // redirect lands.
            if (c === WIDGET_CONV) {
              await suDb.conversation.updateMany({
                where: { tenantId, chatwootConversationId: WIDGET_CONV },
                data: {
                  redirectOriginDisplayId: DECOY_CONV,
                  chatwootRedirectOriginAt: 1_786_000_090.5,
                },
              });
            }
            return inner.sendMessage(c, t);
          },
        } as unknown as Awaited<ReturnType<typeof s.makeClient>>;
      },
    };

    try {
      await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: true,
        base: appDb,
        deps: { makeClient: moving.makeClient },
      });

      // The episode this run claimed is the one it closes, on both halves.
      expect(s.sent.map(([c]) => c)).toEqual([WIDGET_CONV, ENTRY_CONV]);
      expect(s.resolved).toEqual([WIDGET_CONV, ENTRY_CONV]);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: {
          redirectOriginDisplayId: null,
          chatwootRedirectOriginAt: null,
        },
      });
      await suDb.conversation
        .deleteMany({ where: { tenantId, chatwootConversationId: DECOY_CONV } })
        .catch(() => {});
      await restoreAnchor();
    }
  });

  test("a closing whose anchor was cleared mid-run sends nothing", async () => {
    await restoreAnchor();
    const s = stubClient();
    let claimed = false;
    let cleared = false;
    // The reset commits at the first read this run makes AFTER its claim — whichever read that is.
    // Landing it on a read rather than on the claim's own write matters: a second connection writing
    // that row while the claim holds it blocks on the lock instead of simulating anything.
    const landReset = async () => {
      if (!claimed || cleared) return;
      cleared = true;
      await restoreAnchor();
    };
    const resetMidRun = suDb.$extends({
      query: {
        conversation: {
          async updateMany({ args, query }) {
            const res = await query(args);
            const data = args.data as
              | { redirectClosedAt?: unknown }
              | undefined;
            // The CLAIM writes an instant; the release writes null.
            if (data?.redirectClosedAt instanceof Date) claimed = true;
            return res;
          },
          async count({ args, query }) {
            await landReset();
            return query(args);
          },
          async findUnique({ args, query }) {
            await landReset();
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        // The resolve path's own shape: Chatwoot is already resolving the widget, so only the
        // WhatsApp sibling is still owed a goodbye — and the sibling lookup is a read, which is what
        // gives the unfenced version somewhere to be caught.
        closeChat: false,
        base: resetMidRun,
        deps: { makeClient: s.makeClient },
      });

      expect(claimed).toBe(true);
      expect(cleared).toBe(true);
      expect(outcome).toBe("already-closed");
      expect(s.sent).toEqual([]);
      expect(s.resolved).toEqual([]);
    } finally {
      await restoreAnchor();
    }
  });

  // One read later, and it is the read that decides WHO gets the goodbye. The sibling lookup sits
  // between the claim check and the WhatsApp send, so a command landing inside it finds an answer
  // taken before it — and the closing then messages and RESOLVES a conversation on an episode the
  // operator was told had been erased. Landing it on `findFirst` is what puts it there: only the
  // sibling lookup uses that query, so the claim check (a `count`) has already passed.
  test("a closing whose anchor is cleared during the sibling lookup sends nothing", async () => {
    await restoreAnchor();
    const s = stubClient();
    let cleared = false;
    const resetOnSiblingRead = suDb.$extends({
      query: {
        conversation: {
          async findFirst({ args, query }) {
            if (!cleared) {
              cleared = true;
              await restoreAnchor();
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: false,
        base: resetOnSiblingRead,
        deps: { makeClient: s.makeClient },
      });

      expect(cleared).toBe(true);
      // The run still reports it delivered — it held the claim when it started, and the anchor is
      // not its to give back. What matters is that nothing reached the customer.
      expect(outcome).toBe("delivered");
      expect(s.sent).toEqual([]);
      expect(s.resolved).toEqual([]);
    } finally {
      await restoreAnchor();
    }
  });

  // The same window on the SCHEDULED closing, which messages the chat first. By the time the sibling
  // lookup runs the customer has already been said goodbye to and the widget resolved, so standing
  // down leaves the episode half-closed — one channel finished, the other open — and reports it as
  // delivered. A reset landing mid-delivery cannot un-send the first half; the honest completion of
  // a delivery that has started is both halves.
  test("a scheduled closing finishes the WhatsApp side even if the anchor is cleared", async () => {
    await restoreAnchor();
    const s = stubClient();
    let cleared = false;
    const resetOnSiblingRead = suDb.$extends({
      query: {
        conversation: {
          async findFirst({ args, query }) {
            if (!cleared) {
              cleared = true;
              await restoreAnchor();
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: true,
        base: resetOnSiblingRead,
        deps: { makeClient: s.makeClient },
      });

      expect(cleared).toBe(true);
      expect(outcome).toBe("delivered");
      // Both channels, not just the one that went out before the command landed.
      expect(s.sent.map(([c]) => c)).toEqual([WIDGET_CONV, ENTRY_CONV]);
      expect(s.resolved).toContain(ENTRY_CONV);
    } finally {
      await restoreAnchor();
    }
  });

  // The other ordering, and the one the anchor alone cannot see. Above, the reset lands AFTER the
  // claim and the post-claim re-read catches it. Here it lands BEFORE: the resolve trigger reaches
  // this function straight from a webhook, so it carries no `stillWanted`, and while it is loading
  // Issue #222. The closing MESSAGES and RESOLVES the conversation it picks, and it used to pick the
  // contact's most-recently-active conversation on the entry inbox. Writing into an older entry
  // conversation is enough to make it the latest, so the goodbye and the resolve land on a thread that
  // was never this episode's origin. Here the decoy is deliberately newer, and the stored pairing
  // still wins.
  test("the closing acts on the STORED origin, not the most recently active entry conversation", async () => {
    await restoreAnchor();
    const DECOY_CONV = 7173;
    const entryInboxRow = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: 110 },
      select: { id: true },
    });
    const contactRow = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: ENTRY_CONV },
      select: { contactId: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: entryInboxRow.id,
        contactId: contactRow.contactId,
        chatwootConversationId: DECOY_CONV,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${DECOY_CONV}`,
        // NEWER than the origin: the old predicate would take this one.
        lastEventAt: new Date(Date.now() + 60_000),
        lastInboundAt: new Date(),
      },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { redirectOriginDisplayId: ENTRY_CONV },
    });

    const s = stubClient();
    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: true,
        base: suDb as unknown as PrismaClient,
        deps: { makeClient: s.makeClient },
      });

      expect(outcome).toBe("delivered");
      expect(s.sent.map(([c]) => c)).toEqual([WIDGET_CONV, ENTRY_CONV]);
      expect(s.resolved).toContain(ENTRY_CONV);
      // The decoy is untouched: not messaged, and above all not resolved.
      expect(s.sent.map(([c]) => c)).not.toContain(DECOY_CONV);
      expect(s.resolved).not.toContain(DECOY_CONV);
    } finally {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { redirectOriginDisplayId: null },
      });
      await suDb.conversation.deleteMany({
        where: { tenantId, chatwootConversationId: DECOY_CONV },
      });
      await restoreAnchor();
    }
  });

  // the conversation, the agent, the bot and the client, /reset clears the anchor. The claim then
  // SUCCEEDS -- `redirectClosedAt: null` reads the same whether nobody ever closed it or the command
  // just wiped it -- and every check downstream is happy with the timestamp this run itself wrote.
  // The customer gets a goodbye on an episode the operator was told had been erased.
  test("a closing that claims a reset-cleared anchor sends nothing", async () => {
    await restoreAnchor();
    const s = stubClient();
    let reset = false;
    // Everything /reset writes to this row in one statement, which is how the command writes it too.
    const landReset = async () => {
      if (reset) return;
      reset = true;
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: {
          redirectClosedAt: null,
          redirectLinkedAt: null,
          redirectSentAt: null,
          redirectCount: 0,
          lastInboundAt: null,
        },
      });
    };
    const resetBeforeClaim = suDb.$extends({
      query: {
        conversation: {
          // The claim itself: land the command immediately before it, from another connection, so
          // this run reads the pre-reset episode and writes into the post-reset one.
          async updateMany({ args, query }) {
            const data =
              (args as { data?: Record<string, unknown> }).data ?? {};
            if (
              Object.hasOwn(data, "redirectClosedAt") &&
              data.redirectClosedAt
            )
              await landReset();
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        // The resolve trigger's own shape: the widget is already being resolved by Chatwoot.
        closeChat: false,
        base: resetBeforeClaim,
        deps: { makeClient: s.makeClient },
      });

      expect(reset).toBe(true);
      expect(outcome).toBe("already-closed");
      // Nothing reached the customer, and the sibling was not resolved either.
      expect(s.sent).toEqual([]);
      expect(s.resolved).not.toContain(ENTRY_CONV);
      // And the anchor is still free, so the funnel the reset just re-armed can close later.
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { redirectClosedAt: true },
      });
      expect(row.redirectClosedAt).toBeNull();
    } finally {
      await restoreAnchor();
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { lastInboundAt: new Date() },
      });
    }
  });

  // The hole the comparison alone leaves. If `lastInboundAt` was ALREADY null when this run read it,
  // /reset writes null too and the predicate matches straight across the command it is fencing — the
  // claim succeeds and the goodbye goes out exactly as before. Every other column the command touches
  // goes to null or to zero, so none of them closes it either. A caller with no job AND no token to
  // compare therefore does not get to claim at all.
  test("a jobless closing with no episode token does not claim", async () => {
    await restoreAnchor();
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { lastInboundAt: null },
    });
    const s = stubClient();
    let reset = false;
    const resetBeforeClaim = suDb.$extends({
      query: {
        conversation: {
          async updateMany({ args, query }) {
            const data =
              (args as { data?: Record<string, unknown> }).data ?? {};
            if (
              Object.hasOwn(data, "redirectClosedAt") &&
              data.redirectClosedAt &&
              !reset
            ) {
              reset = true;
              await suDb.conversation.updateMany({
                where: { tenantId, chatwootConversationId: WIDGET_CONV },
                data: { redirectClosedAt: null, lastInboundAt: null },
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: false,
        base: resetBeforeClaim,
        deps: { makeClient: s.makeClient },
      });

      expect(outcome).toBe("already-closed");
      expect(s.sent).toEqual([]);
      expect(s.resolved).not.toContain(ENTRY_CONV);
      // It never even reached the claim, so the reset interceptor never fired — which is the point:
      // the refusal is upstream of the write rather than a race it happens to lose.
      expect(reset).toBe(false);
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { redirectClosedAt: true },
      });
      expect(row.redirectClosedAt).toBeNull();
    } finally {
      await restoreAnchor();
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { lastInboundAt: new Date() },
      });
    }
  });

  // And the ladder, which HAS a job to ask about, is not caught by that refusal even with the same
  // null watermark: its `stillWanted` is the token. Without this the rule above could be passing by
  // refusing every closing on a quiet widget conversation.
  test("a ladder closing still delivers with no inbound watermark", async () => {
    await restoreAnchor();
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { lastInboundAt: null },
    });
    const s = stubClient();
    try {
      const outcome = await deliverRedirectClosing({
        stillWanted: async () => true,
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: false,
        base: suDb,
        deps: { makeClient: s.makeClient },
      });

      expect(outcome).toBe("delivered");
      expect(s.sent.length).toBeGreaterThan(0);
    } finally {
      await restoreAnchor();
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { lastInboundAt: new Date() },
      });
    }
  });

  // THE JOB IS ASKED AGAIN AFTER THE CLAIM READ, and that read is a database round trip. THE RULE
  // (../../src/graph/nudge.ts) is one ask per stretch of I/O that precedes a write, and never any I/O
  // between an ask and the write it guards. A /reset landing inside that round trip retires this job
  // while the claim check — which asks about the ANCHOR, not about the job — still reports this run
  // as the one delivering: the goodbye goes out and both conversations are resolved, on an episode
  // the operator was told had been erased.
  //
  // The reset is committed FROM INSIDE the claim read, through the same `$extends` query seam the
  // jobless test above uses, so the window is the real one rather than a stub flipping on a call
  // count. That is what makes this pin the ORDER: an ask moved back above the read would answer
  // before the retirement lands and send anyway.
  test("a reset landing inside the claim read stops the closing", async () => {
    await restoreAnchor();
    const s = stubClient();
    let retired = false;
    let asks = 0;
    const resetInsideClaimRead = suDb.$extends({
      query: {
        conversation: {
          async count({ args, query }) {
            // Only the claim read: it is the one that asks for a conversation still stamped with
            // this run's exact instant.
            const where =
              (args as { where?: Record<string, unknown> }).where ?? {};
            if (where.redirectClosedAt instanceof Date) retired = true;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    try {
      const outcome = await deliverRedirectClosing({
        stillWanted: async () => {
          asks += 1;
          return !retired;
        },
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: true,
        base: resetInsideClaimRead,
        deps: { makeClient: s.makeClient },
      });

      // The retirement really landed in the window, so the test is not passing on a claim it never
      // reached.
      expect(retired).toBe(true);
      expect(outcome).toBe("already-closed");
      // Nothing reached either conversation: this is the assertion the P1 was about.
      expect(s.sent).toEqual([]);
      expect(s.resolved).toEqual([]);
      // Asked once more than the two fences that precede the read, which is the ask this pins.
      expect(asks).toBe(3);
      // And the claim was handed back, so a later legitimate closing is not blocked by this run's
      // abandoned watermark.
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { redirectClosedAt: true },
      });
      expect(row.redirectClosedAt).toBeNull();
    } finally {
      await restoreAnchor();
    }
  });

  // The control: the same call with nobody clearing the anchor still delivers. Without it, "sent
  // nothing" would also be satisfied by a check that refuses every closing.
  test("the same closing delivers when the anchor stays put", async () => {
    await restoreAnchor();
    const s = stubClient();
    try {
      const outcome = await deliverRedirectClosing({
        tenantId,
        instanceId,
        widgetConversationId: WIDGET_CONV,
        entryInboxId: 110,
        closingMessage: "Vamos encerrar por aqui.",
        closeChat: false,
        base: suDb,
        deps: { makeClient: s.makeClient },
      });

      expect(outcome).toBe("delivered");
      expect(s.sent.length).toBeGreaterThan(0);
    } finally {
      await restoreAnchor();
    }
  });

  const claimed = async (
    stage: "chat" | "whatsapp" | "closing" = "chat",
    originDisplayId?: number | null,
  ): Promise<ClaimedJob> => {
    const payload = {
      stage,
      widgetThreadId: widgetThread,
      agentId: agentId.toString(),
      entryInboxId: 110,
      ...(originDisplayId !== undefined ? { originDisplayId } : {}),
    };
    const row = await suDb.schedulerJob.upsert({
      where: {
        tenantId_kind_dedupeKey: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: `redirect-followup:${widgetThread}`,
        },
      },
      create: {
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: `redirect-followup:${widgetThread}`,
        status: "CLAIMED",
        runAt: new Date(),
        payload,
      },
      update: { status: "CLAIMED", payload },
    });
    // The snapshot the worker holds: captured at claim time, before any stamp. The token comes from
    // the ROW, never a literal — a retire in an earlier test bumps it, and a hardcoded 0 would then
    // read as superseded and make every later ladder stand down for the wrong reason.
    return {
      id: row.id,
      tenantId,
      kind: "REDIRECT_FOLLOWUP",
      payload,
      attempts: 0,
      claimSeq: row.claimSeq,
    };
  };

  const deps = () => ({
    makeModel: () => new FakeListChatModel({ responses: ["Ainda por aí?"] }),
    checkpointer: new MemorySaver(),
    persistUsage: async () => {},
  });

  // Issue #281. The chat stage is the only one of the three that needs the agent to author anything,
  // and it used to advance regardless: an agent that could not answer at all still cost the lead its
  // softest stage, moving them one step closer to the closing with nothing sent.
  async function withUnresolvableCredential<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { modelConfig: true },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: "vault:999999999",
        },
      },
    });
    try {
      return await fn();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { modelConfig: before.modelConfig ?? {} },
      });
    }
  }

  // Review round 12 of #355. Every reschedule here rebuilds the payload field by field, so the
  // episode stamp the retirement reads has to be listed on each one or the ladder loses it at the
  // first stage advance — and a ladder with no stamp reads as the PREVIOUS episode's, which is
  // exactly the job the next pairing change retires.
  test("a stage advance carries the episode stamp forward", async () => {
    const job = await claimed("chat", 6203);
    const s = stubClient();

    const result = await withUnresolvableCredential(() =>
      redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      }),
    );

    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      expect(result.payload).toMatchObject({ originDisplayId: 6203 });
    }

    // And the ordinary escalation, which is a different reschedule with a payload of its own. Driven
    // by switching stage 1 OFF rather than by letting it run: the advance is what is under test, and
    // a real model turn behind it would only add a way for this to fail for another reason.
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { settings: true },
    });
    const settings = before.settings as {
      channelRedirect: Record<string, unknown>;
    };
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          ...settings,
          channelRedirect: {
            ...settings.channelRedirect,
            chatFollowupEnabled: false,
          },
        },
      },
    });
    try {
      const escalated = await redirectFollowUpHandler(
        await claimed("chat", 6203),
        appDb,
        deps(),
      );
      expect(escalated.outcome).toBe("reschedule");
      if (escalated.outcome === "reschedule") {
        expect(escalated.payload).toMatchObject({
          stage: "whatsapp",
          originDisplayId: 6203,
        });
      }
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: before.settings ?? {} },
      });
    }
  });

  test("a chat stage whose agent cannot author retries the stage instead of escalating", async () => {
    const job = await claimed("chat");
    const s = stubClient();

    const result = await withUnresolvableCredential(() =>
      redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      }),
    );

    expect(result.outcome).toBe("reschedule");
    if (result.outcome === "reschedule") {
      // Still `chat`: "whatsapp" here is the escalation this stage never earned.
      expect(result.payload).toMatchObject({
        stage: "chat",
        nudgeRetries: 1,
      });
    }
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  test("stands down instead of chasing the lead", async () => {
    const job = await claimed();
    await retireRedirectFollowUp(tenantId, widgetThread, appDb);
    const s = stubClient();

    const result = await redirectFollowUpHandler(job, appDb, {
      ...deps(),
      makeClient: s.makeClient,
    });

    // Not just "no message": a retired ladder must not advance either, or the next stage — the one
    // that resolves BOTH conversations — is simply postponed.
    expect(result).toEqual({ outcome: "done" });
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  // AND THE SAME WINDOW WITH THE DATABASE GONE, which is the pair the incident actually reported:
  // a /reset, and a pool too exhausted to answer whether it happened. The lenient probe answers "not
  // retired" to an unreadable row — right for a send it must not abandon halfway, wrong here, because
  // the ask inside the thread's critical section runs BEFORE the divider and the checkpoint. Guessing
  // there writes the memory back after the operator was told it was cleared, and no later fence
  // catches it. `runAgentNudge` marks that one ask `{ strict: true }`, and this callback has to carry
  // it through: the liveness half stays fail-open, the retirement half stops failing open.
  test("a retirement read that fails after the reset does not write the memory back", async () => {
    const job = await claimed();
    let reads = 0;
    const failing = appDb.$extends({
      query: {
        schedulerJob: {
          async findUnique({ args, query }) {
            reads += 1;
            // The first answer is the one the handler takes before any work: it has to succeed and
            // say "still wanted", or the run stands down for the wrong reason and proves nothing.
            if (reads === 1) {
              const res = await query(args);
              await retireRedirectFollowUp(tenantId, widgetThread, appDb);
              return res;
            }
            throw new Error(
              "Timed out fetching a new connection from the pool",
            );
          },
        },
      },
    }) as unknown as PrismaClient;
    const s = stubClient();

    await redirectFollowUpHandler(job, failing, {
      ...deps(),
      makeClient: s.makeClient,
    }).catch(() => {
      // The strict ask propagates, and the scheduler's own bounded retry is what carries the job.
      // Whether it surfaces as a throw or a stand-down is the handler's business; what this test is
      // about is the line below.
    });

    // Nothing left, and nothing was written back over the reset.
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  // The window INSIDE the stage. The ladder advances by replacing the row's payload, which would
  // wipe the very stamp that retires it — so a /reset landing mid-stage would be undone by the stage
  // it interrupted, and the ladder would go on to its closing. The rendezvous is the fence's own
  // read: the retire runs right after the first answer, which is where the stage's work sits.
  test("a retire that lands mid-stage does not get undone by the reschedule", async () => {
    const job = await claimed();
    let reads = 0;
    const racing = appDb.$extends({
      query: {
        schedulerJob: {
          async findUnique({ args, query }) {
            const res = await query(args);
            reads += 1;
            if (reads === 1) {
              await retireRedirectFollowUp(tenantId, widgetThread, appDb);
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;
    const s = stubClient();

    const result = await redirectFollowUpHandler(job, racing, {
      ...deps(),
      makeClient: s.makeClient,
    });

    // Ended, not advanced — and the stamp is still on the row, so a later claim would stand down too.
    expect(result).toEqual({ outcome: "done" });
    // Nor did the stage's own nudge slip out while it was being generated.
    expect(s.sent).toEqual([]);
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
      select: { payload: true },
    });
    expect((row.payload as { cancelledAt?: string })?.cancelledAt).toBeString();
  });

  // A re-arm after the retire wipes the stamp — enqueueJob replaces the payload wholesale — so the
  // stamp alone would let this run come back to life because the lead replied. The claim token
  // survives that rewrite, and a token that moved says the same thing: superseded.
  test("a re-arm after the retire does not revive the run it stopped", async () => {
    const job = await claimed("closing");
    await retireRedirectFollowUp(tenantId, widgetThread, appDb);
    // What a reply does: same row, fresh payload, no cancelledAt.
    await suDb.schedulerJob.updateMany({
      where: {
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: `redirect-followup:${widgetThread}`,
      },
      data: {
        status: "PENDING",
        payload: { stage: "chat", widgetThreadId: widgetThread },
      },
    });
    const s = stubClient();

    await redirectFollowUpHandler(job, appDb, {
      ...deps(),
      makeClient: s.makeClient,
    });

    // The stale run stays down: nothing sent, nothing resolved.
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  // The last boundary the handler does not own: its RETURN. Whatever it decides, the worker is what
  // writes it, and a stamp landing in that gap would be overwritten by a reschedule that replaces
  // the payload — re-arming the very stage the stamp stopped. Retiring bumps the claim token, so
  // the three writes that finish a job (they all CAS on it) find themselves superseded.
  test("a reschedule written after the retire lands on nothing", async () => {
    const job = await claimed("chat");
    await retireRedirectFollowUp(tenantId, widgetThread, appDb);

    const res = await rescheduleJob(
      tenantId,
      job.id,
      job.claimSeq,
      new Date(Date.now() + 60_000),
      { stage: "closing", widgetThreadId: widgetThread },
      appDb,
    );

    expect(res.applied).toBe(false);
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "REDIRECT_FOLLOWUP" },
      select: { status: true, payload: true },
    });
    // Terminal and tombstoned: the ladder did not come back as PENDING with a clean payload, and it
    // is not left CLAIMED either — a row nobody can finish and nobody can reclaim sits wedged until
    // the stale-job sweep records a failure that never happened.
    expect(row.status).toBe("DONE");
    expect((row.payload as { cancelledAt?: string })?.cancelledAt).toBeString();
  });

  // The two stages that send FIXED text rather than a nudge, so the nudge's own `stillWanted` never
  // reaches them. Each is asked immediately before its send, and each crosses channels: the WhatsApp
  // stage messages the sibling, the closing messages BOTH and resolves BOTH. The rendezvous is the
  // fence's own read — the retire lands right after the handler's first answer, which is where the
  // config load and the sibling lookup sit.
  const racingDb = (afterRead: () => Promise<void>, nth = 1) => {
    let reads = 0;
    return appDb.$extends({
      query: {
        schedulerJob: {
          async findUnique({ args, query }) {
            const res = await query(args);
            reads += 1;
            if (reads === nth) await afterRead();
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;
  };
  const retireNow = async () => {
    await retireRedirectFollowUp(tenantId, widgetThread, appDb);
  };

  test("a retire mid-stage stops the WhatsApp escalation", async () => {
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    try {
      await redirectFollowUpHandler(
        job,
        racingDb(async () => {
          await retireRedirectFollowUp(tenantId, widgetThread, appDb);
        }),
        { ...deps(), makeClient: s.makeClient },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Nothing left for the sibling: not the link mint, not the message.
    expect(wire).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  // One call deeper. The stage's own fence answered before the sibling lookup and the token mint,
  // which are round trips of their own — so the send routine asks again with nothing yet sent. The
  // rendezvous is the stage's read: the retire lands right after it, which is where those trips sit.
  test("a retire during the link mint stops the WhatsApp send", async () => {
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    try {
      await redirectFollowUpHandler(job, racingDb(retireNow, 2), {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The mint may have happened; the message must not have.
    expect(wire.some((u) => u.includes("/messages"))).toBe(false);
  });

  // And the closing, which is the one that resolves both conversations. Its fence sits with the
  // at-most-once claim, after the reads: a ladder retired mid-read must not burn an anchor on a
  // closing it then refuses to deliver, or the funnel could never close again.
  test("a retire during the closing's own reads stops it, anchor untouched", async () => {
    const job = await claimed("closing");
    const s = stubClient();
    // The retire lands right after the STAGE's fence answered, which is the window the closing's own
    // fence exists to cover.
    await redirectFollowUpHandler(job, racingDb(retireNow, 2), {
      ...deps(),
      makeClient: s.makeClient,
    });
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
    // The anchor is untouched, so the funnel can still close properly later.
    const widget = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      select: { redirectClosedAt: true },
    });
    expect(widget.redirectClosedAt).toBeNull();
  });

  // The window the CLAIM itself opens: it is a write, so the answer taken before it predates it. The
  // rendezvous is the closing's own fence read — the retire lands right after it answers, which is
  // exactly where the claim sits.
  test("a retire during the claim stops the closing and frees the anchor", async () => {
    const job = await claimed("closing");
    const s = stubClient();
    await redirectFollowUpHandler(job, racingDb(retireNow, 3), {
      ...deps(),
      makeClient: s.makeClient,
    });

    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
    // Released: an anchor left set on a closing nobody delivered is a funnel that can never close.
    const widget = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      select: { redirectClosedAt: true },
    });
    expect(widget.redirectClosedAt).toBeNull();
  });

  // The control: the same stage, un-retired, does reach the wire — otherwise the assertion above
  // would pass on a stage that never does anything.
  test("an un-retired WhatsApp stage does escalate", async () => {
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    try {
      await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Specifically: it posts. Asserting only that SOMETHING hit the wire would let a stage that
    // merely mints a link stand in for one that messages the customer.
    expect(wire.some((u) => u.includes("/messages"))).toBe(true);
  });

  // The gate the predicate above describes, asked where it is actually consumed. The stage's own
  // control sits right above: with the agent enabled it posts, so a run that posts nothing here is
  // the switch and not a stage that never does anything. Deleting the handler's call to
  // `isRedirectFollowUpLive` leaves every predicate test green, which is why this one exists.
  const withAgentDisabled = async (run: () => Promise<void>) => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: false },
    });
    try {
      await run();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
  };

  test("a switched-off agent does not re-send the WhatsApp link", async () => {
    await withAgentDisabled(async () => {
      const job = await claimed("whatsapp");
      const s = stubClient();
      wire.length = 0;
      globalThis.fetch = httpDouble;
      try {
        const result = await redirectFollowUpHandler(job, appDb, {
          ...deps(),
          makeClient: s.makeClient,
        });
        // Dropped, not advanced: rescheduling would only postpone the closing, which messages and
        // resolves BOTH conversations.
        expect(result).toEqual({ outcome: "done" });
      } finally {
        globalThis.fetch = originalFetch;
      }
      // Nothing on the wire at all — not even the link mint, which happens before the send and costs
      // a Chatwoot round trip on a lead this agent is not allowed to chase.
      expect(wire).toEqual([]);
      expect(s.sent).toEqual([]);
    });
  });

  test("a switched-off agent does not post the closing, nor resolve", async () => {
    await withAgentDisabled(async () => {
      const job = await claimed("closing");
      const s = stubClient();
      const result = await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      });
      expect(result).toEqual({ outcome: "done" });
      expect(s.sent).toEqual([]);
      expect(s.resolved).toEqual([]);
    });
  });

  // ── Issue #246: the gate answers at handler entry and the stages send later, across I/O of their
  //    own. These pin what the ladder does when the switch flips INSIDE that window, which is the
  //    moment an operator watching a lead being chased is likeliest to reach for it.
  test("switched off during the link mint sends nothing AND does not advance", async () => {
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      wire.push(url);
      if (url.includes("/redirect_tokens")) {
        await suDb.agent.update({
          where: { id: agentId },
          data: { enabled: false },
        });
      }
      const body = url.includes("/redirect_tokens")
        ? { token: "tok-246", website_url: "https://loja.example" }
        : url.includes("/inboxes")
          ? { id: 111, website_url: "https://loja.example" }
          : { id: 1, payload: {} };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    let result: Awaited<ReturnType<typeof redirectFollowUpHandler>>;
    try {
      result = await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
    // The mint happened, so this is the window and not a stage that stopped earlier.
    expect(wire.some((u) => u.includes("/redirect_tokens"))).toBe(true);
    expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
    // And the ladder ENDS. Rescheduling would arm the closing on a stood-down episode: re-enable the
    // agent before that delay expires and it messages and resolves both conversations, with no fresh
    // inbound behind it.
    expect(result).toEqual({ outcome: "done" });
  });

  test("switched off while the closing reads sends nothing and frees the anchor", async () => {
    const job = await claimed("closing");
    const s = stubClient();
    // The rendezvous is the closing's own first read: everything after it — the bot, the client, the
    // sibling — is I/O this run does while holding an answer it took before.
    let reads = 0;
    const flipping = appDb.$extends({
      query: {
        conversation: {
          async findUnique({ args, query }) {
            const res = await query(args);
            reads += 1;
            if (reads === 1) {
              await suDb.agent.update({
                where: { id: agentId },
                data: { enabled: false },
              });
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      await redirectFollowUpHandler(job, flipping, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
    // Released, not burned: the at-most-once anchor left set on a closing nobody delivered is a
    // funnel that can never close.
    const widget = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      select: { redirectClosedAt: true },
    });
    expect(widget.redirectClosedAt).toBeNull();
  });

  // The other half of the rule, and the one a fence gets wrong silently: an answer that could not be
  // READ is not a refusal. `jobRetired` makes the same call for the same reason — an unknown answer
  // must not drop work that was legitimately armed — so a database blip during the mint costs a
  // follow-up the customer should have received.
  test("a liveness read that fails does not stand the ladder down", async () => {
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    // Only the liveness re-read fails: it asks for `enabled` + `mode` alone, while the handler's own
    // load at the top takes `settings` with them. A blanket failure would prove nothing, since every
    // read on the path would be down — including the one that decides whether to run at all.
    const failing = appDb.$extends({
      query: {
        agent: {
          async findUnique({ args, query }) {
            const sel = args.select as Record<string, unknown> | undefined;
            if (
              sel?.enabled === true &&
              sel?.mode === true &&
              sel?.settings === undefined
            ) {
              throw new Error("liveness read is down");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      await redirectFollowUpHandler(job, failing, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(wire.some((u) => u.includes("/messages"))).toBe(true);
  });

  // The widest window in the ladder: the nudge's config load is fail-closed on `enabled`, but the
  // model turn runs after it and the post comes after that. A switch flipped mid-turn has to reach
  // the send, or the chat follow-up goes out from an agent that is already off — and with no later
  // stage enabled, nothing downstream would ever notice.
  test("switched off during the model turn posts no chat follow-up", async () => {
    const job = await claimed("chat");
    const s = stubClient();
    // The rendezvous is the nudge's own config load: it is the read that selects the prompt, and the
    // model turn is what happens next.
    const flipping = appDb.$extends({
      query: {
        agent: {
          async findUnique({ args, query }) {
            const res = await query(args);
            const sel = args.select as Record<string, unknown> | undefined;
            if (sel?.systemPrompt === true) {
              await suDb.agent.update({
                where: { id: agentId },
                data: { enabled: false },
              });
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      await redirectFollowUpHandler(job, flipping, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
    expect(s.sent).toEqual([]);
  });

  // Fail-open covers an answer nobody could READ, never one already in hand. A disabled agent is
  // conclusive before the activation lookup runs, and that lookup is the fallible part: let the fence
  // reach it and a failed read turns a switched-off agent back into a send.
  test("a disabled test agent stands down even if the stamp read fails", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: true, mode: "test" },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { testActivatedAt: new Date() },
    });
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    // Both rendezvous on the same column. The handler's own load reads it first — the switch flips
    // right after, so the run gets past the entry gate — and the FENCE's read is the one that fails.
    let stampReads = 0;
    const failingStamp = appDb.$extends({
      query: {
        conversation: {
          async findUnique({ args, query }) {
            const sel = args.select as Record<string, unknown> | undefined;
            if (sel?.testActivatedAt !== true) return query(args);
            stampReads += 1;
            if (stampReads > 1) throw new Error("activation lookup is down");
            const res = await query(args);
            await suDb.agent.update({
              where: { id: agentId },
              data: { enabled: false },
            });
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      await redirectFollowUpHandler(job, failingStamp, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true, mode: "production" },
      });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { testActivatedAt: null },
      });
    }
    // One read, the handler's own: the fence answered from `enabled` and never reached the fallible
    // one. Drop the short-circuit and this becomes two — the read throws, the catch answers "go", and
    // the link goes out from an agent that is already off.
    expect(stampReads).toBe(1);
    expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  // The two questions fail differently on purpose. A stamp read nobody could complete means unknown
  // LIVENESS, which is live — but it must not swallow the retirement question with it. The closing is
  // where that matters: its stage-level check runs once at the top, and every fence after it is the
  // composite one, so if a failed stamp read answered "go" a /reset landing mid-run would be carried
  // straight past the tombstone.
  test("a failed stamp read does not carry a retired closing past the tombstone", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: true, mode: "test" },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { testActivatedAt: new Date(), redirectClosedAt: null },
    });
    const job = await claimed("closing");
    const s = stubClient();
    // The /reset lands on the closing's OWN first read — past the stage's retirement check, so the
    // fence is the only thing left that can see it — and the fence's stamp read is the one that fails.
    let stampReads = 0;
    let retiredMidRun = false;
    const retiringThenFailing = appDb.$extends({
      query: {
        conversation: {
          async findUnique({ args, query }) {
            const sel = args.select as Record<string, unknown> | undefined;
            if (sel?.testActivatedAt === true) {
              stampReads += 1;
              if (stampReads > 1) throw new Error("activation lookup is down");
              return query(args);
            }
            const res = await query(args);
            if (sel?.lastInboundAt === true && !retiredMidRun) {
              retiredMidRun = true;
              await retireRedirectFollowUp(tenantId, widgetThread, appDb);
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      await redirectFollowUpHandler(job, retiringThenFailing, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        data: { testActivatedAt: null },
      });
    }
    // The reset really landed mid-run, so this is the window and not a run that stopped earlier.
    // `stampReads` stays at 1: the fence answers "retired" before it ever reaches the fallible read,
    // which is the ordering this pins. Move the retirement read back after the stamp read and the
    // double's throw reaches the outer catch, the fence answers "go", and the closing goes out.
    //
    // What the double CANNOT reproduce is a query PostgreSQL rejects: it throws in JS before any SQL
    // runs, so the transaction is never left aborted. That case is why the ordering exists rather
    // than a catch — with a real abort, every later statement in the transaction fails too — and it
    // is argued in the code, not covered here.
    expect(retiredMidRun).toBe(true);
    expect(stampReads).toBe(1);
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  // The fence's own read can fail, and when it does the liveness half is unknown — which is live. The
  // retirement half is not allowed to be unknown with it: an aborted transaction cannot answer it, so
  // it is asked again on a fresh one. A /reset that landed mid-run must not be overtaken by a
  // question added on top of it.
  test("a failed fence read still sees a retired ladder", async () => {
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    // The fence's agent read is the one that fails — it asks for `enabled` + `mode` alone, while the
    // handler's own load at the top takes `settings` with them — and the /reset lands just before it.
    let retiredMidRun = false;
    const failingFence = appDb.$extends({
      query: {
        agent: {
          async findUnique({ args, query }) {
            const sel = args.select as Record<string, unknown> | undefined;
            if (
              sel?.enabled === true &&
              sel?.mode === true &&
              sel?.settings === undefined
            ) {
              if (!retiredMidRun) {
                retiredMidRun = true;
                await retireRedirectFollowUp(tenantId, widgetThread, appDb);
              }
              throw new Error("fence read is down");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    try {
      await redirectFollowUpHandler(job, failingFence, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(retiredMidRun).toBe(true);
    expect(wire.filter((u) => u.includes("/messages"))).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  // Advancing is a decision too. A stage can end without ever reaching its own fence — the sibling
  // lookup finds nobody, the link cannot be minted, or the chat stage simply finishes — and arming
  // the next stage there points a closing at an episode the agent is no longer allowed to touch:
  // re-enable it before that delay expires and it messages and resolves BOTH conversations.
  test("switched off mid-stage does not arm the next stage", async () => {
    const job = await claimed("chat");
    // The rendezvous is the chat stage's own send: the follow-up goes out, and the operator switches
    // the agent off right after reading it. Everything the ladder does from there — arming the next
    // stage included — happens under an answer that is already false.
    const flipOnSend = () => {
      const sent: Array<[number, string]> = [];
      const client = {
        getConversation: async (c: number) => ({
          id: c,
          status: "pending",
          meta: {},
        }),
        sendMessage: async (c: number, t: string) => {
          sent.push([c, t]);
          await suDb.agent.update({
            where: { id: agentId },
            data: { enabled: false },
          });
          return {};
        },
        sendPrivateNote: async () => ({}),
        getConversationLabels: async () => [],
        setConversationLabels: async () => ({}),
        toggleStatus: async () => ({}),
      } as unknown as ChatwootClient;
      return { sent, makeClient: async () => client };
    };
    const s2 = flipOnSend();
    let result: Awaited<ReturnType<typeof redirectFollowUpHandler>>;
    try {
      result = await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s2.makeClient,
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: true },
      });
    }
    // The stage really ran, so this is the advance being fenced and not a handler that stopped early.
    expect(s2.sent).toHaveLength(1);
    expect(result).toEqual({ outcome: "done" });
  });

  test("a retire mid-stage stops the closing, and the resolve with it", async () => {
    const job = await claimed("closing");
    const s = stubClient();
    await redirectFollowUpHandler(job, racingDb(retireNow), {
      ...deps(),
      makeClient: s.makeClient,
    });
    expect(s.sent).toEqual([]);
    expect(s.resolved).toEqual([]);
  });

  test("an un-retired ladder still runs", async () => {
    const job = await claimed();
    const s = stubClient();

    await redirectFollowUpHandler(job, appDb, {
      ...deps(),
      makeClient: s.makeClient,
    });

    // The control the negative above needs: a fence that stood every ladder down would pass it.
    expect(s.sent.map(([c]) => c)).toEqual([WIDGET_CONV]);
  });

  // ── The episode's activation, not the row's ──────────────────────────────────────────────────────
  // A redirect episode is TWO conversations of one person, and `/teste` stamps only the one it was
  // typed in. The bridge between them (`shouldPropagateTestMode`) runs ONCE, at link time, WhatsApp →
  // widget — so an activation that lands after the link, or on the other side, leaves the two halves
  // disagreeing about a question that has one answer per PERSON: the operator activated the agent,
  // not a channel. The ladder then judges every send by the WIDGET row, including the two stages whose
  // destination is the WhatsApp conversation.
  const setStamps = async (widget: Date | null, entry: Date | null) => {
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: WIDGET_CONV },
      data: { testActivatedAt: widget, redirectClosedAt: null },
    });
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: ENTRY_CONV },
      data: { testActivatedAt: entry },
    });
  };
  const restoreProduction = async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: true, mode: "production" },
    });
    await setStamps(null, null);
  };
  const asTestAgent = async (widget: Date | null, entry: Date | null) => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { enabled: true, mode: "test" },
    });
    await setStamps(widget, entry);
  };

  // `/teste` typed on WhatsApp AFTER the link: the entry row carries the stamp, the widget row does
  // not, and the one-shot propagation is already spent. Stage 2's destination IS the entry
  // conversation — the activated one — so the ladder goes mute on the very channel that was activated.
  test("stage 2 sends when the activation is on the side it messages", async () => {
    await asTestAgent(null, new Date());
    const job = await claimed("whatsapp");
    const s = stubClient();
    wire.length = 0;
    globalThis.fetch = httpDouble;
    try {
      await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      globalThis.fetch = originalFetch;
      await restoreProduction();
    }
    expect(wire.filter((u) => u.includes("/messages"))).toHaveLength(1);
  });

  // The same activation, one stage earlier. Stage 1 messages the WIDGET, so this is the half of the
  // episode whose own row is unstamped — and it still has to speak, because the person who typed
  // `/teste` on WhatsApp is the person now sitting in this chat.
  test("stage 1 nudges when the activation is on the sibling", async () => {
    await asTestAgent(null, new Date());
    const job = await claimed();
    const s = stubClient();
    try {
      await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      await restoreProduction();
    }
    expect(s.sent.map(([c]) => c)).toEqual([WIDGET_CONV]);
  });

  // The control both need: with NEITHER side stamped the episode is not activated, and the ladder
  // stays silent. Without this, an implementation that simply stopped asking would pass the two above.
  test("an episode with no activation anywhere stays silent", async () => {
    await asTestAgent(null, null);
    const job = await claimed();
    const s = stubClient();
    try {
      await redirectFollowUpHandler(job, appDb, {
        ...deps(),
        makeClient: s.makeClient,
      });
    } finally {
      await restoreProduction();
    }
    expect(s.sent).toEqual([]);
  });
});

describe("isRedirectFollowUpLive", () => {
  const live = {
    agentEnabled: true,
    agentMode: "production",
    testActivatedAt: null,
  };

  test("a production agent that is enabled keeps the ladder running", () => {
    expect(isRedirectFollowUpLive(live)).toBe(true);
  });

  test("a disabled agent delivers nothing, in any mode", () => {
    expect(isRedirectFollowUpLive({ ...live, agentEnabled: false })).toBe(
      false,
    );
    expect(
      isRedirectFollowUpLive({
        ...live,
        agentEnabled: false,
        agentMode: "test",
        testActivatedAt: new Date("2026-01-01"),
      }),
    ).toBe(false);
  });

  test("a test agent is silent until the widget conversation gets a /teste", () => {
    expect(isRedirectFollowUpLive({ ...live, agentMode: "test" })).toBe(false);
    expect(
      isRedirectFollowUpLive({
        ...live,
        agentMode: "test",
        testActivatedAt: new Date("2026-01-01"),
      }),
    ).toBe(true);
  });

  test("an activation stamp never revives a production agent that is off", () => {
    expect(
      isRedirectFollowUpLive({
        ...live,
        agentEnabled: false,
        testActivatedAt: new Date("2026-01-01"),
      }),
    ).toBe(false);
  });
});
