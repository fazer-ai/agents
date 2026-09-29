import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { ingestDedupeKey } from "@/graph/ingest-job";

// ── "NENHUMA INGESTÃO FOI ARMADA PARA ESTA MENSAGEM" NÃO É UMA CONTAGEM ──
// A população de linhas `INGEST_MESSAGE` do tenant não é estável: a linha é APAGADA ao concluir
// (`JOB_DELETE_ON_DONE.INGEST_MESSAGE`, ver scheduler/lanes.ts) e `drainPendingIngest` drena pendentes
// de três lugares do produto. Decidir pelo tamanho dá VERMELHO MAL ATRIBUÍDO (alguém remove uma linha
// por perto e o delta lê como defeito da feature) e VERDE QUE NÃO PROVA NADA (uma troca 1-por-1 deixa
// a população constante com a linha proibida na tabela). Este arquivo produz a interferência em vez de
// esperar por ela, e a pergunta certa nomeia a linha: `ingestDedupeKey(graphThreadId, messageId)`, a
// mesma chave que a produção monta.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

let dbUp = false;
let su: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const suDb = su as PrismaClient;

describe.skipIf(!dbUp)("an ingestion armed for THIS message", () => {
  let tenantId = 0n;
  const instanceId = 6n;
  const contactInboxId = 81019;
  // A mensagem sob teste, e quatro vizinhas que existem só para dar população.
  const mine = 81007;
  const others = [81001, 81002, 81003, 81004];
  let thread = "";

  beforeAll(async () => {
    if (!dbUp) return;
    const t = await suDb.tenant.create({
      data: { name: "ARM", slug: `arm-${process.pid}` },
    });
    tenantId = t.id;
    thread = contactInboxThreadId(tenantId, instanceId, contactInboxId);
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
  });

  async function arm(messageId: number) {
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(thread, messageId),
        status: "PENDING",
        runAt: new Date(),
        payload: { messageId },
      },
      select: { id: true },
    });
  }

  async function population() {
    return await suDb.schedulerJob.count({
      where: { tenantId, kind: "INGEST_MESSAGE" },
    });
  }

  // A pergunta que a entrega tem que oferecer, feita aqui pela chave para o teste não depender do
  // nome do helper: o que se prova é que a chave da mensagem É o critério suficiente.
  async function armedForMine() {
    return (
      (await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(thread, mine),
        },
      })) > 0
    );
  }

  test("a chave nomeia a mensagem, e é ela que a produção usa para montar a linha", () => {
    expect(ingestDedupeKey(thread, mine)).toBe(`ingest:${thread}:${mine}`);
    // Duas mensagens da mesma thread nunca colidem, que é a razão de a linha ser apagada ao concluir.
    expect(ingestDedupeKey(thread, mine)).not.toBe(
      ingestDedupeKey(thread, others[0] as number),
    );
  });

  test("remoção concorrente move a população e NÃO move o fato da mensagem", async () => {
    for (const m of others) await arm(m);
    expect(await population()).toBe(4);
    expect(await armedForMine()).toBe(false);

    // O que um vizinho (ou o próprio produto, ao concluir uma ingestão) faz o tempo todo.
    await suDb.schedulerJob.deleteMany({
      where: {
        tenantId,
        dedupeKey: ingestDedupeKey(thread, others[0] as number),
      },
    });

    // NOTE: A contagem decide por isto, e isto mudou.
    expect(await population()).toBe(3);
    // A afirmação que o teste queria fazer não mudou, porque nada armou ingestão para a mensagem.
    expect(await armedForMine()).toBe(false);
  });

  test("O FALSO VERDE: população constante com a linha da própria mensagem plantada", async () => {
    const before = await population();
    // NOTE: A troca 1-por-1: some uma de outra mensagem, entra a DESTA, na mesma transação, e o total não se
    // mexe.
    await suDb.$transaction([
      suDb.schedulerJob.deleteMany({
        where: {
          tenantId,
          dedupeKey: ingestDedupeKey(thread, others[1] as number),
        },
      }),
      suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(thread, mine),
          status: "PENDING",
          runAt: new Date(),
          payload: { messageId: mine },
        },
      }),
    ]);

    // NOTE: A contagem não vê nada acontecer: é exatamente aqui que ela passa em verde.
    expect(await population()).toBe(before);
    // E a linha que o teste jura não existir está na tabela.
    expect(await armedForMine()).toBe(true);
  });

  test("ruído que não nomeia mensagem nenhuma deste teste não pode decidir nada", async () => {
    await suDb.schedulerJob.deleteMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(thread, mine),
      },
    });
    const outroThread = contactInboxThreadId(tenantId, instanceId, 99999);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(outroThread, mine),
        status: "PENDING",
        runAt: new Date(),
        payload: { messageId: mine },
      },
      select: { id: true },
    });
    // Mesma mensagem, OUTRA thread: a chave é a thread mais a mensagem, e o fato sob teste é o par.
    expect(await armedForMine()).toBe(false);
  });
});
