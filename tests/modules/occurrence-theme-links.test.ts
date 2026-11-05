// Which conversations a theme row links to (docs/dashboards.md, the occurrences source): the latest of
// the monitor's window, by the time the flags count each at, whatever their reference; a theme with
// none in the window links its latest.

import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { OCCURRENCES_DEFAULTS } from "@/modules/occurrences/settings";
import { themeRowsOn } from "@/modules/occurrences/views";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

let suDb: PrismaClient;
let appDb: PrismaClient;
let dbUp = true;
if (!process.env.TEST_APP_DATABASE_URL) dbUp = false;
else {
  appDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_APP_DATABASE_URL,
    }),
  });
  suDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
    }),
  });
  try {
    await suDb.$queryRaw`SELECT 1`;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

const created: bigint[] = [];
afterAll(async () => {
  if (!dbUp) return;
  await suDb.tenant.deleteMany({ where: { id: { in: created } } });
  await appDb.$disconnect();
  await suDb.$disconnect();
});

async function account() {
  const t = await suDb.tenant.create({
    data: { name: "occ-links", slug: `occ-links-${process.pid}` },
  });
  created.push(t.id);
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 3,
    baseUrl: "https://cw-links.example.com/",
    adminToken: encryptJson("ADMIN"),
  });
  const inbox = await suDb.inbox.create({
    data: {
      tenantId: t.id,
      chatwootInstanceId: inst.id,
      chatwootInboxId: 1,
      name: "SAC",
    },
  });
  const otherInbox = await suDb.inbox.create({
    data: {
      tenantId: t.id,
      chatwootInstanceId: inst.id,
      chatwootInboxId: 2,
      name: "Produtor",
    },
  });
  // The monitor reads the SAC inbox only.
  const monitor = await suDb.occurrenceMonitor.create({
    data: {
      tenantId: t.id,
      name: "Ocorrências",
      config: {
        ...OCCURRENCES_DEFAULTS,
        inboxIds: [String(inbox.id)],
        fields: [
          {
            key: "unidade",
            name: "Unidade",
            description: "A unidade.",
            attribute: false,
          },
          {
            key: "queixa",
            name: "Queixa",
            description: "O problema.",
            attribute: false,
          },
        ],
        referenceField: "unidade",
        reasonField: "queixa",
      } as unknown as Prisma.InputJsonValue,
    },
  });
  let cw = 5000;
  const conv = async (inboxId: bigint = inbox.id) => {
    const n = ++cw;
    const c = await suDb.conversation.create({
      data: {
        tenantId: t.id,
        chatwootInstanceId: inst.id,
        inboxId,
        chatwootConversationId: n,
        threadId: `occ-links-${n}`,
        status: "open",
      },
    });
    return { id: c.id, cw: n };
  };
  const ctx: TenantContext = {
    tenantId: t.id,
    userId: null,
    role: "TENANT_ADMIN",
  };
  const rows = () =>
    runScopedOn(appDb, ctx, (db) =>
      themeRowsOn(db, t.id, monitor.id, { links: 3 }),
    );
  return {
    tenantId: t.id,
    monitorId: monitor.id,
    conv,
    rows,
    otherInbox,
    inbox,
  };
}

describe.skipIf(!dbUp)("a theme's links (DB)", () => {
  // The monitor's window is 60 minutes by default and ends at the read.
  test("a theme's links are the latest conversations of the monitor's window, whatever their reference", async () => {
    const a = await account();
    const canonical = (name: string) =>
      suDb.occurrenceCanonical.create({
        data: {
          tenantId: a.tenantId,
          monitorId: a.monitorId,
          field: "unidade",
          name,
        },
      });
    const centro = await canonical("Loja Centro");
    const norte = await canonical("Loja Norte");
    const theme = (title: string) =>
      suDb.occurrenceTheme.create({
        data: {
          tenantId: a.tenantId,
          monitorId: a.monitorId,
          title,
          flags: ["concentrated"],
          flagReferenceId: centro.id,
          flaggedAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    const member = async (
      themeId: bigint,
      minutesAgo: number,
      canonicalId: bigint | null,
      o: { inboxId?: bigint; inboundMinutesAgo?: number } = {},
    ) => {
      const c = await a.conv(o.inboxId ?? a.inbox.id);
      const now = Date.now();
      await suDb.occurrenceThemeMember.create({
        data: {
          tenantId: a.tenantId,
          monitorId: a.monitorId,
          themeId,
          conversationId: c.id,
          sentence: "pix",
          readAt: new Date(now - minutesAgo * 60_000),
          ...(o.inboundMinutesAgo === undefined
            ? {}
            : { inboundAt: new Date(now - o.inboundMinutesAgo * 60_000) }),
        },
      });
      if (canonicalId !== null)
        await suDb.conversationReading.create({
          data: {
            tenantId: a.tenantId,
            monitorId: a.monitorId,
            conversationId: c.id,
            field: "unidade",
            value: "x",
            canonicalId,
          },
        });
      return c.cw;
    };
    const pix = await theme("Pix nao confirma");
    // Older than the window, of the row's reference: never ahead of a conversation of the window.
    await member(pix.id, 120, centro.id);
    await member(pix.id, 90, centro.id);
    const w1 = await member(pix.id, 5, norte.id);
    const w2 = await member(pix.id, 20, null);
    const w3 = await member(pix.id, 40, centro.id);
    await member(pix.id, 50, norte.id);
    // Read inside the window, its customer message before it: it is not the window's.
    await member(pix.id, 1, centro.id, { inboundMinutesAgo: 180 });
    // An inbox the monitor does not read never links, however recent.
    await member(pix.id, 0.5, centro.id, { inboxId: a.otherInbox.id });
    const rows = await a.rows();
    const top = rows.find((r) => r.title === "Pix nao confirma");
    expect(top?.links?.map((l) => l.chatwootConversationId)).toEqual([
      w1,
      w2,
      w3,
    ]);

    // Fewer in the window than links: only the window's, none from before it.
    const boleto = await theme("Boleto");
    await member(boleto.id, 200, centro.id);
    const only = await member(boleto.id, 10, norte.id);
    const second = (await a.rows()).find((r) => r.title === "Boleto");
    expect(second?.links?.map((l) => l.chatwootConversationId)).toEqual([only]);

    // None in the window (a held theme, cooling down): its latest conversations.
    const cooled = await theme("Esfriando");
    const old1 = await member(cooled.id, 300, null);
    const old2 = await member(cooled.id, 400, centro.id);
    const old3 = await member(cooled.id, 500, norte.id);
    await member(cooled.id, 600, norte.id);
    const third = (await a.rows()).find((r) => r.title === "Esfriando");
    expect(third?.links?.map((l) => l.chatwootConversationId)).toEqual([
      old1,
      old2,
      old3,
    ]);
  });
});
