import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { stillInSameEpisode, threadResetBoundary } from "@/graph/reset-episode";
import { readSelectionState } from "@/modules/debounce/watermark";
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

// WHICH COLUMN EACH FENCE READS, AND WHY — the file that exists so nobody has to re-derive it from
// the column names, and so the next `/reset` fence is written against the right question.
//
// `/reset` does two things and they can come apart. It WITHDRAWS the work the conversation had in
// flight, which happens the moment the operator types the command and which nothing can refuse
// afterwards; and it CLEARS the memory, which is a later step that refuses by design while a turn is
// already invoking, with the acknowledgement naming what did not clear.
//
// `reset_at_message_id` records the first. `memory_cleared_at_message_id` is written inside the
// transaction that deletes the thread, the summaries and the checkpoint, so it records the second and
// cannot exist without it.
//
// Every case below is the same row in the state where the two disagree: the operator typed `/reset`
// on message 500 and was told the memory step did not run.
describe.skipIf(!dbUp)(
  "the /reset fences, on a command whose cleanup refused",
  () => {
    let tenantId = 0n;
    let instanceId = 0n;
    let convId = 0n;
    const CONTACT_INBOX = 4373;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "RF743", slug: `rf743-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 43,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      convId = (
        await suDb.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: 4301,
            status: "pending",
            threadId: `${tenantId}:${instanceId}:4301`,
            contactInboxId: CONTACT_INBOX,
            replyClaimFloorMessageId: 0,
            lastEventAt: new Date(),
            // The operator typed the command...
            resetAtMessageId: 500,
            // ...and the clearing never committed. This is the whole fixture.
            memoryClearedAtMessageId: null,
          },
          select: { id: true },
        })
      ).id;
    });

    afterAll(async () => {
      if (tenantId !== 0n) {
        await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      }
    });

    // WITHDRAWAL. The operator took this turn back; whether the memory was emptied is a different
    // question and not this fence's. Issue #449 is the measurement: there the memory step DID refuse,
    // and the stale turn's `set_custom_attribute` then wrote the attribute back onto the conversation
    // the operator had just been told about, with nothing anywhere saying it came back.
    test("the direct turn is withdrawn, cleared memory or not", async () => {
      const fence = (triggerMessageId: number) =>
        stillInSameEpisode({
          tenantId,
          conversationDbId: convId,
          triggerMessageId,
          base: appDb,
        })({ strict: true });
      expect(await fence(499)).toBe(false);
      // The command's own message carries the boundary.
      expect(await fence(500)).toBe(false);
      // Above it is the new episode, which the command did not take back.
      expect(await fence(501)).toBe(true);
    });

    // WITHDRAWAL, same reason: `/reset` retires the pending burst, and the messages it withdrew carry
    // no dispensal row of their own — above the floor "no row" means "offer it", which is what this
    // boundary is here to overrule.
    test("the pending burst stays retired", async () => {
      const state = await readSelectionState({
        tenantId,
        conversationDbId: convId,
        messageIds: [499, 500, 501],
        base: appDb,
      });
      expect(state.resetAt).toBe(500);
    });

    // RESTORE, and the one reader that genuinely needed the other column (issue #728). It decides
    // whether a colleague's reply may be appended INTO the memory, so it must not fire over a memory
    // that was never emptied: the text would be dropped from a thread nobody cleared, after a
    // `/reset` the operator WATCHED fail.
    test("the ingestion append is not fenced, because nothing was cleared", async () => {
      expect(
        await threadResetBoundary(tenantId, instanceId, CONTACT_INBOX, appDb),
      ).toBeNull();
    });

    // ...and once the clearing commits, that fence starts answering too. Same row, one column later.
    test("the append fence follows the clearing, not the command", async () => {
      await suDb.conversation.update({
        where: { id: convId },
        data: { memoryClearedAtMessageId: 500 },
      });
      try {
        expect(
          await threadResetBoundary(tenantId, instanceId, CONTACT_INBOX, appDb),
        ).toBe(500);
      } finally {
        await suDb.conversation.update({
          where: { id: convId },
          data: { memoryClearedAtMessageId: null },
        });
      }
    });
  },
);
