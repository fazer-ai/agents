import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { drainPendingIngest } from "@/graph/ingest-drain";
import { armIngest, ingestDedupeKey, ingestHandler } from "@/graph/ingest-job";
import { runScopedOn } from "@/lib/tenancy";
import {
  type ClaimedJob,
  claimDueTrafficJobs,
  revokeJobsByKeyPrefixOn,
} from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// ── RESET-THEN-ARM: A INGESTÃO ARMADA DEPOIS DO /reset (issue #718) ──
//
// O `/reset` revoga as linhas `INGEST_MESSAGE` que existem, de dentro da seção crítica
// `ingest:<thread>`, e uma passada já em memória relê a sua linha ali dentro e desiste
// (`stillWanted`). Isso cobre ARM-THEN-RESET.
//
// Não cobre o contrário. A entrega arma o job no FIM da própria passada, bem depois de o turno
// soltar a posse da thread, e um job nascido depois da revogação é `CLAIMED` pela própria
// reivindicação, com o `claimSeq` dela: passa naquela cerca carregando texto de antes do reset,
// recria a linha de `agent_threads` e o checkpoint, e o operador foi informado que a thread estava
// limpa.
//
// Perguntar no ARM não fecharia: o reset cai entre a leitura e a escrita. A pergunta é pela marca
// VIGENTE NA EXECUÇÃO, feita dentro da seção crítica, que é o que torna as duas exclusivas.

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;
let tenantId = 0n;
let instanceId = 0n;

if (!process.env.TEST_APP_DATABASE_URL) {
  dbUp = false;
} else {
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
  } catch {
    dbUp = false;
  }
}

describe.skipIf(!dbUp)("an ingestion armed after a /reset", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "IRB", slug: `irb-${process.pid}` },
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
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "agent_threads",
        "conversations",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  function threadOf(contactInboxId: number) {
    return contactInboxThreadId(tenantId, instanceId, contactInboxId);
  }

  // A linha espelhada da conversa, que é onde a marca do episódio mora.
  async function mirror(
    convId: number,
    contactInboxId: number,
    resetAtMessageId: number | null,
  ) {
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        contactInboxId,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${convId}`,
        ...(resetAtMessageId === null ? {} : { resetAtMessageId }),
      },
      select: { id: true },
    });
  }

  // Uma linha DE VERDADE, reivindicada como o tick reivindica. Um `ClaimedJob` montado à mão é um
  // job que já foi cancelado do ponto de vista do `stillWanted`, e todo teste escrito assim passaria
  // pelo motivo errado.
  async function armAndClaim(
    contactInboxId: number,
    conversationId: number,
    messageId: number,
    text: string,
    role: "customer" | "human_agent" = "customer",
  ): Promise<ClaimedJob> {
    await armIngest({
      tenantId,
      instanceId,
      conversationId,
      contactInboxId,
      graphThreadId: threadOf(contactInboxId),
      messageId,
      text,
      role,
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    const job = (await claimDueTrafficJobs(50, appDb, new Date(), tenantId))
      .filter(
        (j) =>
          j.kind === "INGEST_MESSAGE" &&
          (j.payload as { messageId?: number }).messageId === messageId,
      )
      .at(0);
    if (!job) throw new Error("a linha armada não foi reivindicada");
    return job;
  }

  function reader(saver: MemorySaver, contactInboxId: number) {
    return async () => {
      const cp = await saver.get({
        configurable: { thread_id: threadOf(contactInboxId) },
      });
      return (
        ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
          []) as BaseMessage[]
      ).map((m) => String(m.content));
    };
  }

  async function threadRow(contactInboxId: number) {
    return suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastSyncedMessageId: true, lastAgentMessageId: true },
    });
  }

  test("s1: a mensagem de antes do reset não é anexada, e a thread não é recriada", async () => {
    const ci = 71_001;
    const saver = new MemorySaver();
    await mirror(5001, ci, 200);
    const job = await armAndClaim(ci, 5001, 150, "texto pré-reset");
    const contents = reader(saver, ci);

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await contents()).toEqual([]);
    expect(await threadRow(ci)).toBeNull();
  });

  test("s2: a mensagem que chegou DEPOIS do reset continua sendo ingerida", async () => {
    const ci = 71_002;
    const saver = new MemorySaver();
    await mirror(5002, ci, 200);
    const job = await armAndClaim(ci, 5002, 300, "texto pós-reset");
    const contents = reader(saver, ci);

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await contents()).toEqual([
      expect.stringContaining("texto pós-reset"),
    ]);
    expect((await threadRow(ci))?.lastSyncedMessageId).toBe(300);
  });

  test("s3: a borda é a própria mensagem do comando — 200 recusa, 201 ingere", async () => {
    const ciA = 71_003;
    const ciB = 71_004;
    const saverA = new MemorySaver();
    const saverB = new MemorySaver();
    await mirror(5003, ciA, 200);
    await mirror(5004, ciB, 200);

    const naBorda = await armAndClaim(ciA, 5003, 200, "a própria do comando");
    expect((await ingestHandler(naBorda, appDb, saverA)).outcome).toBe("done");
    expect(await reader(saverA, ciA)()).toEqual([]);
    expect(await threadRow(ciA)).toBeNull();

    const logoAcima = await armAndClaim(ciB, 5004, 201, "a de depois");
    expect((await ingestHandler(logoAcima, appDb, saverB)).outcome).toBe(
      "done",
    );
    expect(await reader(saverB, ciB)()).toEqual([
      expect.stringContaining("a de depois"),
    ]);
    expect((await threadRow(ciB))?.lastSyncedMessageId).toBe(201);
  });

  test("s4: a marca que vale é a VIGENTE na execução, não a de quando o job foi armado", async () => {
    const ci = 71_005;
    const saver = new MemorySaver();
    await mirror(5005, ci, 200);
    const job = await armAndClaim(ci, 5005, 300, "entre os dois resets");
    // O segundo /reset acontece depois do arm e antes da execução.
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 5005 },
      data: { resetAtMessageId: 400 },
    });

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await reader(saver, ci)()).toEqual([]);
    expect(await threadRow(ci)).toBeNull();
  });

  test("s6: a resposta pré-reset do colega humano é recusada do mesmo jeito", async () => {
    const ci = 71_006;
    const saver = new MemorySaver();
    await mirror(5006, ci, 200);
    const job = await armAndClaim(
      ci,
      5006,
      150,
      "já falei com ele",
      "human_agent",
    );

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await reader(saver, ci)()).toEqual([]);
    const row = await threadRow(ci);
    expect(row).toBeNull();
  });

  test("s7: a thread atravessa duas conversas, e a marca mora em UMA linha", async () => {
    const ci = 71_007;
    const saver = new MemorySaver();
    // O operador digitou o comando na SEGUNDA conversa; a primeira nunca viu reset nenhum.
    await mirror(5007, ci, null);
    await mirror(5008, ci, 200);
    // E o job nomeia a primeira, que é onde a mensagem foi dita.
    const job = await armAndClaim(ci, 5007, 150, "dito na outra conversa");

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    // Ler a marca só da conversa que o job nomeia acha NULL aqui e deixa passar.
    expect(await reader(saver, ci)()).toEqual([]);
    expect(await threadRow(ci)).toBeNull();
  });

  test("s9 e s10: a recusa é terminal e não deixa cópia do texto guardada", async () => {
    const ci = 71_009;
    const saver = new MemorySaver();
    await mirror(5009, ci, 200);
    const job = await armAndClaim(ci, 5009, 150, "texto pré-reset");

    // Pelo worker, e não chamando o handler direto: é `completeJob` que gasta o
    // `JOB_DELETE_ON_DONE`, e é a ausência da linha que prova que nenhuma cópia do texto pré-reset
    // ficou guardada numa tabela que nada varre.
    await runClaimed(job, appDb);
    expect(await reader(saver, ci)()).toEqual([]);
    const sobrou = await suDb.schedulerJob.count({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(threadOf(ci), 150),
      },
    });
    expect(sobrou).toBe(0);
  });

  test("s5: a recusa também vale quando quem roda o job é a DRENAGEM", async () => {
    const ci = 71_005_1;
    const saver = new MemorySaver();
    await mirror(5051, ci, 200);
    // Armada e deixada PENDING: a drenagem é quem reivindica e executa, a pedido de um turno, de um
    // nudge ou da compactação. A cerca mora no job justamente para não depender de cada chamador.
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 5051,
      contactInboxId: ci,
      graphThreadId: threadOf(ci),
      messageId: 150,
      text: "texto pré-reset",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });

    const drained = await drainPendingIngest(
      tenantId,
      threadOf(ci),
      appDb,
      saver,
    );
    expect(drained).not.toBe("deferred");
    expect(await reader(saver, ci)()).toEqual([]);
    expect(await threadRow(ci)).toBeNull();
    // E não fica devendo: uma recusa que devolvesse "adiado" deixaria o turno drenando para sempre.
    const restando = await suDb.schedulerJob.count({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { startsWith: `ingest:${threadOf(ci)}:` },
        status: { in: ["PENDING", "CLAIMED"] },
      },
    });
    expect(restando).toBe(0);
  });

  test("s8: a entrega duplicada é recusada de novo, porque a recusa não marca nada", async () => {
    const ci = 71_008;
    const saver = new MemorySaver();
    await mirror(5081, ci, 200);

    for (const _ of [1, 2]) {
      const job = await armAndClaim(ci, 5081, 150, "texto pré-reset");
      expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
      expect(await reader(saver, ci)()).toEqual([]);
      expect(await threadRow(ci)).toBeNull();
    }
  });

  test("s11: a recusa deixa rastro que a distingue de 'nunca foi armada'", async () => {
    const ci = 71_011;
    const saver = new MemorySaver();
    await mirror(5111, ci, 200);
    const info = spyOn(logger, "info");
    try {
      const recusada = await armAndClaim(ci, 5111, 150, "texto pré-reset");
      await ingestHandler(recusada, appDb, saver);
      const linhas = info.mock.calls.map((c) => c.join(" "));
      const rastro = linhas.filter((l) => l.includes("episode reset"));
      expect(rastro.length).toBeGreaterThan(0);
      // Nomeia a thread, o id e o motivo: depois do fato a tabela responde zero linhas para
      // "recusou", "ingeriu" e "nunca foi armada", então o rastro é a única coisa que separa os três.
      expect(rastro[0]).toContain(threadOf(ci));
      expect(rastro[0]).toContain("150");

      // E DISCRIMINA: a mesma passada ingerindo uma mensagem pós-reset não emite o rastro, senão ele
      // seria ruído constante em vez de sinal.
      info.mockClear();
      const ingerida = await armAndClaim(ci, 5111, 300, "texto pós-reset");
      await ingestHandler(ingerida, appDb, saver);
      expect(
        info.mock.calls
          .map((c) => c.join(" "))
          .filter((l) => l.includes("episode reset")),
      ).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  test("s12: sem /reset nenhum, a ingestão contínua segue exatamente como antes", async () => {
    const ci = 71_012;
    const saver = new MemorySaver();
    await mirror(5012, ci, null);
    const job = await armAndClaim(
      ci,
      5012,
      150,
      "instalação que nunca resetou",
    );

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await reader(saver, ci)()).toEqual([
      expect.stringContaining("instalação que nunca resetou"),
    ]);
    expect((await threadRow(ci))?.lastSyncedMessageId).toBe(150);
  });

  test("s13: a cerca que já existia, do arm-then-reset, continua recusando", async () => {
    const ci = 71_013;
    const saver = new MemorySaver();
    // Sem marca de episódio: o que retira esta linha é a revogação, não a borda.
    await mirror(5013, ci, null);
    const job = await armAndClaim(ci, 5013, 150, "armada antes do reset");
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        revokeJobsByKeyPrefixOn(
          db,
          "INGEST_MESSAGE",
          `ingest:${threadOf(ci)}:`,
        ),
    );

    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await reader(saver, ci)()).toEqual([]);
    expect(await threadRow(ci)).toBeNull();
  });
});
