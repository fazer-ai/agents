// Which conversations a theme row links to (docs/dashboards.md, the occurrences source): the latest
// whose reference reading is the row's reference, then the latest of the rest, newest first.

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

const HOUR = 3_600_000;
const NOW = new Date(Date.now() - HOUR);

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
  test("a theme's links are its latest conversations of the row's reference first, then the latest of the rest", async () => {
    const a = await account();
    const canonical = (name: string, mergedIntoId?: bigint) =>
      suDb.occurrenceCanonical.create({
        data: {
          tenantId: a.tenantId,
          monitorId: a.monitorId,
          field: "unidade",
          name,
          ...(mergedIntoId ? { mergedIntoId } : {}),
        },
      });
    const centro = await canonical("Loja Centro");
    // A spelling merged into the row's reference counts as it.
    const centroAlias = await canonical("Centro", centro.id);
    const norte = await canonical("Loja Norte");
    const theme = await suDb.occurrenceTheme.create({
      data: {
        tenantId: a.tenantId,
        monitorId: a.monitorId,
        title: "Pix nao confirma",
        flags: ["concentrated"],
        flagReferenceId: centro.id,
        flaggedAt: NOW,
        firstSeenAt: new Date(NOW.getTime() - 10 * HOUR),
        lastSeenAt: NOW,
      },
    });
    const member = async (
      hoursAgo: number,
      canonicalId: bigint | null,
      inboxId: bigint = a.inbox.id,
    ) => {
      const c = await a.conv(inboxId);
      await suDb.occurrenceThemeMember.create({
        data: {
          tenantId: a.tenantId,
          monitorId: a.monitorId,
          themeId: theme.id,
          conversationId: c.id,
          sentence: "pix",
          readAt: new Date(NOW.getTime() - hoursAgo * HOUR),
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
    // Two old ones of another reference, and the newest of all is of another reference too.
    await member(9, norte.id);
    await member(8, norte.id);
    const centroOld = await member(5, centro.id);
    const centroMid = await member(3, centroAlias.id);
    await member(1, norte.id);
    const centroNew = await member(2, centro.id);
    // A conversation of an inbox the monitor does not read never links, however recent.
    await member(0.5, centro.id, a.otherInbox.id);

    const top = (await a.rows())[0];
    expect(top?.reference).toBe("Loja Centro");
    expect(top?.links?.map((l) => l.chatwootConversationId)).toEqual([
      centroNew,
      centroMid,
      centroOld,
    ]);

    // Fewer of the reference than links: the rest fills in, the latest first.
    const theme2 = await suDb.occurrenceTheme.create({
      data: {
        tenantId: a.tenantId,
        monitorId: a.monitorId,
        title: "Boleto",
        flags: ["concentrated"],
        flagReferenceId: centro.id,
        flaggedAt: new Date(NOW.getTime() - HOUR),
        lastSeenAt: NOW,
      },
    });
    const member2 = async (hoursAgo: number, canonicalId: bigint | null) => {
      const c = await a.conv();
      await suDb.occurrenceThemeMember.create({
        data: {
          tenantId: a.tenantId,
          monitorId: a.monitorId,
          themeId: theme2.id,
          conversationId: c.id,
          sentence: "boleto",
          readAt: new Date(NOW.getTime() - hoursAgo * HOUR),
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
    await member2(6, null);
    const restMid = await member2(4, norte.id);
    const onlyCentro = await member2(5, centro.id);
    const restNew = await member2(3, norte.id);
    // Its reading of another field is not its reference: it links once, ranked as the rest.
    await suDb.conversationReading.create({
      data: {
        tenantId: a.tenantId,
        monitorId: a.monitorId,
        conversationId: (
          await suDb.conversation.findFirstOrThrow({
            where: { tenantId: a.tenantId, chatwootConversationId: restNew },
          })
        ).id,
        field: "queixa",
        value: "boleto",
      },
    });
    const second = (await a.rows()).find((r) => r.title === "Boleto");
    expect(second?.links?.map((l) => l.chatwootConversationId)).toEqual([
      onlyCentro,
      restNew,
      restMid,
    ]);

    // The row's reference merged into another since the flag: the survivor's readings are preferred.
    const lojaSul = await canonical("Loja Sul");
    await suDb.occurrenceCanonical.update({
      where: { id: centro.id },
      data: { mergedIntoId: lojaSul.id },
    });
    await suDb.occurrenceCanonical.update({
      where: { id: centroAlias.id },
      data: { mergedIntoId: lojaSul.id },
    });
    const sulNew = await member(0.8, lojaSul.id);
    const afterMerge = (await a.rows()).find(
      (r) => r.title === "Pix nao confirma",
    );
    expect(afterMerge?.links?.map((l) => l.chatwootConversationId)).toEqual([
      sulNew,
      centroNew,
      centroMid,
    ]);
  });
});
