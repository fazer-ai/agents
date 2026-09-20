import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
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
let outroTenantId = 0n;
let channelId = 0n;
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
  dono: bigint = tenantId,
  claimedAt: Date = past(),
): Promise<bigint> {
  const id = await enqueueJob({
    rearm: "same-work",
    tenantId: dono,
    kind,
    dedupeKey,
    runAt: past(),
    base: appDb,
  });
  await suDb.$executeRaw`
    UPDATE scheduler_jobs
       SET status = 'CLAIMED', claimed_at = ${claimedAt}, attempts = 20,
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

// O reap de UM dono, e o motivo de o argumento vir nomeado: a cerca de
// `scheduler-tenant-fence.test.ts` exige que toda chamada de `reapStaleJobs` num teste carregue um
// tenant, e ela lê o TEXTO do argumento, então `outroTenantId` passaria por chamada solta. Nomeando
// o campo, a cerca vê o que é verdade — os dois reaps são cercados, um por dono.
async function ceifa(dono: { tenantId: bigint }) {
  return reapStaleJobs(
    1_000,
    appDb,
    new Date(),
    dono.tenantId,
    "INGEST_MESSAGE",
  );
}

async function revoga(
  prefix: string,
  kind: "INGEST_MESSAGE" | "DELIVERY_RECOVERY",
) {
  // O quarto argumento é o cliente em que o anúncio pousa, e NÃO o que apaga a linha: o emit é
  // fire-and-forget, então ele não pode viajar na conexão travada do /reset. Em produção o padrão
  // é o cliente do app; aqui é o do banco de teste.
  return runScopedOn(appDb, ctx(), (db) =>
    revokeJobsByKeyPrefixOn(db, kind, prefix, appDb),
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
    outroTenantId = (
      await suDb.tenant.create({
        data: { name: "DLERASED-B", slug: `dlerased-b-${process.pid}` },
      })
    ).id;
    channelId = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "dead-letter-sink",
          type: "webhook",
          url: encryptJson("https://example.com/alert-sink"),
          enabled: true,
          minLevel: "error",
          stages: [],
        },
      })
    ).id;
  });

  afterAll(async () => {
    for (const t of [tenantId, outroTenantId]) {
      if (!t) continue;
      await clearFlowLog(suDb, { tenantId: t });
      await suDb.$executeRaw`DELETE FROM alert_deliveries WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM alert_channels WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${t}`;
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

  // s3 — as duas ordens no mesmo caso, que é o que a s3 pede: a mesma thread perde duas mensagens,
  // uma com o revoke DENTRO da janela e outra com ele depois do anúncio. Duas linhas, uma por
  // mensagem, nenhuma chave repetida.
  test("a ordem em que revoke e anúncio caíram não muda o que o operador vê", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s3b:33");
    await morreComoReaper("INGEST_MESSAGE", async () => {
      expect(await revoga("ingest:t-s3b:", "INGEST_MESSAGE")).toBe(1);
    });
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s3b:34");
    await morreComoReaper("INGEST_MESSAGE", async () => {});
    expect(await revoga("ingest:t-s3b:", "INGEST_MESSAGE")).toBe(1);

    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(2);
    const chaves = linhas.map(
      (l) => (l.detail as Record<string, unknown>).dedupeKey,
    );
    expect(chaves.sort()).toEqual(["ingest:t-s3b:33", "ingest:t-s3b:34"]);
    expect(new Set(chaves).size).toBe(2);
  });

  // s6 — a linha tem que ALCANÇAR o canal, não só a página de Logs. `dead_letter` existe como stage
  // justamente porque é a ele que um canal se inscreve; uma linha que não chega ao ledger de
  // entregas não é anúncio nenhum.
  test("o anúncio da morte apagada chega ao canal de alerta", async () => {
    await limpa();
    await suDb.$executeRaw`DELETE FROM alert_deliveries WHERE tenant_id = ${tenantId}`;
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s6:99");
    await morreComoReaper("INGEST_MESSAGE", async () => {
      expect(await revoga("ingest:t-s6:", "INGEST_MESSAGE")).toBe(1);
    });
    expect(await mortesAnunciadas()).toHaveLength(1);
    const entregas = await suDb.alertDelivery.findMany({
      where: { tenantId, channelId, stage: "dead_letter" },
    });
    expect(entregas).toHaveLength(1);
    expect(entregas[0]?.level).toBe("error");
    expect(entregas[0]?.summary.startsWith("[dead_letter]")).toBe(true);
  });

  // s7 — a atribuição. Em produção o reaper varre `scheduler_jobs` cross-tenant, então duas mortes
  // de tenants diferentes saem no mesmo lote e cada linha tem que ficar sob o dono do job que
  // morreu.
  //
  // O reap aqui é CERCADO por tenant, um por vez, e as duas metades viram um lote só na hora de
  // anunciar. Não é frouxidão: `scheduler-tenant-fence.test.ts` proíbe um reap sem tenant em teste,
  // porque o banco é um por checkout e sob `--parallel` a varredura rouba a linha de outro arquivo,
  // que falha sem nomear quem roubou. O que a s7 pergunta é de quem é cada linha, e isso o lote
  // único do `announceReaped` responde inteiro.
  test("a linha anunciada é do tenant dono do job, e de mais ninguém", async () => {
    await limpa();
    await clearFlowLog(suDb, { tenantId: outroTenantId });
    await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${outroTenantId}`;
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-a:1", tenantId);
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-b:1", outroTenantId);
    const lote = [
      ...(await ceifa({ tenantId })),
      ...(await ceifa({ tenantId: outroTenantId })),
    ];
    expect(lote.filter((r) => r.status === "DEAD")).toHaveLength(2);
    expect(await revoga("ingest:t-a:", "INGEST_MESSAGE")).toBe(1);
    expect(
      await runScopedOn(
        appDb,
        { tenantId: outroTenantId, userId: null, role: "TENANT_ADMIN" },
        (db) =>
          revokeJobsByKeyPrefixOn(db, "INGEST_MESSAGE", "ingest:t-b:", appDb),
      ),
    ).toBe(1);
    await announceReaped(lote, appDb);

    const deA = await mortesAnunciadas();
    expect(deA).toHaveLength(1);
    const dA = deA[0]?.detail as Record<string, unknown>;
    expect(dA.dedupeKey).toBe("ingest:t-a:1");
    const deB = await flowLogRows(suDb, {
      // flowlog-scope: tenant-wide — o sujeito é sob QUAL tenant a linha caiu, e uma leitura presa
      // a um turno não teria como responder: nenhuma destas unidades tem turno.
      where: { tenantId: outroTenantId, stage: "dead_letter" },
      orderBy: { id: "asc" },
    });
    expect(deB).toHaveLength(1);
    const dB = deB[0]?.detail as Record<string, unknown>;
    expect(dB.dedupeKey).toBe("ingest:t-b:1");
  });

  // A morte que o reaper matou sem NINGUÉM ter registrado um erro: um claim que travou não chega ao
  // `failJob`, então a linha não diz por que morreu, e o revoke que a apaga só tem a linha para
  // citar. Sem a sentença gravada, o operador recebe um anúncio sem causa.
  test("a morte sem erro registrado ainda chega nomeando o que a matou", async () => {
    await limpa();
    const id = await claimedAndStale("INGEST_MESSAGE", "ingest:t-s9:91");
    await suDb.$executeRaw`UPDATE scheduler_jobs SET last_error = NULL WHERE id = ${id}`;
    await morreComoReaper("INGEST_MESSAGE", async () => {
      expect(await revoga("ingest:t-s9:", "INGEST_MESSAGE")).toBe(1);
    });
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.errorMessage ?? "").toBe(
      "reaped: the claim never finished",
    );
  });

  // O `LIKE` do revoke é montado à mão agora que a exclusão precisa de RETURNING, e `_` e `%` são
  // caracteres comuns numa dedupeKey. Sem escapar, o `_` vira coringa e o revoke de uma thread leva
  // a morte da vizinha junto — apagada e anunciada sob a chave errada.
  test("um sublinhado na chave não faz o revoke alcançar a thread vizinha", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t_s10:1");
    await claimedAndStale("INGEST_MESSAGE", "ingest:txs10:1");
    expect(await revoga("ingest:t_s10:", "INGEST_MESSAGE")).toBe(1);
    const restante = await suDb.schedulerJob.findMany({
      where: { tenantId },
      select: { dedupeKey: true },
    });
    expect(restante.map((r) => r.dedupeKey)).toEqual(["ingest:txs10:1"]);
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
