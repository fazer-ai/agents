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
  ): Promise<ClaimedJob> => {
    const payload = {
      stage,
      widgetThreadId: widgetThread,
      agentId: agentId.toString(),
      entryInboxId: 110,
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
});
