import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  claimPendingByKeyPrefix,
  completeJob,
  enqueueJob,
  reapStaleJobs,
  revokeJobsByKeyPrefixOn,
} from "@/modules/scheduler/service";
import { announceReaped } from "@/modules/scheduler/worker";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";

// ── A MORTE QUE OUTRO APAGOU (issue #737) ──
//
// O anúncio genérico de dead-letter relê a linha do job antes de escrever e trata LINHA AUSENTE como
// "o trabalho terminou". Para um kind `JOB_DELETE_ON_DONE` essa justificativa só vale se a conclusão
// for a única coisa que apaga a linha, e para `INGEST_MESSAGE` não é: o `/reset` revoga a ingestão da
// thread com um `deleteMany` que inclui `DEAD` de propósito — a linha guarda o corpo cifrado da
// mensagem, e nada varre essa tabela, então deixá-la seria confirmar "memória apagada" sobre uma
// cópia guardada da conversa.
//
// "Sem linha" tem portanto DUAS origens, e é o par de casos aqui que prova que ela não classifica
// sozinha: o revoke apagou (perda real, muda) e o trabalho foi REFEITO e concluído (não é perda).
// Um conserto que faça toda linha ausente anunciar troca um silêncio real por uma rajada de erros
// que não aconteceram, e é por isso que os dois casos moram no mesmo arquivo.
//
// A janela é montada pelo seam PÚBLICO do caminho do reaper, sem tocar no código da entrega:
// `reapStaleJobs` devolve o lote já `DEAD` e `announceReaped` roda depois, então o que couber entre
// as duas chamadas cai exatamente dentro da janela.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const past = () => new Date(Date.now() - 60_000);

// `MAX_ATTEMPTS` é privado do módulo, e o teste não deveria repetir o número: o que ele precisa é de
// uma linha CLAIMED cuja próxima tentativa seja a última. Pôr `attempts` alto o bastante e deixar o
// reaper decidir mantém a asserção sobre o ESTADO ("o lote voltou DEAD") em vez de sobre a constante.
async function claimedAndStale(
  kind: "INGEST_MESSAGE" | "DELIVERY_RECOVERY",
  dedupeKey: string,
): Promise<bigint> {
  const id = await enqueueJob({
    rearm: "same-work",
    tenantId,
    kind,
    dedupeKey,
    runAt: past(),
    base: appDb,
  });
  await suDb.$executeRaw`
    UPDATE scheduler_jobs
       SET status = 'CLAIMED', claimed_at = ${past()}, attempts = 20,
           last_error = 'ingest: the model refused five times'
     WHERE id = ${id}`;
  return id;
}

// As duas metades do caminho do reaper, com um gancho no meio: o que `entre` fizer cai dentro da
// janela que a issue descreve, entre a escrita do DEAD e a releitura do anúncio.
async function morreComoReaper(
  kind: "INGEST_MESSAGE" | "DELIVERY_RECOVERY",
  entre: () => Promise<void>,
): Promise<void> {
  const reaped = await reapStaleJobs(1_000, appDb, new Date(), tenantId, kind);
  // Controle positivo da montagem: sem isto, um cenário que não matou nada passaria por "não
  // anunciou" exatamente como passaria o código consertado.
  expect(reaped.filter((r) => r.status === "DEAD").length).toBeGreaterThan(0);
  await entre();
  await announceReaped(reaped, appDb);
}

async function revoga(
  prefix: string,
  kind: "INGEST_MESSAGE" | "DELIVERY_RECOVERY",
) {
  return runScopedOn(appDb, ctx(), (db) =>
    revokeJobsByKeyPrefixOn(db, kind, prefix),
  );
}

async function mortesAnunciadas() {
  return flowLogRows(suDb, {
    // flowlog-scope: tenant-wide — o sujeito é QUANTAS linhas uma morte escreveu, e nenhuma destas
    // unidades tem turno. O tenant é deste arquivo, e `limpa()` o esvazia antes de cada caso.
    where: { tenantId, stage: "dead_letter" },
    orderBy: { id: "asc" },
  });
}

async function limpa() {
  await clearFlowLog(suDb, { tenantId });
  await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`;
}

describe.skipIf(!dbUp)("uma morte que outro apagou na janela", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DLERASED", slug: `dlerased-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // s1 — o instrumento, provado antes de qualquer veredito dos outros. Um arquivo em que esta falha
  // não tem como dizer nada sobre os casos difíceis: "nenhuma linha" passaria a ser o estado normal.
  test("uma ingestão que morre sem ninguém tocar na linha dela é anunciada", async () => {
    await limpa();
    const id = await claimedAndStale("INGEST_MESSAGE", "ingest:t-s1:11");
    await morreComoReaper("INGEST_MESSAGE", async () => {});
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    const d = linhas[0]?.detail as Record<string, unknown>;
    expect(d.unit).toBe("job");
    expect(d.kind).toBe("INGEST_MESSAGE");
    expect(d.dedupeKey).toBe("ingest:t-s1:11");
    expect(d.jobId).toBe(String(id));
    expect(linhas[0]?.level).toBe("error");
    expect(linhas[0]?.status).toBe("error");
    expect(linhas[0]?.errorMessage ?? "").not.toBe("");
  });

  // s2 — a issue. A linha some pelo revoke DENTRO da janela, e o operador tem que aprender a mesma
  // coisa que aprendeu na s1: qual mensagem morreu e com qual erro.
  test("o revoke apagar a linha na janela não cala o anúncio", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s2:22");
    await morreComoReaper("INGEST_MESSAGE", async () => {
      expect(await revoga("ingest:t-s2:", "INGEST_MESSAGE")).toBe(1);
    });
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    const d = linhas[0]?.detail as Record<string, unknown>;
    expect(d.kind).toBe("INGEST_MESSAGE");
    expect(d.dedupeKey).toBe("ingest:t-s2:22");
    expect(linhas[0]?.level).toBe("error");
    expect(linhas[0]?.errorMessage ?? "").not.toBe("");
    // Sem isto o caso mediu o fácil: a linha tem que ter mesmo sumido, porque é o corpo cifrado da
    // mensagem que o /reset foi mandado apagar.
    const sobrou = await suDb.schedulerJob.count({
      where: { tenantId, dedupeKey: { startsWith: "ingest:t-s2:" } },
    });
    expect(sobrou).toBe(0);
  });

  // s5 — o espelho, e a razão de "sem linha" não classificar sozinho. Mesmo estado observável da
  // s2, motivo oposto: o trabalho foi REFEITO e concluído, e `completeJob` apagou a linha.
  test("uma morte desfeita por um re-arm que CONCLUIU na janela continua sem anúncio", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s5:55");
    await morreComoReaper("INGEST_MESSAGE", async () => {
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: "ingest:t-s5:55",
        runAt: past(),
        base: appDb,
      });
      const novo = (
        await claimPendingByKeyPrefix(
          "INGEST_MESSAGE",
          "ingest:t-s5:",
          10,
          appDb,
          tenantId,
        )
      ).find((j) => j.dedupeKey === "ingest:t-s5:55");
      expect(novo).toBeDefined();
      expect(
        await completeJob(
          tenantId,
          novo?.id as bigint,
          novo?.claimSeq as number,
          "INGEST_MESSAGE",
          appDb,
        ),
      ).toEqual({ applied: true });
    });
    // A linha sumiu pelo mesmo motivo aparente da s2 — e não há nada para anunciar.
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, dedupeKey: "ingest:t-s5:55" },
      }),
    ).toBe(0);
    expect(await mortesAnunciadas()).toHaveLength(0);
  });

  // s4 — a outra ponta do risco de sobre-correção: trabalho que o operador mandou cancelar não é
  // perda para anunciar. Um conserto que anuncie toda linha apagada transforma um /reset numa rajada.
  test("o /reset não anuncia como perda o trabalho que ele mesmo revogou", async () => {
    await limpa();
    for (const m of [66, 67, 68]) {
      await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: `ingest:t-s4:${m}`,
        runAt: past(),
        base: appDb,
      });
    }
    expect(await revoga("ingest:t-s4:", "INGEST_MESSAGE")).toBe(3);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, dedupeKey: { startsWith: "ingest:t-s4:" } },
      }),
    ).toBe(0);
    expect(await mortesAnunciadas()).toHaveLength(0);
  });

  // s3, metade da ordem inversa — o revoke chega DEPOIS do anúncio ter rodado inteiro. A mesma morte
  // não pode ser relatada duas vezes, nem por dois caminhos de anúncio.
  test("a mesma morte não é anunciada duas vezes quando o revoke chega depois", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s3:33");
    await morreComoReaper("INGEST_MESSAGE", async () => {});
    expect(await mortesAnunciadas()).toHaveLength(1);
    expect(await revoga("ingest:t-s3:", "INGEST_MESSAGE")).toBe(1);
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    const chaves = linhas.map(
      (l) => (l.detail as Record<string, unknown>).dedupeKey,
    );
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  // O OUTRO kind `JOB_DELETE_ON_DONE`. Hoje o operador não alcança este caso — o revoke tem um
  // chamador só — mas um conserto amarrado ao literal `INGEST_MESSAGE` deixaria este exposto no dia
  // em que aparecer o segundo, e o dia não avisa.
  test("o outro kind delete-on-done recebe o mesmo tratamento", async () => {
    await limpa();
    await claimedAndStale("DELIVERY_RECOVERY", "recover:t-s8:88");
    await morreComoReaper("DELIVERY_RECOVERY", async () => {
      expect(await revoga("recover:t-s8:", "DELIVERY_RECOVERY")).toBe(1);
    });
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    const d = linhas[0]?.detail as Record<string, unknown>;
    expect(d.kind).toBe("DELIVERY_RECOVERY");
  });
});
