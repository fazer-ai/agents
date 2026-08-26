import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  chatSideNote,
  conversationUrl,
  linkRedirectConversations,
  shouldPropagateTestMode,
  whatsappSideNote,
} from "@/modules/channel-redirect/cross-link";
import {
  CHANNEL_REDIRECT_DEFAULTS,
  type ChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import { seedChatwootInstance } from "../utils/chatwoot";

describe("conversationUrl", () => {
  test("builds the operator dashboard deep link", () => {
    expect(conversationUrl("http://localhost:3010", 1, 17)).toBe(
      "http://localhost:3010/app/accounts/1/conversations/17",
    );
  });

  test("strips a trailing slash on the base URL", () => {
    expect(conversationUrl("http://cw.local:3010/", 2, 5)).toBe(
      "http://cw.local:3010/app/accounts/2/conversations/5",
    );
  });
});

describe("shouldPropagateTestMode", () => {
  const activated = new Date("2026-07-06T12:00:00Z");

  test("propagates when test mode + sibling active + widget inactive", () => {
    expect(shouldPropagateTestMode("test", activated, null)).toBe(true);
  });

  test("does not propagate in production mode", () => {
    expect(shouldPropagateTestMode("production", activated, null)).toBe(false);
  });

  test("does not propagate when the WhatsApp sibling was never activated", () => {
    expect(shouldPropagateTestMode("test", null, null)).toBe(false);
  });

  test("does not propagate when the widget is already activated", () => {
    expect(shouldPropagateTestMode("test", activated, activated)).toBe(false);
  });
});

describe("cross-link notes", () => {
  test("whatsapp-side note points at the chat conversation URL", () => {
    const note = whatsappSideNote("http://x/app/accounts/1/conversations/17");
    expect(note).toContain("chat do site");
    expect(note).toContain("http://x/app/accounts/1/conversations/17");
  });

  test("chat-side note points at the WhatsApp conversation URL", () => {
    const note = chatSideNote("http://x/app/accounts/1/conversations/14");
    expect(note).toContain("WhatsApp");
    expect(note).toContain("http://x/app/accounts/1/conversations/14");
  });
});

// ── which conversation the cross-link actually reads (issue #222) ──

// The notes are best-effort HTTP, so they are not what this asserts. The test-mode propagation is:
// it reads the SIBLING's activation stamp and writes it onto the widget row, so a durable effect in
// the database says which row was read — no Chatwoot double, no mock.module.
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

const ENTRY_INBOX = 310;
const WIDGET_INBOX = 311;
const ORIGIN_CONV = 9301;
const DECOY_CONV = 9302;
const WIDGET_CONV = 9303;

describe.skipIf(!dbUp)(
  "linkRedirectConversations picks the episode's origin",
  () => {
    let tenantId = 0n;
    let instanceId = 0n;
    let widgetRowId = 0n;
    let contactId = 0n;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "XLINK", slug: `xlink-${process.pid}` },
      });
      tenantId = t.id;
      // TEST-NET-3 on the discard port: the note posts are best-effort and must die without DNS.
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 12,
        baseUrl: "https://203.0.113.12:9",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const entryInbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: ENTRY_INBOX,
          name: "WhatsApp",
        },
        select: { id: true },
      });
      const widgetInbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: WIDGET_INBOX,
          name: "Site",
        },
        select: { id: true },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 991,
        },
        select: { id: true },
      });
      contactId = contact.id;
      const activated = new Date("2026-07-06T12:00:00Z");
      // The origin: activated, and deliberately the OLDER of the two entry conversations.
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: entryInbox.id,
          contactId: contact.id,
          chatwootConversationId: ORIGIN_CONV,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${ORIGIN_CONV}`,
          lastEventAt: new Date(Date.now() - 60_000),
          testActivatedAt: activated,
        },
      });
      // The decoy: newer, never activated. The old predicate takes this one.
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: entryInbox.id,
          contactId: contact.id,
          chatwootConversationId: DECOY_CONV,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${DECOY_CONV}`,
          lastEventAt: new Date(Date.now() + 60_000),
          testActivatedAt: null,
        },
      });
      const widget = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: widgetInbox.id,
          contactId: contact.id,
          chatwootConversationId: WIDGET_CONV,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${WIDGET_CONV}`,
          lastEventAt: new Date(),
          redirectOriginDisplayId: ORIGIN_CONV,
        },
        select: { id: true },
      });
      widgetRowId = widget.id;
    });

    afterAll(async () => {
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("propagates the STORED origin's activation, not the newest entry conversation's", async () => {
      const cfg: ChannelRedirectConfig = {
        ...CHANNEL_REDIRECT_DEFAULTS,
        enabled: true,
        entryInboxId: ENTRY_INBOX,
        widgetInboxId: WIDGET_INBOX,
      };
      const out = await linkRedirectConversations({
        tenantId,
        instanceId,
        agentId: 1n,
        mode: "test",
        cfg,
        widgetConv: {
          id: widgetRowId,
          displayId: WIDGET_CONV,
          testActivatedAt: null,
          contactId,
          redirectOriginDisplayId: ORIGIN_CONV,
          chatwootRedirectOriginAt: null,
        },
        base: appDb,
      });

      // Only the origin is activated, so a propagation at all means the origin was the row read.
      expect(out.testActivatedAt).not.toBeNull();
      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { testActivatedAt: true, redirectLinkedAt: true },
      });
      expect(row.testActivatedAt).not.toBeNull();
      expect(row.redirectLinkedAt).not.toBeNull();
    });

    // Review round 5 of #355. The origin this call resolves its sibling with is read at the top of
    // the delivery, and the watermark it stamps is written after two round trips and a Chatwoot POST.
    // A pairing accepted in that window moves the episode, and stamping anyway spends the NEXT
    // episode's only shot on the previous episode's notes: the inbound for the new origin finds the
    // watermark set and links nothing, ever.
    test("does not stamp the watermark when the pairing moved under it", async () => {
      const cfg: ChannelRedirectConfig = {
        ...CHANNEL_REDIRECT_DEFAULTS,
        enabled: true,
        entryInboxId: ENTRY_INBOX,
        widgetInboxId: WIDGET_INBOX,
      };
      // The episode released and re-paired to the decoy while this delivery was reading, which is
      // exactly what the mirror writes when it accepts a different origin.
      await suDb.conversation.update({
        where: { id: widgetRowId },
        data: {
          redirectLinkedAt: null,
          testActivatedAt: null,
          redirectOriginDisplayId: DECOY_CONV,
        },
      });

      const out = await linkRedirectConversations({
        tenantId,
        instanceId,
        agentId: 1n,
        mode: "test",
        cfg,
        widgetConv: {
          id: widgetRowId,
          displayId: WIDGET_CONV,
          testActivatedAt: null,
          contactId,
          // The snapshot this delivery started from: the origin as it stood before the move.
          redirectOriginDisplayId: ORIGIN_CONV,
          chatwootRedirectOriginAt: null,
        },
        base: appDb,
      });

      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { testActivatedAt: true, redirectLinkedAt: true },
      });
      // Nothing claimed, so the next inbound — the one that belongs to the decoy episode — still
      // gets its cross-link. And nothing propagated either: the activation it would have carried
      // over belongs to the origin this episode no longer has.
      expect(row.redirectLinkedAt).toBeNull();
      expect(row.testActivatedAt).toBeNull();
      expect(out.testActivatedAt).toBeNull();
    });

    // Review round 7 of #355. Since round 6, `(origin=null, mark=null)` and `(origin=null, mark=set)`
    // are DIFFERENT states — never told, versus told there is none — and a claim that compares only
    // the origin reads them as one. This call resolved its sibling through the recency fallback,
    // which is what "never told" licenses; a stated clear landing under it revokes that licence, and
    // the notes would go to a WhatsApp conversation the source just said is not this episode's.
    test("does not stamp when a stated clear lands on the legacy state", async () => {
      const cfg: ChannelRedirectConfig = {
        ...CHANNEL_REDIRECT_DEFAULTS,
        enabled: true,
        entryInboxId: ENTRY_INBOX,
        widgetInboxId: WIDGET_INBOX,
      };
      await suDb.conversation.update({
        where: { id: widgetRowId },
        data: {
          redirectLinkedAt: null,
          testActivatedAt: null,
          // What the mirror wrote while this call was reading: same null, and a mark that turns it
          // from silence into an answer.
          redirectOriginDisplayId: null,
          chatwootRedirectOriginAt: 1_786_000_000.5,
        },
      });

      const out = await linkRedirectConversations({
        tenantId,
        instanceId,
        agentId: 1n,
        mode: "test",
        cfg,
        widgetConv: {
          id: widgetRowId,
          displayId: WIDGET_CONV,
          testActivatedAt: null,
          contactId,
          // The snapshot this delivery started from: nobody had said anything yet.
          redirectOriginDisplayId: null,
          chatwootRedirectOriginAt: null,
        },
        base: appDb,
      });

      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { testActivatedAt: true, redirectLinkedAt: true },
      });
      expect(row.redirectLinkedAt).toBeNull();
      expect(row.testActivatedAt).toBeNull();
      expect(out.testActivatedAt).toBeNull();
      await suDb.conversation.update({
        where: { id: widgetRowId },
        data: { chatwootRedirectOriginAt: null },
      });
    });

    // Review round 9 of #355. The mark is a VERSION and advances on every payload that states the
    // pairing, the ones stating the SAME pairing included. Compared for equality it reads an ordinary
    // webhook arriving mid-call as an episode change and spends this inbound's attempt on nothing:
    // no notes, no propagation, on an episode that never moved.
    test("an ordinary same-origin update does not cost the cross-link its claim", async () => {
      const cfg: ChannelRedirectConfig = {
        ...CHANNEL_REDIRECT_DEFAULTS,
        enabled: true,
        entryInboxId: ENTRY_INBOX,
        widgetInboxId: WIDGET_INBOX,
      };
      await suDb.conversation.update({
        where: { id: widgetRowId },
        data: {
          redirectLinkedAt: null,
          testActivatedAt: null,
          redirectOriginDisplayId: ORIGIN_CONV,
          // Newer than what the call carries, same origin.
          chatwootRedirectOriginAt: 1_786_000_090.5,
        },
      });

      await linkRedirectConversations({
        tenantId,
        instanceId,
        agentId: 1n,
        mode: "test",
        cfg,
        widgetConv: {
          id: widgetRowId,
          displayId: WIDGET_CONV,
          testActivatedAt: null,
          contactId,
          redirectOriginDisplayId: ORIGIN_CONV,
          chatwootRedirectOriginAt: 1_786_000_000.5,
        },
        base: appDb,
      });

      const row = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { redirectLinkedAt: true },
      });
      expect(row.redirectLinkedAt).not.toBeNull();
      await suDb.conversation.update({
        where: { id: widgetRowId },
        data: { chatwootRedirectOriginAt: null },
      });
    });

    // The claim is the one-shot, not the caller's fence. That fence reads `redirectLinkedAt` at the
    // top of the delivery and this write lands a dozen awaits later, so two inbounds arriving
    // together both passed it — and an unconditional stamp let both post their pair of private notes.
    test("a second call finds the watermark taken and does not re-stamp it", async () => {
      const cfg: ChannelRedirectConfig = {
        ...CHANNEL_REDIRECT_DEFAULTS,
        enabled: true,
        entryInboxId: ENTRY_INBOX,
        widgetInboxId: WIDGET_INBOX,
      };
      await suDb.conversation.update({
        where: { id: widgetRowId },
        data: {
          redirectLinkedAt: null,
          testActivatedAt: null,
          redirectOriginDisplayId: ORIGIN_CONV,
        },
      });
      const call = () =>
        linkRedirectConversations({
          tenantId,
          instanceId,
          agentId: 1n,
          mode: "test",
          cfg,
          widgetConv: {
            id: widgetRowId,
            displayId: WIDGET_CONV,
            testActivatedAt: null,
            contactId,
            redirectOriginDisplayId: ORIGIN_CONV,
            chatwootRedirectOriginAt: null,
          },
          base: appDb,
        });

      await call();
      const first = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { redirectLinkedAt: true },
      });
      await call();
      const second = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: WIDGET_CONV },
        select: { redirectLinkedAt: true },
      });
      expect(first.redirectLinkedAt).not.toBeNull();
      expect(second.redirectLinkedAt).toEqual(first.redirectLinkedAt);
    });
  },
);
