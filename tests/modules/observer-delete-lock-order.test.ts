import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import {
  bindInbox,
  observeInbox,
  unobserveInbox,
} from "@/modules/chatwoot/management";
import { seedChatwootInstance } from "../utils/chatwoot";
import { waitUntilBlocked } from "../utils/pg-waits";

// Every delete of an observer row takes the inbox lock first (the module's order is account, then
// inbox). Deleting an `inbox_observers` row locks it and then its AFTER DELETE trigger updates the
// inbox's `binding_generation`, while `bindInbox` and `unobserveInbox` lock the inbox and then
// delete the row. Opposite orders are a cycle Postgres breaks with 40P01, which the compensation
// path swallows, leaving a pending row while the observer is detached upstream. Each delete site is
// reached while another transaction holds the inbox row: the call has to park there, and while it
// waits the observer row it is about to delete must still be free, which a `NOWAIT` probe proves.

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
let nextInbox = 7730;
const ctx = () => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN" as const,
});

// Holds the inbox row until released, and answers with the holder's backend pid.
async function holdInbox(inboxId: bigint) {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let announce!: (pid: number) => void;
  const gotIt = new Promise<number>((r) => {
    announce = r;
  });
  const done = suDb.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
      const [me] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid`;
      announce(me?.pid as number);
      await held;
    },
    { timeout: 30_000 },
  );
  const pid = await Promise.race([gotIt, done.then(() => -1)]);
  return { pid, release, done };
}

// What `bindInbox` and `observeInbox` call on the fork. `hook` runs inside the attach, after the
// fork applied it and before it answers: the window this file stages the holder in.
function stubClient(opts: {
  hook?: () => Promise<void>;
  attachFails?: boolean;
}) {
  const client = {
    listAgentBots: async () => [],
    createAgentBot: async () => ({
      id: 940,
      access_token: "bot-token",
      secret: "bot-secret",
    }),
    updateAgentBot: async () => ({}),
    getInbox: async (id: number) => ({ id }),
    setInboxAgentBot: async () => {
      await opts.hook?.();
      return {};
    },
    addInboxObserver: async () => {
      await opts.hook?.();
      if (opts.attachFails) throw new ChatwootApiError(500, "boom");
      return {};
    },
    removeInboxObserver: async () => ({}),
  } as unknown as ChatwootClient;
  return { makeClient: async () => client };
}

describe.skipIf(!dbUp)(
  "the observer row is never deleted without the inbox lock",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "OBSLOCK", slug: `obslock-${process.pid}` },
      });
      tenantId = t.id;
      // A real blob: `loadChatwootClient` decrypts the admin token before it reaches `makeClient`.
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 7730,
        adminToken: encryptJson("admin-token"),
      });
      instanceId = inst.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "inbox_observers",
          "inboxes",
          "chatwoot_agent_bots",
          "agents",
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
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    async function fixture() {
      nextInbox += 1;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: `Observadora ${nextInbox}`,
          systemPrompt: "Você observa.",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          mode: "monitoring",
        },
        select: { id: true },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: nextInbox,
          name: `Inbox ${nextInbox}`,
        },
        select: { id: true },
      });
      return { agentId: agent.id, inboxId: inbox.id };
    }

    async function observerRowOf(inboxId: bigint, agentId: bigint) {
      const row = await suDb.inboxObserver.findFirst({
        where: { inboxId, agentId },
        select: { id: true },
      });
      return row?.id ?? null;
    }

    // The call is parked behind the inbox holder, and the observer row is still free to lock.
    async function parksBeforeTheDelete(
      holder: Awaited<ReturnType<typeof holdInbox>>,
      rowId: bigint | null,
    ) {
      expect(rowId).not.toBeNull();
      expect(
        await waitUntilBlocked(suDb, holder.pid, 1),
      ).toBeGreaterThanOrEqual(0);
      await suDb.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT 1 FROM inbox_observers WHERE id = ${rowId} FOR UPDATE NOWAIT`,
        );
      });
    }

    test("unobserving an inbox", async () => {
      const { agentId, inboxId } = await fixture();
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId, agentId },
      });
      const rowId = await observerRowOf(inboxId, agentId);
      const holder = await holdInbox(inboxId);
      const unobserving = unobserveInbox(
        ctx(),
        inboxId,
        agentId,
        stubClient({}),
        appDb,
      );
      unobserving.catch(() => {});
      try {
        await parksBeforeTheDelete(holder, rowId);
      } finally {
        holder.release();
        await holder.done;
      }
      await unobserving;
      expect(await observerRowOf(inboxId, agentId)).toBeNull();
    });

    test("a bind retiring the observer row an observe wrote in its Chatwoot window", async () => {
      const { agentId, inboxId } = await fixture();
      let holder: Awaited<ReturnType<typeof holdInbox>> | undefined;
      let staged!: () => void;
      const ready = new Promise<void>((r) => {
        staged = r;
      });
      const binding = bindInbox(
        ctx(),
        inboxId,
        agentId,
        stubClient({
          hook: async () => {
            await suDb.inboxObserver.create({
              data: { tenantId, inboxId, agentId },
            });
            holder = await holdInbox(inboxId);
            staged();
          },
        }),
        appDb,
      );
      binding.catch(() => {});
      await Promise.race([ready, binding]);
      const h = holder as NonNullable<typeof holder>;
      try {
        await parksBeforeTheDelete(h, await observerRowOf(inboxId, agentId));
      } finally {
        h.release();
        await h.done;
      }
      expect((await binding).agentId).toBe(String(agentId));
      expect(await observerRowOf(inboxId, agentId)).toBeNull();
    });

    test("an observe the responder binding won while it was attaching", async () => {
      const { agentId, inboxId } = await fixture();
      let holder: Awaited<ReturnType<typeof holdInbox>> | undefined;
      let staged!: () => void;
      const ready = new Promise<void>((r) => {
        staged = r;
      });
      const observing = observeInbox(
        ctx(),
        inboxId,
        agentId,
        stubClient({
          hook: async () => {
            await suDb.inbox.update({
              where: { id: inboxId },
              data: { agentId },
            });
            holder = await holdInbox(inboxId);
            staged();
          },
        }),
        appDb,
      );
      observing.catch(() => {});
      await Promise.race([ready, observing]);
      const h = holder as NonNullable<typeof holder>;
      try {
        await parksBeforeTheDelete(h, await observerRowOf(inboxId, agentId));
      } finally {
        h.release();
        await h.done;
      }
      expect((await observing).observerAgentIds).toEqual([]);
      expect(await observerRowOf(inboxId, agentId)).toBeNull();
    });

    test("an observe taking its pending row back after the attach failed", async () => {
      const { agentId, inboxId } = await fixture();
      let holder: Awaited<ReturnType<typeof holdInbox>> | undefined;
      let staged!: () => void;
      const ready = new Promise<void>((r) => {
        staged = r;
      });
      const observing = observeInbox(
        ctx(),
        inboxId,
        agentId,
        stubClient({
          attachFails: true,
          hook: async () => {
            holder = await holdInbox(inboxId);
            staged();
          },
        }),
        appDb,
      );
      observing.catch(() => {});
      await Promise.race([ready, observing]);
      const h = holder as NonNullable<typeof holder>;
      try {
        await parksBeforeTheDelete(h, await observerRowOf(inboxId, agentId));
      } finally {
        h.release();
        await h.done;
      }
      await expect(observing).rejects.toMatchObject({ statusCode: 502 });
      expect(await observerRowOf(inboxId, agentId)).toBeNull();
    });
  },
);
