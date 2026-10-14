import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  clearFlushHold,
  clearTurnInFlight,
  markFlushHold,
  markTurnInFlight,
} from "@/graph/inflight";
import { turnOwnsThread } from "@/graph/thread-claim";
import { reengageConversation } from "@/modules/conversations/reengage";
import { dbProbeFailed } from "@/tests/db-gate";
import {
  dropReengageWorld,
  fakeModel,
  makeStub,
  page,
  type ReengageWorld,
  reengageCtx,
  seedReengageConversation,
  seedReengageWorld,
} from "../utils/reengage";

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let world: ReengageWorld;
let tenantId = 0n;
let instanceId = 0n;
const ctx = () => reengageCtx(world);
const seedConversation = (
  convId: number,
  over?: Parameters<typeof seedReengageConversation>[3],
) => seedReengageConversation(suDb, world, convId, over);

describe.skipIf(!dbUp)("o portão do re-engage é um bloco síncrono", () => {
  beforeAll(async () => {
    world = await seedReengageWorld(suDb, `re-gate-${process.pid}`);
    ({ tenantId, instanceId } = world);
  });

  afterAll(async () => {
    if (tenantId) await dropReengageWorld(suDb, tenantId);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // O PORTÃO É UM BLOCO SÍNCRONO: a leitura durável de posse primeiro e, depois dela, nenhum `await`
  // até a marca. A costura `reengageOwnershipRead` segura essa leitura aberta, e é ali que a escrita
  // concorrente entra: o que este processo grava enquanto ela está fora tem que ser visto pela
  // checagem que vem depois, ou dois cliques leem "livre" e marcam os dois.
  const tail = page([
    { id: 1, content: "oi", type: 0 },
    { id: 2, content: "resposta antiga", type: 1 },
    { id: 3, content: "e aí?", type: 0 },
  ]);

  for (const [quem, marca, limpa] of [
    ["o hold de outro clique", markFlushHold, clearFlushHold],
    ["um turno que começou", markTurnInFlight, clearTurnInFlight],
  ] as const) {
    test(`${quem}, gravado durante a leitura de posse, recusa o clique`, async () => {
      const CI = quem.startsWith("o hold") ? 611 : 612;
      const id = await seedConversation(9000 + CI, { contactInboxId: CI });
      const graphThreadId = `${tenantId}:${instanceId}:ci:${CI}`;
      const sent: Array<[number, string]> = [];
      let leu = false;
      try {
        const res = await reengageConversation(
          ctx(),
          id,
          {
            makeModel: fakeModel,
            makeClient: makeStub({ page: tail, sent }),
            checkpointer: new MemorySaver(),
            reengageOwnershipRead: async (owner, base) => {
              const dono = await turnOwnsThread(owner, base);
              leu = true;
              marca(graphThreadId);
              return dono;
            },
          },
          appDb,
        );
        expect(leu).toBe(true);
        expect(res.outcome).toBe("busy");
        expect(sent).toEqual([]);
      } finally {
        limpa(graphThreadId);
      }
    });
  }

  // Duas leituras seguradas e soltas juntas: as duas voltam "livre", e só a marca síncrona logo
  // depois decide qual clique segue. Um `await` entre a checagem e a marca deixa os dois passarem.
  test("dois cliques soltos juntos da leitura de posse viram um turno só", async () => {
    const CI = 613;
    const idA = await seedConversation(9613, { contactInboxId: CI });
    const idB = await seedConversation(9614, { contactInboxId: CI });
    const sent: Array<[number, string]> = [];
    let leram = 0;
    let soltar: () => void = () => {};
    const juntos = new Promise<void>((r) => {
      soltar = r;
    });
    const deps = () => ({
      makeModel: fakeModel,
      makeClient: makeStub({ page: tail, sent }),
      checkpointer: new MemorySaver(),
      reengageOwnershipRead: async (
        owner: Parameters<typeof turnOwnsThread>[0],
        base: PrismaClient,
      ) => {
        const dono = await turnOwnsThread(owner, base);
        leram += 1;
        if (leram >= 2) soltar();
        await juntos;
        return dono;
      },
    });
    const [a, b] = await Promise.all([
      reengageConversation(ctx(), idA, deps(), appDb),
      reengageConversation(ctx(), idB, deps(), appDb),
    ]);
    expect(leram).toBe(2);
    expect([a.outcome, b.outcome].sort()).toEqual(["busy", "posted"]);
    expect(sent.length).toBe(1);
  });
});
