import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  announceErasedDeaths,
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

// O par que o chamador de verdade forma: o revoke devolve as mortes que apagou, e o anúncio sai
// DEPOIS, quando a transação de quem chamou já é durável. Em produção o /reset separa os dois pela
// mesma razão; aqui eles ficam juntos porque não há transação de fora para desfazer nada.
async function revogaDe(
  dono: bigint,
  prefix: string,
  kind: "INGEST_MESSAGE" | "DELIVERY_RECOVERY",
): Promise<number> {
  const { count, erasedDeaths } = await runScopedOn(
    appDb,
    { tenantId: dono, userId: null, role: "TENANT_ADMIN" },
    (db) => revokeJobsByKeyPrefixOn(db, kind, prefix),
  );
  await announceErasedDeaths(erasedDeaths, appDb);
  return count;
}

async function revoga(
  prefix: string,
  kind: "INGEST_MESSAGE" | "DELIVERY_RECOVERY",
) {
  return revogaDe(tenantId, prefix, kind);
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
    expect(await revogaDe(outroTenantId, "ingest:t-b:", "INGEST_MESSAGE")).toBe(
      1,
    );
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
    // A linha DEAD que não diz por que morreu se monta aqui, e não pelo reaper. O reaper não grava
    // `last_error` (nada chega ao `failJob` quando um claim trava), mas ele deixa a linha pronta
    // para o anunciante, que a carimbaria antes de o revoke chegar. O estado que interessa é o de
    // uma linha que JÁ estava DEAD, sem erro e sem recibo, que é o que uma morte anterior a esta
    // entrega é no banco de um operador.
    await suDb.$executeRaw`
      UPDATE scheduler_jobs
         SET status = 'DEAD', attempts = 5, claimed_at = NULL, last_error = NULL
       WHERE id = ${id}`;
    expect(await revoga("ingest:t-s9:", "INGEST_MESSAGE")).toBe(1);
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.errorMessage ?? "").toBe(
      "reaped: the claim never finished",
    );
  });

  // O recibo também protege contra a MESMA passada ser repetida. `announceReaped` caminha um lote,
  // e um chamador que o repita (uma lane que reaproveita o array, uma retentativa) não pode
  // transformar uma morte em duas linhas: a s3 proíbe a mesma morte relatada duas vezes, e nada em
  // `scheduler_jobs` muda entre as duas chamadas para distingui-las.
  test("anunciar o mesmo lote duas vezes escreve uma linha só", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s14:1");
    const lote = await reapStaleJobs(
      1_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(lote.filter((r) => r.status === "DEAD")).toHaveLength(1);
    await announceReaped(lote, appDb);
    expect(await mortesAnunciadas()).toHaveLength(1);
    await announceReaped(lote, appDb);
    expect(await mortesAnunciadas()).toHaveLength(1);
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

  // ACHADO DA RODADA 1 DE REVIEW. O carimbo não pode ser "existe uma marca": ele nomeia a CLAIM
  // cuja morte foi anunciada. Um re-arm SEM payload preserva o payload (é o que `upsertJobRow`
  // promete, e três chamadores de produção não passam payload), então uma marca por presença
  // sobreviveria à ressurreição e calaria para sempre a SEGUNDA morte da mesma linha.
  test("a segunda morte da mesma linha é anunciada, mesmo com o recibo da primeira no payload", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s11:1");
    await morreComoReaper("INGEST_MESSAGE", async () => {});
    expect(await mortesAnunciadas()).toHaveLength(1);
    const comRecibo = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: "ingest:t-s11:1" },
      select: { id: true, payload: true },
    });
    // O recibo da primeira morte está no payload, e é ele que o re-arm sem payload preserva.
    expect(
      (comRecibo.payload as Record<string, unknown>).deadLetterAnnouncedFor,
    ).toBeDefined();

    // Ressuscita SEM payload, como `ensureTenantSweep` e companhia fazem.
    await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "INGEST_MESSAGE",
      dedupeKey: "ingest:t-s11:1",
      runAt: past(),
      base: appDb,
    });
    expect(
      (
        await suDb.schedulerJob.findFirstOrThrow({
          where: { id: comRecibo.id },
          select: { payload: true },
        })
      ).payload as Record<string, unknown>,
    ).toHaveProperty("deadLetterAnnouncedFor");

    await suDb.$executeRaw`
      UPDATE scheduler_jobs
         SET status = 'CLAIMED', claimed_at = ${past()}, attempts = 20,
             claim_seq = claim_seq + 1,
             last_error = 'ingest: falhou de novo'
       WHERE id = ${comRecibo.id}`;
    await morreComoReaper("INGEST_MESSAGE", async () => {});
    // Duas mortes, dois anúncios. Com a marca por presença, a segunda some.
    expect(await mortesAnunciadas()).toHaveLength(2);
  });

  // O MESMO ACHADO pelo outro lado: o revoke tem que julgar o recibo contra a claim da linha que
  // ele está apagando, e não contra a mera existência da chave.
  test("o revoke anuncia a morte nova de uma linha que já carregava o recibo de uma antiga", async () => {
    await limpa();
    const id = await claimedAndStale("INGEST_MESSAGE", "ingest:t-s12:1");
    // O recibo de uma claim ANTERIOR, que é o que um re-arm sem payload deixa para trás.
    await suDb.$executeRaw`
      UPDATE scheduler_jobs
         SET payload = payload || '{"deadLetterAnnouncedFor": "0"}'::jsonb,
             claim_seq = 7
       WHERE id = ${id}`;
    await morreComoReaper("INGEST_MESSAGE", async () => {
      expect(await revoga("ingest:t-s12:", "INGEST_MESSAGE")).toBe(1);
    });
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    const d = linhas[0]?.detail as Record<string, unknown>;
    expect(d.dedupeKey).toBe("ingest:t-s12:1");
  });

  // SEGUNDO ACHADO DA RODADA 1. O revoke não escreve a linha: ele devolve a morte, e quem chamou
  // anuncia quando a própria escrita é durável. Sem isso, um /reset cuja transação desfaz o DELETE
  // já teria anunciado, a linha DEAD voltaria sem recibo, e o próximo anunciante escreveria a mesma
  // morte de novo — que é exatamente o que a s3 proíbe.
  test("um revoke desfeito não anuncia nada, e a morte segue anunciável", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s13:1");
    const reaped = await reapStaleJobs(
      1_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(reaped.filter((r) => r.status === "DEAD")).toHaveLength(1);

    // A transação do chamador desfaz a exclusão, como o /reset faz quando o delete do checkpoint
    // falha. As mortes devolvidas morrem com ela.
    await expect(
      runScopedOn(appDb, ctx(), async (db) => {
        const { count } = await revokeJobsByKeyPrefixOn(
          db,
          "INGEST_MESSAGE",
          "ingest:t-s13:",
        );
        expect(count).toBe(1);
        throw new Error("o delete do checkpoint falhou");
      }),
    ).rejects.toThrow("o delete do checkpoint falhou");

    // A linha voltou, sem recibo...
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, dedupeKey: "ingest:t-s13:1" },
      }),
    ).toBe(1);
    expect(await mortesAnunciadas()).toHaveLength(0);
    // ...e o anunciante que estava esperando ainda escreve a linha, uma vez só.
    await announceReaped(reaped, appDb);
    expect(await mortesAnunciadas()).toHaveLength(1);
  });

  // O `/reset` não pode DEDUZIR que a transação durou, porque um bloco já abortado no Postgres
  // aceita o COMMIT e responde ROLLBACK sem erro: qualquer try/catch acrescentado lá dentro depois
  // faria a dedução mentir, e a mentira sai como linha duplicada. Então o anúncio confere a
  // exclusão contra a linha, e o chamador pode chamá-lo sem saber de nada.
  test("anunciar depois de um rollback não escreve nada, porque a linha voltou", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s15:1");
    const lote = await reapStaleJobs(
      1_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(lote.filter((r) => r.status === "DEAD")).toHaveLength(1);

    let mortes: Awaited<
      ReturnType<typeof revokeJobsByKeyPrefixOn>
    >["erasedDeaths"] = [];
    await expect(
      runScopedOn(appDb, ctx(), async (db) => {
        mortes = (
          await revokeJobsByKeyPrefixOn(db, "INGEST_MESSAGE", "ingest:t-s15:")
        ).erasedDeaths;
        throw new Error("o delete do checkpoint falhou");
      }),
    ).rejects.toThrow("o delete do checkpoint falhou");
    expect(mortes).toHaveLength(1);

    // O chamador anuncia do mesmo jeito, sem perguntar se a transação durou.
    await announceErasedDeaths(mortes, appDb);
    expect(await mortesAnunciadas()).toHaveLength(0);
    // E a morte segue devida a quem a encontrar: a linha voltou sem recibo.
    await announceReaped(lote, appDb);
    expect(await mortesAnunciadas()).toHaveLength(1);
  });

  // As duas formas de uma linha DEAD não dizer por que morreu são DIFERENTES, e confundi-las conta
  // ao operador que o claim não terminou sobre um claim que terminou e falhou. `last_error` null é
  // o reaper; string vazia é o `failJob` sobre um erro sem mensagem.
  test("a morte do failJob sem mensagem não é relatada como claim que não terminou", async () => {
    await limpa();
    const id = await claimedAndStale("INGEST_MESSAGE", "ingest:t-s16:1");
    await suDb.$executeRaw`
      UPDATE scheduler_jobs
         SET status = 'DEAD', attempts = 5, claimed_at = NULL, last_error = ''
       WHERE id = ${id}`;
    expect(await revoga("ingest:t-s16:", "INGEST_MESSAGE")).toBe(1);
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.errorMessage).toBe(
      "dead-lettered: the failure recorded no message",
    );
  });

  // ACHADO DA RODADA 5. Ausência de linha prova que ALGUÉM apagou, não que foi ESTE revoke: um
  // /reset que desfez, com um segundo /reset apagando a linha restaurada e anunciando, deixa o
  // primeiro olhando para uma linha ausente e anunciando a mesma morte de novo. Quem responde isso
  // é o Postgres, sobre a transação em que o DELETE correu.
  test("o revoke desfeito não anuncia nem quando OUTRO reset apagou a linha depois", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s17:1");
    const lote = await reapStaleJobs(
      1_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(lote.filter((r) => r.status === "DEAD")).toHaveLength(1);

    // Reset A: revoga e desfaz.
    let mortesA: Awaited<
      ReturnType<typeof revokeJobsByKeyPrefixOn>
    >["erasedDeaths"] = [];
    await expect(
      runScopedOn(appDb, ctx(), async (db) => {
        mortesA = (
          await revokeJobsByKeyPrefixOn(db, "INGEST_MESSAGE", "ingest:t-s17:")
        ).erasedDeaths;
        throw new Error("o delete do checkpoint falhou");
      }),
    ).rejects.toThrow("o delete do checkpoint falhou");
    expect(mortesA).toHaveLength(1);

    // Reset B: a linha voltou, e este commita e anuncia.
    expect(await revoga("ingest:t-s17:", "INGEST_MESSAGE")).toBe(1);
    expect(await mortesAnunciadas()).toHaveLength(1);

    // Só então A anuncia, olhando para uma linha que de fato não está lá. Uma linha, não duas.
    await announceErasedDeaths(mortesA, appDb);
    expect(await mortesAnunciadas()).toHaveLength(1);
  });

  // O anúncio é trilha, e trilha que não consegue ser escrita não derruba o trabalho que ela
  // descreve. Aqui a própria pergunta ao Postgres falha (transação no futuro), que é o degrau em
  // que um timeout de pool cairia.
  test("uma falha ao conferir a exclusão não escapa para o chamador", async () => {
    await limpa();
    const futuro = await suDb.$queryRaw<Array<{ x: string }>>`
      SELECT (pg_current_xact_id()::text::bigint + 1000000)::text AS x`;
    const morte = {
      tenantId,
      kind: "INGEST_MESSAGE" as const,
      jobId: 1n,
      dedupeKey: "ingest:t-s18:1",
      error: "qualquer",
      xid: futuro[0]?.x as string,
    };
    // Não lança...
    await announceErasedDeaths([morte], appDb);
    // ...e não escreve nada, porque a exclusão não foi confirmada.
    expect(await mortesAnunciadas()).toHaveLength(0);
  });

  // ACHADO DO EXECUTOR DOS CENÁRIOS. `pg_xact_status` LEVANTA sobre um id no futuro, em vez de
  // responder nulo, então uma consulta só sobre o lote inteiro perde TODAS as mortes por causa da
  // única que não deu para ler, e o catch que impede o estrago de vazar para o chamador é o que
  // torna isso silencioso. Uma morte ilegível cala a si mesma, e mais ninguém.
  test("um id de transação ilegível não leva o lote junto", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s19:1");
    const lote = await reapStaleJobs(
      1_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(lote.filter((r) => r.status === "DEAD")).toHaveLength(1);

    const boas = await runScopedOn(appDb, ctx(), (db) =>
      revokeJobsByKeyPrefixOn(db, "INGEST_MESSAGE", "ingest:t-s19:"),
    );
    expect(boas.erasedDeaths).toHaveLength(1);

    const futuro = await suDb.$queryRaw<Array<{ x: string }>>`
      SELECT (pg_current_xact_id()::text::bigint + 1000000)::text AS x`;
    const ilegivel = {
      tenantId,
      kind: "INGEST_MESSAGE" as const,
      jobId: 999_999_999n,
      dedupeKey: "ingest:t-s19:ilegivel",
      error: "qualquer",
      xid: futuro[0]?.x as string,
    };

    await announceErasedDeaths([ilegivel, ...boas.erasedDeaths], appDb);
    const linhas = await mortesAnunciadas();
    expect(linhas).toHaveLength(1);
    const d = linhas[0]?.detail as Record<string, unknown>;
    expect(d.dedupeKey).toBe("ingest:t-s19:1");
  });

  // O MESMO EXECUTOR, o outro alvo. O commit log diz que a TRANSAÇÃO commitou; ele não diz que
  // ESTE `DELETE` sobreviveu a ela, porque um `ROLLBACK TO SAVEPOINT` desfaz o statement dentro de
  // uma transação que segue e commita. Nada no app emite savepoint hoje, e é por isso que a linha
  // também é perguntada.
  test("um DELETE desfeito por savepoint dentro de uma transação que commita não anuncia", async () => {
    await limpa();
    await claimedAndStale("INGEST_MESSAGE", "ingest:t-s20:1");
    const lote = await reapStaleJobs(
      1_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(lote.filter((r) => r.status === "DEAD")).toHaveLength(1);

    const mortes = await runScopedOn(appDb, ctx(), async (db) => {
      await db.$executeRawUnsafe("SAVEPOINT sp_s20");
      const { erasedDeaths } = await revokeJobsByKeyPrefixOn(
        db,
        "INGEST_MESSAGE",
        "ingest:t-s20:",
      );
      await db.$executeRawUnsafe("ROLLBACK TO SAVEPOINT sp_s20");
      return erasedDeaths;
    });
    expect(mortes).toHaveLength(1);

    // A transação commitou, e a linha está de volta: o commit log sozinho anunciaria.
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, dedupeKey: "ingest:t-s20:1" },
      }),
    ).toBe(1);
    await announceErasedDeaths(mortes, appDb);
    expect(await mortesAnunciadas()).toHaveLength(0);
    // E a morte segue devida a quem a encontrar.
    await announceReaped(lote, appDb);
    expect(await mortesAnunciadas()).toHaveLength(1);
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
