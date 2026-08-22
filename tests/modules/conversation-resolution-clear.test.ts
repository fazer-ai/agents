import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
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

const INBOX = 5;
let tenantId = 0n;
let instanceId = 0n;

function convEvent(
  convId: number,
  event: string,
  status: string,
  updatedAt: number,
) {
  return {
    event,
    id: convId,
    inbox_id: INBOX,
    status,
    contact_inbox: { id: 70_000 + convId },
    meta: { assignee_type: null, assignee: null, sender: { id: 1, name: "C" } },
    channel: "Channel::Email",
    last_activity_at: Math.floor(updatedAt),
    updated_at: updatedAt,
  };
}

async function mirror(payload: unknown) {
  const n = normalizeChatwootEvent(payload);
  if (!n) throw new Error("payload did not normalize");
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

async function originOf(convId: number): Promise<string | null> {
  const row = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { resolvedBy: true },
  });
  return row.resolvedBy;
}

// The stamp says who closed a conversation. It is only ever true of the closing it was written for,
// so it must not survive the conversation being reopened: the next close may be somebody else's, and
// a stale "agent" would be read as a resolution that never happened.
describe.skipIf(!dbUp)(
  "the recorded resolution origin is dropped on reopen",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "RESCLEAR", slug: `resclear-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 12,
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

    async function closeThenStamp(convId: number, at: number) {
      await mirror(convEvent(convId, "conversation_created", "open", at));
      await mirror(
        convEvent(convId, "conversation_status_changed", "resolved", at + 1),
      );
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
        },
        origin: "agent",
        base: appDb,
      });
      expect(await originOf(convId)).toBe("agent");
    }

    test("a reopen clears it", async () => {
      await closeThenStamp(31, 1_700_000_000);
      await mirror(
        convEvent(31, "conversation_status_changed", "open", 1_700_000_002),
      );
      expect(await originOf(31)).toBeNull();
    });

    test("a customer message reopening the conversation clears it too", async () => {
      await closeThenStamp(32, 1_700_001_000);
      await mirror(
        convEvent(32, "conversation_updated", "pending", 1_700_001_002),
      );
      expect(await originOf(32)).toBeNull();
    });

    // The clear rides on the same version comparison as the status write, so a delivery that lost
    // that comparison cannot erase the stamp either. Without this, a retried webhook from before the
    // close (Chatwoot retries three times, ~3s apart) would silently drop a real resolution.
    test("a payload older than the close does not clear it", async () => {
      await closeThenStamp(33, 1_700_002_000);
      await mirror(
        convEvent(33, "conversation_status_changed", "open", 1_700_002_000.5),
      );
      expect(await originOf(33)).toBe("agent");
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 33 },
        select: { status: true },
      });
      // The stale payload lost the status comparison too — the two move together, which is the point.
      expect(row.status).toBe("resolved");
    });

    // Re-closing is not reopening: a resolved conversation that gets another resolved event (a
    // duplicate delivery, a status write that did not change anything) keeps what it recorded.
    test("a second resolved event leaves it alone", async () => {
      await closeThenStamp(34, 1_700_003_000);
      await mirror(
        convEvent(34, "conversation_status_changed", "resolved", 1_700_003_005),
      );
      expect(await originOf(34)).toBe("agent");
    });

    // Review round 3 on #199. Resolving an already-resolved conversation is a no-op in Chatwoot, so
    // the cause of the current resolved state does not change because somebody asked a second time.
    // The console accepts exactly that (REST and MCP both take `resolved` unconditionally), and the
    // follow-up ladder and the redirect closing can both arrive after the agent already closed.
    test("a second closing does not overwrite the first one's origin", async () => {
      await closeThenStamp(38, 1_700_009_000);
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 38,
        },
        origin: "console",
        base: appDb,
      });
      expect(await originOf(38)).toBe("agent");
    });

    // ...but only for the SAME episode. A reopen clears the stamp, and the close after it is a new
    // cause that has to be recorded, or a conversation could never be re-attributed.
    test("after a reopen, the next closing records normally", async () => {
      await closeThenStamp(39, 1_700_010_000);
      await mirror(
        convEvent(39, "conversation_status_changed", "open", 1_700_010_010),
      );
      expect(await originOf(39)).toBeNull();
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 39,
        },
        origin: "console",
        base: appDb,
      });
      expect(await originOf(39)).toBe("console");
    });

    // The webhook is not the only writer of `status`. A live probe (every proactive send, and every
    // console write whose GET answers with a version) reconciles the row from Chatwoot's own answer,
    // and a reopen can arrive that way with no webhook involved at all.
    test("a live probe that finds the conversation reopened clears it", async () => {
      await closeThenStamp(35, 1_700_004_000);
      const out = await reconcile(35, "open", 1_700_004_010);
      expect(out.applied).toBe(true);
      expect(await originOf(35)).toBeNull();
    });

    test("a live probe that still finds it resolved keeps it", async () => {
      await closeThenStamp(36, 1_700_005_000);
      await reconcile(36, "resolved", 1_700_005_010);
      expect(await originOf(36)).toBe("agent");
    });

    // Review round 2 on #199. Between our own toggle and the arrival of ITS event, the mirror still
    // reads the pre-toggle status. A conversation event serialized BEFORE the toggle (an assign_label
    // or set_custom_attribute earlier in the same turn) can be delivered after the stamp, still
    // outrank the stored version, and apply its own non-resolved status over an identical stored one.
    // That no-op used to erase the stamp, and the resolved event arriving next preserved the NULL:
    // a real agent resolution, lost for good, on the one closing the funnel counts.
    test("a pre-toggle event delivered after the stamp does not erase it", async () => {
      const V0 = 1_700_007_000;
      await mirror(convEvent(40, "conversation_created", "open", V0));
      // Our toggle happens in Chatwoot (version V0+2). Its webhook has not arrived yet, so the mirror
      // still says "open" at V0 — which is exactly the state the stamp is written on top of.
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 40,
        },
        origin: "agent",
        base: appDb,
      });
      // The label write from earlier in the same turn, serialized at V0+1, delivered late. Newer than
      // the stored version, so it applies; its status is the pre-toggle one, identical to the stored.
      await mirror(convEvent(40, "conversation_updated", "open", V0 + 1));
      expect(await originOf(40)).toBe("agent");
      // Our own resolve event lands last and does not restore anything — it never could.
      await mirror(
        convEvent(40, "conversation_status_changed", "resolved", V0 + 2),
      );
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 40 },
        select: { status: true, resolvedBy: true },
      });
      expect(row.status).toBe("resolved");
      expect(row.resolvedBy).toBe("agent");
    });

    // The same shape through the live probe, which writes status on its own path.
    async function reconcile(
      convId: number,
      status: string,
      updatedAt: number,
    ) {
      return reconcileMirrorFromLive({
        tenantId,
        instanceId,
        conversationId: convId,
        live: {
          status,
          assigneeType: null,
          assigneeId: null,
          assigneeName: null,
          lastActivityAt: new Date(updatedAt * 1000),
          updatedAt,
        },
        base: appDb,
      });
    }

    // The live probe takes its snapshot from the CALLER, so the same race the webhook path has is
    // reachable here: a snapshot fetched before our toggle, applied after the stamp, reporting a
    // non-resolved status that differs from the stored one. "The snapshot says non-resolved" is not
    // "the conversation left resolved", and only the second may drop the stamp — the two writers have
    // to answer that the same way or the rule is only half true.
    test("a live probe moving between two non-resolved statuses does not erase it", async () => {
      const V0 = 1_700_008_000;
      await mirror(convEvent(41, "conversation_created", "open", V0));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 41,
        },
        origin: "agent",
        base: appDb,
      });
      const out = await reconcile(41, "pending", V0 + 1);
      expect(out.applied).toBe(true);
      expect(await originOf(41)).toBe("agent");
    });

    test("a live probe older than the close cannot clear it", async () => {
      await closeThenStamp(37, 1_700_006_000);
      const out = await reconcile(37, "open", 1_700_006_000.5);
      expect(out.outrankedByVersion).toBe(true);
      expect(await originOf(37)).toBe("agent");
    });
  },
);
