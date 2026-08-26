import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #257. `chatwoot_conversation_id` stores Chatwoot's per-account DISPLAY id, and the mirror is
// the only writer of it. It reads whatever `normalizeChatwootEvent` put on `conversationId`, and that
// used to be `payload.id` for every event except message_created/message_updated — on the assumption
// that "not a message event" means "the body IS the conversation".
//
// It does not. Chatwoot serializes each event's own SUBJECT with that subject's `webhook_data`, and
// every one of them renders its own table id under the same `id` key: a contact
// (`Contact#webhook_data`), a contact_inbox (`ContactInbox#webhook_data`), an inbox, a kanban card, a
// message. So a foreign row id landed in `chatwoot_conversation_id` and opened a SECOND mirror row
// for a conversation that already had one, which is what the report measured in production (two rows,
// one keyed by the display id and one by a value no display id has).
//
// The payload shapes below were captured from the fork itself (`bundle exec rails runner` over
// `app/listeners/{agent_bot,webhook}_listener.rb` and the `webhook_data` each of them calls), then
// reduced to the fields this decision reads. The measured table at capture time was 7 of 19 event
// shapes feeding a foreign id.

const DISPLAY_ID = 1235; // conversations.display_id — the ONLY id this column may hold
const TABLE_ID = 1320; // conversations.id for that same conversation
const CONTACT_ID = 41; // contacts.id
const CONTACT_INBOX_ID = 61; // contact_inboxes.id
const MESSAGE_ID = 353; // messages.id
const KANBAN_TASK_ID = 29; // fazer_ai_kanban_tasks.id
const INBOX_ID = 9;

// `Conversations::EventDataPresenter#push_data` — `id: display_id`, status/meta/inbox_id at the top.
function conversationBody() {
  return {
    id: DISPLAY_ID,
    inbox_id: INBOX_ID,
    status: "pending",
    contact_inbox: { id: CONTACT_INBOX_ID },
    meta: { assignee_type: null, assignee: null, sender: { id: CONTACT_ID } },
    last_activity_at: 1_786_483_614,
    updated_at: 1_786_483_614.5,
  };
}

// `Message#webhook_data` — `id` is the MESSAGE row; the conversation is nested and carries display_id.
function messageBody() {
  return {
    id: MESSAGE_ID,
    content: "oi",
    message_type: "incoming",
    private: false,
    inbox: { id: INBOX_ID, name: "WhatsApp" },
    conversation: conversationBody(),
  };
}

// Every event shape either listener can deliver, and the id each one puts at the top level.
const SHAPES: { event: string; body: Record<string, unknown> }[] = [
  // conversation.webhook_data — the only bodies whose `id` IS a display id.
  { event: "conversation_created", body: conversationBody() },
  { event: "conversation_opened", body: conversationBody() },
  { event: "conversation_resolved", body: conversationBody() },
  { event: "conversation_status_changed", body: conversationBody() },
  { event: "conversation_updated", body: conversationBody() },
  // message.webhook_data — `id` is the message row, on all four of them.
  { event: "message_created", body: messageBody() },
  { event: "message_updated", body: messageBody() },
  { event: "message_incoming", body: messageBody() },
  { event: "message_outgoing", body: messageBody() },
  // contact_inbox.webhook_data — `id` is the contact_inbox; the display id sits under
  // `current_conversation`, and there is no `inbox_id` at the top at all.
  {
    event: "webwidget_triggered",
    body: {
      id: CONTACT_INBOX_ID,
      source_id: "src",
      inbox: { id: INBOX_ID, name: "Widget" },
      current_conversation: conversationBody(),
    },
  },
  // contact.webhook_data — `id` is the contact.
  {
    event: "contact_created",
    body: { id: CONTACT_ID, name: "Cliente", phone_number: "+5511999990000" },
  },
  {
    event: "contact_updated",
    body: { id: CONTACT_ID, name: "Cliente", changed_attributes: {} },
  },
  // Kanban::Task#push_event_data — `id` is the card.
  {
    event: "kanban_task_updated",
    body: { id: KANBAN_TASK_ID, title: "Lead", custom_attributes: {} },
  },
  // Built inline by the listener — `id` is the internal-chat message.
  {
    event: "internal_chat_message_created",
    body: { id: 999_111, content: "x", account_id: 1 },
  },
  // Built inline by the listener: the conversation is NESTED, so the top level has no id at all.
  {
    event: "conversation_typing_on",
    body: { conversation: conversationBody(), is_private: false },
  },
  // Not an event we know. The shape of a future one cannot be guessed from its body.
  { event: "some_event_chatwoot_adds_later", body: { id: 777 } },
];

describe("chatwoot payload shape: only a conversation body carries a conversation id", () => {
  // The whole rule as a table: whatever the event, `conversationId` is either the display id or
  // nothing. A number that is neither is a foreign row id about to key a mirror row.
  for (const { event, body } of SHAPES) {
    test(`${event} never yields a foreign id`, () => {
      const n = normalizeChatwootEvent({ event, ...body });
      expect(n).not.toBeNull();
      const got = n?.conversationId ?? null;
      expect([DISPLAY_ID, null]).toContain(got);
    });
  }

  // The half of the rule the assertion above cannot state: the events that DO carry a conversation
  // still resolve it. Without this, returning null unconditionally would pass the table.
  test("the five conversation events and both message events still resolve the display id", () => {
    const resolved = SHAPES.filter(
      ({ event, body }) =>
        normalizeChatwootEvent({ event, ...body })?.conversationId ===
        DISPLAY_ID,
    ).map((s) => s.event);
    expect(resolved.sort()).toEqual(
      [
        "conversation_created",
        "conversation_opened",
        "conversation_resolved",
        "conversation_status_changed",
        "conversation_updated",
        "message_created",
        "message_updated",
      ].sort(),
    );
  });
});

// ── the effect the report measured: one conversation, two mirror rows ──

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

let tenantId = 0n;
let instanceId = 0n;

describe.skipIf(!dbUp)(
  "mirror: a foreign id does not open a second row for a conversation that has one",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "PAYLOAD-SHAPE", slug: `payload-shape-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 11,
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

    async function mirror(payload: unknown) {
      const n = normalizeChatwootEvent(payload);
      if (!n) throw new Error("payload did not normalize");
      return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
    }

    // The report: row 687 keyed 1235 (the display id) at 11:21, row 688 keyed 1320 (the same
    // conversation's TABLE id) at 11:46. Any event whose body is not a conversation reproduces it —
    // this uses the one that names the table id outright, a message body's nested conversation vs the
    // message body's own top-level id.
    test("a message body's own id does not become a second conversation", async () => {
      await mirror({ event: "conversation_updated", ...conversationBody() });
      // Same conversation, arriving as an account-webhook message event. `payload.id` here is the
      // MESSAGE row; only `payload.conversation.id` is the display id.
      await mirror({
        event: "message_incoming",
        ...messageBody(),
        id: TABLE_ID,
      });
      const rows = await suDb.conversation.findMany({
        where: { tenantId, chatwootInstanceId: instanceId },
        select: { chatwootConversationId: true },
      });
      expect(rows.map((r) => r.chatwootConversationId)).toEqual([DISPLAY_ID]);
    });

    // Issue #222, and the same display-id-not-table-id rule this file exists for. The fork stamps the
    // redirect episode's origin on the widget conversation and ships it on push_data; it is the ENTRY
    // conversation's display id, so it lands in a column the mirror compares against
    // chatwootConversationId.
    test("the redirect origin rides in on the payload and lands in the column", async () => {
      const ORIGIN_DISPLAY = 4242;
      await mirror({
        event: "message_created",
        ...messageBody(),
        conversation: {
          ...conversationBody(),
          redirect_origin_display_id: ORIGIN_DISPLAY,
        },
      });
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: DISPLAY_ID },
        select: { redirectOriginDisplayId: true },
      });
      expect(row.redirectOriginDisplayId).toBe(ORIGIN_DISPLAY);

      // A later payload that says nothing about the pairing must not wipe it: absent is "this event
      // did not mention it", the same convention the attribute bags follow.
      await mirror({ event: "conversation_updated", ...conversationBody() });
      const after = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: DISPLAY_ID },
        select: { redirectOriginDisplayId: true },
      });
      expect(after.redirectOriginDisplayId).toBe(ORIGIN_DISPLAY);
    });

    // Same rule from the other end: a body about a different SUBJECT writes nothing at all, rather
    // than a row keyed by that subject's id.
    test("a contact body opens no conversation row", async () => {
      const before = await suDb.conversation.count({
        where: { tenantId, chatwootInstanceId: instanceId },
      });
      const res = await mirror({
        event: "contact_updated",
        id: CONTACT_ID,
        name: "Cliente",
        changed_attributes: {},
      });
      expect(res.conversationRowId).toBeNull();
      expect(res.applied).toBe(false);
      const after = await suDb.conversation.count({
        where: { tenantId, chatwootInstanceId: instanceId },
      });
      expect(after).toBe(before);
    });
  },
);
