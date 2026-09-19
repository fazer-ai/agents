import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { ingestDedupeKey } from "@/graph/ingest-job";

// ── "NENHUMA INGESTÃO FOI ARMADA PARA ESTA MENSAGEM" NÃO É UMA CONTAGEM (issue #723) ──
//
// Quarenta e dois lugares em dois arquivos fazem essa afirmação contando a POPULAÇÃO de linhas
// `INGEST_MESSAGE` do tenant, antes e depois, e comparando. A população não é uma quantidade estável,
// e não por sujeira de teste: a linha é APAGADA ao concluir (`JOB_DELETE_ON_DONE.INGEST_MESSAGE`, cujo
// comentário em scheduler/lanes.ts explica que essa é a exceção justamente porque a chave nomeia UMA
// mensagem e nada varre a tabela), e `drainPendingIngest` reapa e drena as pendentes de uma thread a
// partir de três lugares do produto.
//
// O prejuízo tem dois lados, e a issue só viu um:
//
// 1. VERMELHO MAL ATRIBUÍDO. Alguém remove linha por perto e o delta não fecha. A mensagem lida como
//    "a marca de posse humana está enfileirando ingestão quando não deveria", que é exatamente o
//    defeito para o qual o teste foi escrito, e quem cai nisso na CI tem que descartar a feature
//    antes de suspeitar da suíte.
//
// 2. VERDE QUE NÃO PROVA NADA, que é o caro e que só apareceu quando o holdout foi medido: uma troca
//    1-por-1 (apaga a linha de outra mensagem, planta a da mensagem sob teste, população constante)
//    deixou o arquivo 38/0. A linha que o teste jura não existir estava na tabela dois segundos
//    antes da releitura, e ele passou. Melhorar a mensagem de erro não toca nisso: o veredito
//    continua sendo decidido pelo TAMANHO da população.
//
// Este arquivo prova as três propriedades sem depender de reproduzir o flake, porque ele produz a
// interferência em vez de esperar por ela. O que a entrega precisa ter é uma pergunta que nomeie a
// linha: `ingestDedupeKey(graphThreadId, messageId)`, que a produção já usa para montar a chave e que
// até esta rodada era privada.

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

    // A forma antiga decide por isto, e isto mudou.
    expect(await population()).toBe(3);
    // A afirmação que o teste queria fazer não mudou, porque nada armou ingestão para a mensagem.
    expect(await armedForMine()).toBe(false);
  });

  test("O FALSO VERDE: população constante com a linha da própria mensagem plantada", async () => {
    const before = await population();
    // A troca 1-por-1 que o holdout mediu: some uma de outra mensagem, entra a DESTA, na mesma
    // transação, e o total não se mexe.
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

    // A forma antiga não vê nada acontecer: é exatamente aqui que ela passa em verde.
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
