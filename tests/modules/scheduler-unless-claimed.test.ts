import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  claimDueJobs,
  enqueueJob,
  enqueueJobUnlessClaimed,
} from "@/modules/scheduler/service";

// `enqueueJobUnlessClaimed`, estado por estado (issue #786): uma linha CLAIMED fica intocada, e todo
// outro estado se arma exatamente como `enqueueJob` arma, que é o contrato que a varredura do
// follow-up sempre teve. A segunda metade é a que impede a guarda de ficar larga demais.
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
const KEY = "followup:unless-claimed";

function arm(runAt: Date, payload: Record<string, unknown> = { v: "sweep" }) {
  return {
    tenantId,
    kind: "FOLLOWUP" as const,
    dedupeKey: KEY,
    runAt,
    payload,
    rearm: "same-work" as const,
    base: appDb,
  };
}

async function row() {
  return suDb.schedulerJob.findFirstOrThrow({
    where: { tenantId, kind: "FOLLOWUP", dedupeKey: KEY },
    select: {
      id: true,
      status: true,
      payload: true,
      claimSeq: true,
      runAt: true,
      attempts: true,
      lastError: true,
      payloadSecret: true,
      updatedAt: true,
    },
  });
}

describe.skipIf(!dbUp)("enqueueJobUnlessClaimed (issue #786)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "UC786", slug: `uc786-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an absent row is created PENDING", async () => {
    expect(await enqueueJobUnlessClaimed(arm(new Date()))).toBe(true);
    const r = await row();
    expect(r.status).toBe("PENDING");
    expect(r.payload).toEqual({ v: "sweep" });
  });

  test("a CLAIMED row is left exactly as the claim holds it", async () => {
    const [claimed] = await claimDueJobs(50, appDb, new Date(), tenantId);
    expect(claimed?.dedupeKey).toBe(KEY);
    const held = await row();
    expect(held.status).toBe("CLAIMED");
    expect(
      await enqueueJobUnlessClaimed(arm(new Date(Date.now() + 5_000))),
    ).toBe(false);
    expect(await row()).toEqual(held);
  });

  test("every other state is armed the way enqueueJob arms it", async () => {
    const { id } = await row();
    for (const status of ["PENDING", "DONE", "FAILED", "DEAD"] as const) {
      const seed = {
        status,
        payload: { v: "handler", stepIndex: 1 },
        payloadSecret: "body of the previous arming",
        attempts: 3,
        lastError: "boom",
      };
      const runAt = new Date(Date.now() + 60_000);
      await suDb.schedulerJob.update({ where: { id }, data: seed });
      expect(await enqueueJobUnlessClaimed(arm(runAt))).toBe(true);
      const { updatedAt: _a, ...viaUnlessClaimed } = await row();
      await suDb.schedulerJob.update({ where: { id }, data: seed });
      await enqueueJob(arm(runAt));
      const { updatedAt: _b, ...viaEnqueue } = await row();
      expect(viaUnlessClaimed).toEqual(viaEnqueue);
      expect(viaUnlessClaimed.status).toBe("PENDING");
      expect(viaUnlessClaimed.payload).toEqual({ v: "sweep" });
      expect(viaUnlessClaimed.attempts).toBe(3);
      expect(viaUnlessClaimed.lastError).toBeNull();
      expect(viaUnlessClaimed.payloadSecret).toBeNull();
    }
  });

  // A corrida da issue na ordem que uma leitura seguida de escrita perderia: a varredura lê PENDING,
  // a reivindicação comita, e só então o arme escreve. O arme espera o lock da linha e reavalia a
  // condição contra a versão reivindicada.
  test("a claim that commits while the arm waits on the row lock still wins", async () => {
    const { id } = await row();
    await suDb.schedulerJob.update({
      where: { id },
      data: { status: "PENDING", payload: { v: "queued" } },
    });
    let armed: boolean | undefined;
    let settled = false;
    await suDb.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE scheduler_jobs
           SET status = 'CLAIMED', claim_seq = claim_seq + 1,
               payload = '{"v":"running","stepIndex":0}'::jsonb
         WHERE id = ${id}`;
      const arming = enqueueJobUnlessClaimed(arm(new Date())).then((r) => {
        armed = r;
        settled = true;
      });
      await Bun.sleep(300);
      // O rendezvous disparou: o arme está parado no lock, não terminou antes da reivindicação.
      expect(settled).toBe(false);
      void arming;
    });
    while (!settled) await Bun.sleep(10);
    expect(armed).toBe(false);
    const r = await row();
    expect(r.status).toBe("CLAIMED");
    expect(r.payload).toEqual({ v: "running", stepIndex: 0 });
  });

  // O outro lado do raio: quem arma pelo `enqueueJob` continua suplantando a execução em voo. A
  // rajada que continua uma janela de debounce depende disso para a mensagem nova não se perder.
  test("enqueueJob still re-arms a CLAIMED row, which is what every other caller relies on", async () => {
    const { id } = await row();
    await suDb.schedulerJob.update({
      where: { id },
      data: { status: "PENDING", runAt: new Date(Date.now() - 1_000) },
    });
    const [claimed] = await claimDueJobs(50, appDb, new Date(), tenantId);
    expect(claimed?.dedupeKey).toBe(KEY);
    await enqueueJob(arm(new Date(), { v: "new-burst" }));
    const r = await row();
    expect(r.status).toBe("PENDING");
    expect(r.payload).toEqual({ v: "new-burst" });
  });
});
