import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import { announceDeadRecovery } from "@/modules/chatwoot/recover-delivery";
import { revokeJobsByKeyPrefixOn } from "@/modules/scheduler/service";

// Quem apaga uma morte deve o anúncio dela. `revokeJobsByKeyPrefixOn` deleta a linha `DEAD` de um
// kind `JOB_DELETE_ON_DONE` e devolve as mortes que ninguém anunciou; quem chamou anuncia depois que
// a própria transação é durável (o /reset, provado em chatwoot-reset.test.ts). A linha que o revoke
// devolve é a GENÉRICA, que `emitDeadLetter` reserva a kinds sem hook próprio, senão a mesma morte
// sairia duas vezes. Um hook num kind desses só é seguro se reivindicar a morte pela mesma marca
// (DEAD_LETTER_ANNOUNCED) que o revoke lê.

// Os kinds `JOB_DELETE_ON_DONE` cujo hook reivindica a morte por `announceJobDeath`.
const GANCHO_QUE_REIVINDICA = ["DELIVERY_RECOVERY"];

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe("nenhuma morte apagada sai duas vezes", () => {
  // Os registros do boot, num processo próprio: os registros são globais ao processo, e instalar
  // aqui todo handler de produção mudaria o que o próximo arquivo de teste vê.
  test("nenhum kind delete-on-done registra hook de dead-letter, salvo o que reivindica a morte", async () => {
    const root = join(import.meta.dir, "..", "..");
    const proc = Bun.spawn(
      ["bun", join(root, "tests/fixtures/scheduler/dead-letter-hooks.ts")],
      { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const { hooked, deleteOnDone } = JSON.parse(
      out.trim().split("\n").at(-1) ?? "{}",
    ) as { hooked: string[]; deleteOnDone: string[] };
    // Controle positivo: um registro que não rodou devolveria conjunto vazio e passaria.
    expect(hooked).toContain("DELIVERY_RECOVERY");
    expect(deleteOnDone).toContain("INGEST_MESSAGE");
    expect(
      hooked.filter(
        (k) => deleteOnDone.includes(k) && !GANCHO_QUE_REIVINDICA.includes(k),
      ),
    ).toEqual([]);
  });

  describe.skipIf(!dbUp)("o hook que reivindica", () => {
    let tenantId = 0n;

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "ERASEDHOOK", slug: `erasedhook-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (tenantId) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a morte que o hook de DELIVERY_RECOVERY anunciou não volta no revoke", async () => {
      const prefix = `recover-erased-${process.pid}:`;
      const dead = async (n: number) =>
        suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "DELIVERY_RECOVERY",
            dedupeKey: `${prefix}${n}`,
            status: "DEAD",
            runAt: new Date(),
            payload: {},
            lastError: "recovery: gave up",
          },
          select: { id: true, claimSeq: true, dedupeKey: true },
        });
      const anunciada = await dead(1);
      const calada = await dead(2);
      await announceDeadRecovery(
        {
          id: anunciada.id,
          tenantId,
          kind: "DELIVERY_RECOVERY",
          payload: {},
          dedupeKey: anunciada.dedupeKey,
          attempts: 5,
          claimSeq: anunciada.claimSeq,
        },
        "recovery: gave up",
        appDb,
      );
      const { count, erasedDeaths } = await runScopedOn(
        appDb,
        { tenantId, userId: null, role: "TENANT_ADMIN" },
        (db) => revokeJobsByKeyPrefixOn(db, "DELIVERY_RECOVERY", prefix),
      );
      expect(count).toBe(2);
      // A morte sem anúncio volta (controle positivo), a anunciada pelo hook não.
      expect(erasedDeaths.map((d) => d.jobId)).toEqual([calada.id]);
    });
  });
});
