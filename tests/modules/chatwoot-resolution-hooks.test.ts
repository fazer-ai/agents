import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import type { TenantContext } from "@/lib/tenancy";
import { followUpDedupeKey } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { withdrawClaim } from "@/modules/chatwoot/human-takeover";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import { recoverStrandedDelivery } from "@/modules/chatwoot/recover-delivery";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { setConversationStatus } from "@/modules/conversations/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// The hooks a transition to `resolved` owes (memory compaction, the redirect ladder's cancel) run from
// whichever write moved the mirror's status first. A webhook mirrored after that write finds the
// status already `resolved` and sees no transition, so a write that applies the resolve and does not
// run them loses them for good. Each case drives one such write, then the resolve's own webhook, and
// reads the scheduler rows.

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

const INBOX_ID = 63;
const CONTACT_INBOX_BASE = 63_000;
const AGENT_BOT_ID = 19;
// Seconds, in the past, so a live read stamped "now" by the recovery is never older than the row.
const T0 = Math.floor(Date.now() / 1000) - 3600;
let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let inboxRowId = 0n;
let deliverySeq = 0;
let nextConvId = 1500;

const realFetch = globalThis.fetch;

const sysCtx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)(
  "resolution hooks run from the write that resolved",
  () => {
    beforeAll(async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof globalThis.fetch;
      const t = await suDb.tenant.create({
        data: { name: "RHK", slug: `rhk-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 63,
        baseUrl: "https://chat.rhk.example",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          // The widget side of a redirect, closing off: the cancel is what is read, and a closing would
          // be a send this file has no sibling for.
          settings: {
            debounce: { enabled: false },
            channelRedirect: {
              enabled: true,
              widgetInboxId: INBOX_ID,
              entryInboxId: 64,
              closingEnabled: false,
            },
          },
        },
      });
      agentId = agent.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: AGENT_BOT_ID,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `rhk-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_ID,
          name: "Widget",
          agentId,
        },
      });
      inboxRowId = inbox.id;
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      if (!dbUp) return;
      for (const table of [
        "outbound_events",
        "audit_logs",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "flow_logs",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "chatwoot_instances",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    async function seedRow(
      over: {
        status?: string;
        chatwootStatusAt?: number | null;
        statusClaimUntil?: Date | null;
      } = {},
    ) {
      const convId = nextConvId++;
      const row = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
          status: over.status ?? "pending",
          inboxId: inboxRowId,
          contactInboxId: CONTACT_INBOX_BASE + convId,
          threadId: chatwootThreadId(tenantId, instanceId, convId),
          lastEventAt: new Date(T0 * 1000),
          chatwootStatusAt: over.chatwootStatusAt ?? null,
          statusClaimUntil: over.statusClaimUntil ?? null,
        },
        select: { id: true },
      });
      // The redirect ladder the resolve is supposed to call off.
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: followUpDedupeKey(
            chatwootThreadId(tenantId, instanceId, convId),
          ),
          status: "PENDING",
          runAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      return { convId, rowId: row.id };
    }

    async function compactionJobs(convId: number) {
      return suDb.schedulerJob.findMany({
        where: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(
            tenantId,
            instanceId,
            CONTACT_INBOX_BASE + convId,
          ),
        },
        select: { runAt: true, payload: true },
      });
    }

    async function ladder(convId: number) {
      const job = await suDb.schedulerJob.findFirstOrThrow({
        where: {
          tenantId,
          kind: "REDIRECT_FOLLOWUP",
          dedupeKey: followUpDedupeKey(
            chatwootThreadId(tenantId, instanceId, convId),
          ),
        },
        select: { status: true },
      });
      return job.status;
    }

    async function status(convId: number) {
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: convId },
        select: { status: true },
      });
      return row.status;
    }

    // The resolve's own webhook, the event that would have run the hooks had it applied the transition.
    async function resolveWebhook(convId: number, version: number) {
      deliverySeq += 1;
      const n = normalizeChatwootEvent({
        event: "conversation_status_changed",
        id: convId,
        inbox_id: INBOX_ID,
        status: "resolved",
        contact_inbox: { id: CONTACT_INBOX_BASE + convId },
        meta: { assignee_type: null, assignee: null },
        channel: "Channel::WebWidget",
        last_activity_at: Math.floor(version),
        updated_at: version,
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `rhk-${process.pid}-${deliverySeq}`,
          event: "conversation_status_changed",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: AGENT_BOT_ID,
        normalized: n,
        base: appDb,
      });
    }

    function reconcile(convId: number, version: number | null) {
      return reconcileMirrorFromLive({
        tenantId,
        instanceId,
        conversationId: convId,
        live: {
          status: "resolved",
          assigneeType: null,
          assigneeId: null,
          assigneeName: null,
          assigneeStated: true,
          lastActivityAt: new Date(T0 * 1000 + 60_000),
          updatedAt: version,
        } as never,
        base: appDb,
      });
    }

    // Owed exactly once: armed by the write that resolved, and the resolve's webhook after it re-arms
    // nothing. The armed row's `runAt` is moved to a sentinel first, because a re-arm rewrites it.
    async function expectHooksRanOnce(convId: number) {
      const armed = await compactionJobs(convId);
      expect(armed).toHaveLength(1);
      expect(armed[0]?.payload).toMatchObject({ reason: "resolved" });
      expect(await ladder(convId)).not.toBe("PENDING");
      const sentinel = new Date("2099-01-01T00:00:00Z");
      await suDb.schedulerJob.updateMany({
        where: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(
            tenantId,
            instanceId,
            CONTACT_INBOX_BASE + convId,
          ),
        },
        data: { runAt: sentinel },
      });
      await resolveWebhook(convId, T0 + 120.5);
      const after = await compactionJobs(convId);
      expect(after.map((j) => j.runAt.getTime())).toEqual([sentinel.getTime()]);
    }

    test("a live resolve the reconcile applies runs the hooks, once", async () => {
      const { convId } = await seedRow();
      const result = await reconcile(convId, T0 + 60.5);
      expect(result.applied).toBe(true);
      expect(await status(convId)).toBe("resolved");
      await expectHooksRanOnce(convId);
    });

    test("a reconcile that finds the row already resolved runs nothing", async () => {
      const { convId } = await seedRow({ status: "resolved" });
      await reconcile(convId, T0 + 60.5);
      expect(await compactionJobs(convId)).toHaveLength(0);
      expect(await ladder(convId)).toBe("PENDING");
    });

    test("a live resolve outranked by a newer stored status runs nothing", async () => {
      const { convId } = await seedRow({ chatwootStatusAt: T0 + 90.5 });
      const result = await reconcile(convId, T0 + 60.5);
      expect(result.outrankedByVersion).toBe(true);
      expect(await status(convId)).toBe("pending");
      expect(await compactionJobs(convId)).toHaveLength(0);
      expect(await ladder(convId)).toBe("PENDING");
    });

    test("the recovery's reconcile applying a resolve runs the hooks, once", async () => {
      const { convId } = await seedRow();
      const messageId = 63_901;
      deliverySeq += 1;
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `rhk-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "DEAD",
          receivedAt: new Date(Date.now() - 60 * 60_000),
          claimedAt: new Date(Date.now() - 60 * 60_000),
          attempts: 0,
          conversationId: convId,
          inboundMessageId: messageId,
        },
        select: { id: true },
      });
      const client = {
        getConversation: async (id: number) => ({
          id,
          status: "resolved",
          inbox_id: INBOX_ID,
          last_activity_at: T0 + 60,
          timestamp: T0 + 60,
          updated_at: T0 + 60.5,
          meta: { assignee: null, sender: { id: 77, name: "Cliente" } },
        }),
        getMessages: async () => ({
          payload: [
            {
              id: messageId,
              content: "oi",
              message_type: 0,
              private: false,
              inbox_id: INBOX_ID,
              created_at: T0 + 30,
              sender: { id: 77, name: "Cliente", type: "contact" },
              attachments: [],
            },
          ],
        }),
        sendMessage: async () => ({}),
        toggleTyping: async () => ({}),
        sendPrivateNote: async () => ({}),
        listLabels: async () => [],
        listCustomAttributeDefinitions: async () => [],
        kanbanTaskForConversation: async () => null,
      } as unknown as ChatwootClient;
      await recoverStrandedDelivery({
        tenantId,
        deliveryRowId: delivery.id,
        base: appDb,
        deps: { makeClient: async () => client, sleep: async () => {} },
      });
      expect(await status(convId)).toBe("resolved");
      await expectHooksRanOnce(convId);
    });

    function consoleClient(live: { updatedAt: number | null }) {
      return {
        makeClient: async () =>
          ({
            toggleStatus: async () => ({}),
            getConversation: async (id: number) => ({
              id,
              status: "resolved",
              meta: { assignee_type: null, assignee: null },
              last_activity_at: T0 + 60,
              ...(live.updatedAt === null
                ? {}
                : { updated_at: live.updatedAt }),
            }),
          }) as never,
      };
    }

    test("a console resolve the read-back reconciles runs the hooks, once", async () => {
      const { convId, rowId } = await seedRow();
      await setConversationStatus(
        sysCtx(),
        rowId,
        "resolved",
        consoleClient({ updatedAt: T0 + 60.5 }),
        appDb,
      );
      expect(await status(convId)).toBe("resolved");
      await expectHooksRanOnce(convId);
    });

    test("a console resolve written unversioned runs the hooks, once", async () => {
      const { convId, rowId } = await seedRow();
      await setConversationStatus(
        sysCtx(),
        rowId,
        "resolved",
        consoleClient({ updatedAt: null }),
        appDb,
      );
      expect(await status(convId)).toBe("resolved");
      await expectHooksRanOnce(convId);
    });

    test("a console re-resolve written unversioned over a resolved row runs nothing", async () => {
      const { convId, rowId } = await seedRow({ status: "resolved" });
      await setConversationStatus(
        sysCtx(),
        rowId,
        "resolved",
        consoleClient({ updatedAt: null }),
        appDb,
      );
      expect(await compactionJobs(convId)).toHaveLength(0);
      expect(await ladder(convId)).toBe("PENDING");
    });

    function withdrawTo(
      convId: number,
      rowId: bigint,
      claimUntil: Date,
      liveStatus: string,
    ) {
      return withdrawClaim({
        tenantId,
        instanceId,
        conversationId: convId,
        conversationRowId: rowId,
        base: appDb,
        claimUntil,
        client: async () =>
          ({
            getConversation: async (id: number) => ({
              id,
              status: liveStatus,
              meta: { assignee_type: null, assignee: null },
              last_activity_at: T0 + 60,
            }),
          }) as unknown as ChatwootClient,
      });
    }

    test("a takeover withdrawn onto pending runs nothing", async () => {
      const claimUntil = new Date(Date.now() + 45_000);
      const { convId, rowId } = await seedRow({
        status: "open",
        statusClaimUntil: claimUntil,
      });
      await withdrawTo(convId, rowId, claimUntil, "pending");
      expect(await status(convId)).toBe("pending");
      expect(await compactionJobs(convId)).toHaveLength(0);
      expect(await ladder(convId)).toBe("PENDING");
    });

    test("a takeover withdrawn onto a resolve runs the hooks, once", async () => {
      const claimUntil = new Date(Date.now() + 45_000);
      const { convId, rowId } = await seedRow({
        status: "open",
        statusClaimUntil: claimUntil,
      });
      await withdrawTo(convId, rowId, claimUntil, "resolved");
      expect(await status(convId)).toBe("resolved");
      await expectHooksRanOnce(convId);
    });
  },
);
