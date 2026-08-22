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

// The same event as above from a Chatwoot older than 4.0.2, which sends no `updated_at`. Those
// conversation events still move status — `decideConversationWrites` falls back to
// `last_activity_at` for them — so anything that treats "no version" as "cannot speak about status"
// is wrong about every install on that line.
function legacyConvEvent(
  convId: number,
  event: string,
  status: string,
  activityAt: number,
) {
  const { updated_at: _dropped, ...rest } = convEvent(
    convId,
    event,
    status,
    activityAt,
  );
  return rest;
}

// A brand-new incoming customer message: the one reopen a message payload carries faithfully, and
// the fact rule 3 in `clearsResolutionOrigin` reads.
function incomingMessage(convId: number, messageId: number, at: number) {
  return {
    event: "message_created",
    id: messageId,
    content: "oi de novo",
    message_type: "incoming",
    private: false,
    conversation: convEvent(convId, "message_created", "open", at),
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

    // Production ordering, which is the only one that reaches the recorder's rules: the toggle
    // happens in Chatwoot, we stamp immediately (our own mirror still says open, because our
    // webhook has not come back yet), and the resolved event lands after. A helper that stamped
    // AFTER the event would be exercising a sequence the code never sees.
    async function closeThenStamp(convId: number, at: number) {
      await mirror(convEvent(convId, "conversation_created", "open", at));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
        },
        origin: "agent",
        observed: { status: "open", statusAt: null },
        base: appDb,
      });
      await mirror(
        convEvent(convId, "conversation_status_changed", "resolved", at + 1),
      );
      expect(await originOf(convId)).toBe("agent");
    }

    test("a reopen clears it", async () => {
      await closeThenStamp(31, 1_700_000_000);
      await mirror(
        convEvent(31, "conversation_status_changed", "open", 1_700_000_002),
      );
      expect(await originOf(31)).toBeNull();
    });

    // Chatwoot < 4.0.2, where nothing carries a version and ordering falls back to
    // `last_activity_at`. The stamp is written while our mirror still says open, the customer's
    // reopen is mirrored first, and OUR resolve arrives behind it and loses. The close it describes
    // never landed, so leaving the stamp would hand the agent whatever closes the conversation next.
    test("a close that lost the activity ordering clears it, with no version in sight", async () => {
      const at = 1_700_009_000;
      await mirror(legacyConvEvent(38, "conversation_created", "open", at));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 38,
        },
        origin: "agent",
        observed: { status: "open", statusAt: null },
        base: appDb,
      });
      expect(await originOf(38)).toBe("agent");
      // The customer's reopen is delivered first and moves the row's activity mark forward.
      await mirror(legacyConvEvent(38, "conversation_updated", "open", at + 2));
      expect(await originOf(38)).toBe("agent");
      // Our own close, delayed: it states "resolved" and loses the only comparison there is.
      await mirror(
        legacyConvEvent(38, "conversation_status_changed", "resolved", at + 1),
      );
      expect(await originOf(38)).toBeNull();
    });

    // A delayed close from an EARLIER episode, which loses the ordering in exactly the shape of our
    // own close failing to land. Clearing on it wiped the stamp of a close that was still on its
    // way, and that close's own event found nothing to restore — so a real agent resolution was
    // reported as somebody else's, for good. The version floor recorded with the stamp is what
    // tells the two apart.
    test("a delayed close from an earlier episode leaves a newer stamp alone", async () => {
      const at = 1_700_050_000;
      await mirror(convEvent(50, "conversation_created", "open", at));
      await mirror(
        convEvent(50, "conversation_status_changed", "resolved", at + 1),
      );
      await mirror(
        convEvent(50, "conversation_status_changed", "open", at + 2),
      );
      expect(await originOf(50)).toBeNull();
      // Second episode: the agent closes again, and we stamp while our own webhook is still in
      // flight, so the row still reads open. The observation is the row as the caller read it, both
      // halves — which is what production passes and what makes the floor the reopen's version.
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 50,
        },
        origin: "agent",
        observed: { status: "open", statusAt: at + 2 },
        base: appDb,
      });
      expect(await originOf(50)).toBe("agent");
      // The FIRST episode's resolved event, retried late.
      await mirror(
        convEvent(50, "conversation_status_changed", "resolved", at + 1),
      );
      expect(await originOf(50)).toBe("agent");
      // And the second close's own event lands, with the origin intact.
      await mirror(
        convEvent(50, "conversation_status_changed", "resolved", at + 3),
      );
      expect(await originOf(50)).toBe("agent");
    });

    // Review round 10. A newer inbound reopens the conversation and is mirrored between our toggle
    // returning and the stamp landing, so by write time the row's own status version describes THAT
    // reopen. Copying it as the floor would date the stamp to the wrong episode: our own delayed
    // resolve event would then be judged to predate the stamp and could never clear it, and the
    // next close by anyone else would read as the agent's. The floor is the caller's observation.
    test("a reopen mirrored before the stamp does not become its floor", async () => {
      const at = 1_700_060_000;
      await mirror(convEvent(61, "conversation_created", "open", at));
      // The agent closes: the toggle lands in Chatwoot at at+1, and the caller observed the row as
      // it was BEFORE that, which is the open row at version `at`.
      // Its reopen event, from a customer message, is mirrored first.
      await mirror(
        convEvent(61, "conversation_status_changed", "open", at + 2),
      );
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 61,
        },
        origin: "agent",
        observed: { status: "open", statusAt: at },
        base: appDb,
      });
      expect(await originOf(61)).toBe("agent");
      // Our own resolve event, delayed behind the reopen. It loses the ordering, and it is NEWER
      // than the floor, so it is our close failing to land and the stamp goes with it.
      await mirror(
        convEvent(61, "conversation_status_changed", "resolved", at + 1),
      );
      expect(await originOf(61)).toBeNull();
    });

    // Review round 11, and the only path that does not go through our own view of "resolved".
    // Chatwoot retries a webhook three times and then gives up, so our close CAN be lost for good:
    // the row never records the resolved state, and there is no later resolved claim to lose the
    // ordering either. Without rule 3 the stamp rides into the customer's next episode and hands
    // the agent whatever closes that one.
    test("a customer coming back clears a stamp whose close we never saw land", async () => {
      const at = 1_700_070_000;
      await mirror(convEvent(62, "conversation_created", "open", at));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 62,
        },
        origin: "agent",
        observed: { status: "open", statusAt: at },
        base: appDb,
      });
      expect(await originOf(62)).toBe("agent");
      // The resolve event never arrives. Days later the customer writes again.
      await mirror(incomingMessage(62, 6200, at + 500));
      expect(await originOf(62)).toBeNull();
    });

    // And the guard that keeps rule 3 off a retry: Chatwoot redelivers the SAME message_created, so
    // `reopensConversation` is true again. The second delivery must not erase a close made after
    // the first one, which is what the version floor is for.
    test("a retried delivery of the reopening message does not erase the close after it", async () => {
      const at = 1_700_071_000;
      await mirror(convEvent(63, "conversation_created", "open", at));
      // The customer's message opens this episode.
      await mirror(incomingMessage(63, 6300, at + 1));
      // The agent handles it and closes; the caller observed the row as the message left it.
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 63,
        },
        origin: "agent",
        observed: { status: "open", statusAt: at + 1 },
        base: appDb,
      });
      expect(await originOf(63)).toBe("agent");
      // Chatwoot redelivers the same message.
      await mirror(incomingMessage(63, 6300, at + 1));
      expect(await originOf(63)).toBe("agent");
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

    // Review round 4 on #199. An operator in the Chatwoot UI, an automation rule, or
    // `auto_resolve_after` closes the conversation and deliberately leaves the origin NULL — none of
    // them reach our code. Our own toggle then succeeds as a no-op, and stamping on the back of it
    // would credit the agent with somebody else's close, in the Resolution KPI, in the direction
    // this whole change exists to stop.
    test("a close that already happened outside our code is not claimed", async () => {
      const V0 = 1_700_011_000;
      await mirror(convEvent(42, "conversation_created", "open", V0));
      // Chatwoot resolved it on its own and we mirrored that: no origin, by design.
      await mirror(
        convEvent(42, "conversation_status_changed", "resolved", V0 + 1),
      );
      expect(await originOf(42)).toBeNull();
      // What the caller observes is the row it read before deciding to close — here, already
      // resolved by somebody else. Production passes exactly this: nudge.ts hands over the live
      // probe's answer, runtime.ts the ownership recheck's, the console the row it loaded.
      const observed = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 42 },
        select: { status: true, chatwootStatusAt: true },
      });
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 42,
        },
        origin: "agent",
        observed: {
          status: observed.status,
          statusAt: observed.chatwootStatusAt,
        },
        base: appDb,
      });
      expect(await originOf(42)).toBeNull();
    });

    // Review round 5 on #199. The stamp is written while our mirror still says open. A customer
    // reply reopens the conversation, that newer event is delivered FIRST, and our own resolve then
    // loses the version comparison and is never applied. The row stays open carrying a stamp about a
    // close that no longer exists, and the next close — an operator's, a timer's — would be read as
    // the agent's. The rejection is the signal: a payload saying "resolved" that the mirror refused.
    test("a stamp whose close was outranked does not survive to the next one", async () => {
      const V0 = 1_700_013_000;
      await mirror(convEvent(44, "conversation_created", "open", V0));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 44,
        },
        origin: "agent",
        observed: { status: "pending", statusAt: null },
        base: appDb,
      });
      // The customer replied. Their reopen (V0+3) is delivered before our resolve (V0+2).
      await mirror(convEvent(44, "conversation_updated", "open", V0 + 3));
      await mirror(
        convEvent(44, "conversation_status_changed", "resolved", V0 + 2),
      );
      expect(await originOf(44)).toBeNull();
      // The later close, by whoever: with the stamp gone it is correctly unattributed.
      await mirror(
        convEvent(44, "conversation_status_changed", "resolved", V0 + 9),
      );
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 44 },
        select: { status: true, resolvedBy: true },
      });
      expect(row.status).toBe("resolved");
      expect(row.resolvedBy).toBeNull();
    });

    // Review round 6 on #199, and the axis the round-5 fix got wrong. A brand-new incoming customer
    // message is the one reopen a message payload carries faithfully, and it advances only the
    // STATUS mark. Our delayed resolve then loses the status axis while still winning the assignee
    // one, so the event is NOT whole-event stale and the stale branch never sees it.
    test("a close outranked on the status axis alone is still dropped", async () => {
      const V0 = 1_700_015_000;
      await mirror(convEvent(46, "conversation_created", "open", V0));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 46,
        },
        origin: "agent",
        observed: { status: "pending", statusAt: null },
        base: appDb,
      });
      // The customer's reply reopens: a message payload, which moves the status mark and nothing
      // else, so the assignee mark stays where the create left it.
      await mirror({
        event: "message_created",
        id: 4600,
        content: "oi de novo",
        message_type: "incoming",
        private: false,
        conversation: {
          id: 46,
          inbox_id: INBOX,
          status: "open",
          contact_inbox: { id: 70_000 + 46 },
          meta: {
            assignee_type: null,
            assignee: null,
            sender: { id: 1, name: "C" },
          },
          channel: "Channel::Email",
          last_activity_at: V0 + 3,
          updated_at: V0 + 3,
        },
      });
      // Our resolve, serialized before that reply, delivered after it.
      await mirror(
        convEvent(46, "conversation_status_changed", "resolved", V0 + 2),
      );
      expect(await originOf(46)).toBeNull();
    });

    // A frozen MESSAGE snapshot can carry a conversation that reads "resolved" — Chatwoot serializes
    // the payload at enqueue and a retry re-sends that copy. It claims no version and is meant to
    // move no state (issue #61), so it is not evidence that any close was rejected. This is the case
    // that makes `fromConversationEvent` part of the rule rather than decoration.
    test("a frozen message snapshot claiming resolved does not drop the stamp", async () => {
      const V0 = 1_700_016_000;
      await mirror(convEvent(47, "conversation_created", "open", V0));
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 47,
        },
        origin: "agent",
        observed: { status: "pending", statusAt: null },
        base: appDb,
      });
      await mirror({
        event: "message_updated",
        id: 4700,
        content: "resposta do agente",
        message_type: "outgoing",
        private: false,
        conversation: {
          id: 47,
          inbox_id: INBOX,
          status: "resolved",
          contact_inbox: { id: 70_000 + 47 },
          meta: {
            assignee_type: null,
            assignee: null,
            sender: { id: 1, name: "C" },
          },
          channel: "Channel::Email",
          last_activity_at: V0 + 1,
          updated_at: V0 + 1,
        },
      });
      expect(await originOf(47)).toBe("agent");
    });

    // The rejection rule must not fire on a duplicate delivery of an OLD close landing on a
    // conversation that is already resolved: that payload says nothing about the current stamp.
    test("an outranked resolve on an already-resolved conversation leaves it alone", async () => {
      await closeThenStamp(45, 1_700_014_000);
      await mirror(
        convEvent(
          45,
          "conversation_status_changed",
          "resolved",
          1_700_014_000.5,
        ),
      );
      expect(await originOf(45)).toBe("agent");
    });

    // The other half of rule 2, and the one a re-read of the row could not get right: the mirror can
    // carry OUR OWN close before the turn ends (zero lag, which `mirrorOnToggle` in
    // tests/graph/runtime.test.ts treats as the worst case). What the caller saw is still "open", so
    // the close is ours and must be recorded.
    test("our own close, mirrored with zero lag, is still recorded", async () => {
      const V0 = 1_700_012_000;
      await mirror(convEvent(43, "conversation_created", "open", V0));
      // The webhook for our toggle lands before we get to the stamp.
      await mirror(
        convEvent(43, "conversation_status_changed", "resolved", V0 + 1),
      );
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 43,
        },
        origin: "agent",
        // What the ownership recheck saw before the toggle.
        observed: { status: "pending", statusAt: null },
        base: appDb,
      });
      expect(await originOf(43)).toBe("agent");
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
        observed: { status: "open", statusAt: null },
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
        observed: { status: "open", statusAt: null },
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
        observed: { status: "open", statusAt: null },
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
        observed: { status: "open", statusAt: null },
        base: appDb,
      });
      const out = await reconcile(41, "pending", V0 + 1);
      expect(out.applied).toBe(true);
      expect(await originOf(41)).toBe("agent");
    });

    // The round-8 shape through the live probe. A GET that predates the reopen still reports the
    // FIRST episode's "resolved"; it loses the version comparison, and without the floor that loss
    // reads as our own close failing to land, so the stamp of the close still in flight is wiped.
    // The reconcile has to answer this the same way the webhook mirror does.
    test("a stale live probe reporting an earlier close leaves a newer stamp alone", async () => {
      const V0 = 1_700_010_000;
      await mirror(convEvent(60, "conversation_created", "open", V0));
      await mirror(
        convEvent(60, "conversation_status_changed", "resolved", V0 + 1),
      );
      await mirror(
        convEvent(60, "conversation_status_changed", "open", V0 + 2),
      );
      expect(await originOf(60)).toBeNull();
      await recordResolutionOrigin({
        tenantId,
        conversation: {
          chatwootInstanceId: instanceId,
          chatwootConversationId: 60,
        },
        origin: "agent",
        observed: { status: "open", statusAt: V0 + 2 },
        base: appDb,
      });
      expect(await originOf(60)).toBe("agent");
      // The probe's snapshot is from the first episode: resolved, at V0+1.
      const out = await reconcile(60, "resolved", V0 + 1);
      expect(out.outrankedByVersion).toBe(true);
      expect(await originOf(60)).toBe("agent");
    });

    test("a live probe older than the close cannot clear it", async () => {
      await closeThenStamp(37, 1_700_006_000);
      const out = await reconcile(37, "open", 1_700_006_000.5);
      expect(out.outrankedByVersion).toBe(true);
      expect(await originOf(37)).toBe("agent");
    });
  },
);
