import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { DEAD_LETTER_ANNOUNCED } from "@/modules/scheduler/service";

// A MIGRAÇÃO DE ROLLOUT DO RECIBO (issue #737, achado da rodada 3 de review).
//
// O carimbo `deadLetterAnnouncedFor` nasce com esta entrega. Uma linha que já estava `DEAD` no dia
// do deploy foi anunciada pelo despachante antigo, que escrevia a linha de log e não tocava no
// payload — então, sem a migração, o primeiro `/reset` que apagasse essa linha anunciaria a mesma
// morte uma segunda vez.
//
// O teste roda o TEXTO DO ARQUIVO, não uma cópia dele: uma asserção sobre SQL reescrito à mão prova
// que a cópia funciona, e é a versão embarcada que vai rodar no banco de alguém.

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
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

const ARQUIVO =
  "prisma/migrations/20260920060000_stamp_pre_existing_dead_letter_announcements/migration.sql";

let sql = "";
let tenantId = 0n;

describe.skipIf(!dbUp)("o recibo das mortes anteriores à entrega", () => {
  beforeAll(async () => {
    sql = await Bun.file(ARQUIVO).text();
    const t = await suDb.tenant.create({
      data: { name: "DLSTAMP", slug: `dlstamp-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRaw`DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
  });

  // O nome da chave vive no código e no SQL, e os dois têm que dizer a mesma palavra. Um `rename` no
  // TypeScript não alcança uma string dentro de um `.sql`, e a divergência não dá erro: ela volta a
  // anunciar tudo duas vezes, em silêncio.
  test("a migração carimba a mesma chave que o código lê", () => {
    expect(sql).toContain(DEAD_LETTER_ANNOUNCED);
    expect(sql).toContain("claim_seq::text");
  });

  // O arquivo abre a própria transação porque o meio-aplicado aqui não é "algumas linhas migradas",
  // é metade das mortes antigas devendo um anúncio que elas não devem.
  test("a migração roda numa transação própria", () => {
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*COMMIT;/m);
  });

  test("carimba a linha DEAD sem recibo, com a claim dela, e não toca em mais nada", async () => {
    const mk = async (
      dedupeKey: string,
      status: "DEAD" | "PENDING" | "CLAIMED",
      claimSeq: number,
      payload: string,
    ) => {
      const rows = await suDb.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO scheduler_jobs
          (tenant_id, kind, dedupe_key, run_at, payload, status, claim_seq, created_at, updated_at)
        VALUES (${tenantId}, 'INGEST_MESSAGE'::"SchedulerJobKind", ${dedupeKey}, now(),
                ${payload}::jsonb, ${status}::"SchedulerJobStatus", ${claimSeq}, now(), now())
        RETURNING id`;
      return rows[0]?.id as bigint;
    };

    const morta = await mk("stamp:morta", "DEAD", 3, '{"messageId": 10}');
    // Já carimbada, e com a claim CERTA: a migração não pode reescrever o que já está correto.
    const carimbada = await mk(
      "stamp:carimbada",
      "DEAD",
      4,
      '{"deadLetterAnnouncedFor": "4"}',
    );
    // Carimbada com uma claim VELHA, que é o que um re-arm sem payload deixa para trás. A linha
    // está DEAD numa claim nova e ainda deve o recibo desta morte.
    const velha = await mk(
      "stamp:velha",
      "DEAD",
      9,
      '{"deadLetterAnnouncedFor": "2"}',
    );
    const viva = await mk("stamp:viva", "PENDING", 1, '{"messageId": 11}');
    const emVoo = await mk("stamp:emvoo", "CLAIMED", 5, "{}");

    await suDb.$executeRawUnsafe(sql);

    const recibo = async (id: bigint) =>
      (
        await suDb.$queryRaw<Array<{ v: string | null }>>`
          SELECT payload->>${DEAD_LETTER_ANNOUNCED} AS v
            FROM scheduler_jobs WHERE id = ${id}`
      )[0]?.v ?? null;

    expect(await recibo(morta)).toBe("3");
    expect(await recibo(carimbada)).toBe("4");
    // A que carregava a claim velha passa a nomear a claim em que ela está morta agora.
    expect(await recibo(velha)).toBe("9");
    // O que não morreu não ganha recibo nenhum: quando morrer, o anúncio é devido.
    expect(await recibo(viva)).toBeNull();
    expect(await recibo(emVoo)).toBeNull();

    // E o resto do payload sobrevive ao carimbo: ele é a mensagem que a ingestão ia processar.
    const restante = await suDb.$queryRaw<Array<{ m: string | null }>>`
      SELECT payload->>'messageId' AS m FROM scheduler_jobs WHERE id = ${morta}`;
    expect(restante[0]?.m).toBe("10");
  });

  // A prova de que ela morde: sem a migração, a linha antiga é classificada como devendo o anúncio,
  // que é o defeito de rollout que a rodada 3 achou.
  test("sem o carimbo, a linha antiga contaria como anúncio devido", async () => {
    const rows = await suDb.$queryRaw<Array<{ deve: boolean }>>`
      SELECT ('{"messageId": 10}'::jsonb->>${DEAD_LETTER_ANNOUNCED}
              IS DISTINCT FROM '3') AS deve`;
    expect(rows[0]?.deve).toBe(true);
  });
});
