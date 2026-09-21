import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { DEAD_LETTER_ANNOUNCED } from "@/modules/scheduler/service";

// A MIGRAÇÃO DE ROLLOUT DO RECIBO (issue #737, achado da rodada 3 de review).
//
// O carimbo `deadLetterAnnouncedFor` nasce com esta entrega. Uma linha que já estava `DEAD` no dia
// do deploy foi anunciada pelo despachante antigo, que escrevia a linha de log e não tocava no
// payload — então, sem a migração, o primeiro `/reset` que apagasse essa linha anunciaria a mesma
// morte uma segunda vez.
//
// NUM BANCO DE PROVA, e não no banco da suíte (rodada 4 de review). A migração é um UPDATE sobre
// TODAS as linhas `DEAD` de `scheduler_jobs`, sem cerca de tenant nenhuma — é para isso que ela
// existe. Rodando no banco compartilhado, ela carimba a morte que outro arquivo acabou de criar e
// rouba o anúncio dele, que é a mesma família de estrago que `scheduler-tenant-fence.test.ts`
// existe para impedir, e que sob `--parallel` aparece no arquivo roubado.
//
// A migração é LIDA DO DISCO e aplicada verbatim: uma cópia aqui continuaria passando depois de o
// arquivo que ela representa mudar.

const MIGRATION =
  "prisma/migrations/20260920060000_stamp_pre_existing_dead_letter_announcements/migration.sql";

const suUrl = process.env.MIGRATION_DATABASE_URL;
const PROBE_DB = `fazerai_dlstamp_${process.pid}`;
// O DONO da tabela, e não o superusuário. É a diferença que decide o teste: superusuário ignora RLS
// sempre, então rodando como ele o `NO FORCE` da migração não prova nada. `FORCE ROW LEVEL SECURITY`
// existe justamente para sujeitar o DONO à policy, e é num deployment cujo papel de migração é dono
// sem ser superusuário que o incidente da cerca aconteceu (PR #485 rodada 19: a varredura decidiu
// sobre zero linhas e relatou sucesso).
const PROBE_ROLE = `fazerai_dlstamp_owner_${process.pid}`;
const PROBE_PASS = "probe";
let dbUp = false;
let su: Client | undefined;

if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

function probeUrl(comoDono = false): string {
  const u = new URL(suUrl as string);
  u.pathname = `/${PROBE_DB}`;
  if (comoDono) {
    u.username = PROBE_ROLE;
    u.password = PROBE_PASS;
  }
  return u.toString();
}

// O suficiente para a migração morder: as colunas que ela lê e escreve, e o FORCE RLS que ela
// levanta. Sem o FORCE a asserção sobre o `NO FORCE` não prova nada, porque o UPDATE passaria
// igual.
const BASE_SCHEMA = `
  CREATE TYPE "SchedulerJobStatus" AS ENUM ('PENDING','CLAIMED','DONE','DEAD');
  CREATE TABLE scheduler_jobs (
    id bigserial PRIMARY KEY,
    tenant_id bigint NOT NULL,
    dedupe_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    status "SchedulerJobStatus" NOT NULL DEFAULT 'PENDING',
    claim_seq integer NOT NULL DEFAULT 0
  );
  ALTER TABLE scheduler_jobs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE scheduler_jobs FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON scheduler_jobs
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
`;

const DA_DONA = `
  ALTER TABLE scheduler_jobs OWNER TO "${PROBE_ROLE}";
  ALTER TYPE "SchedulerJobStatus" OWNER TO "${PROBE_ROLE}";
  GRANT USAGE ON SCHEMA public TO "${PROBE_ROLE}";
`;

const LINHAS = `
  INSERT INTO scheduler_jobs (tenant_id, dedupe_key, payload, status, claim_seq) VALUES
    (1, 'stamp:morta',      '{"messageId": 10}',                   'DEAD',    3),
    (1, 'stamp:carimbada',  '{"deadLetterAnnouncedFor": "4"}',     'DEAD',    4),
    (1, 'stamp:velha',      '{"deadLetterAnnouncedFor": "2"}',     'DEAD',    9),
    (1, 'stamp:viva',       '{"messageId": 11}',                   'PENDING', 1),
    (1, 'stamp:emvoo',      '{}',                                  'CLAIMED', 5),
    (2, 'stamp:outrotenant','{}',                                  'DEAD',    7);
`;

async function onProbe<T>(
  fn: (c: Client) => Promise<T>,
  comoDono = false,
): Promise<T> {
  const c = new Client({ connectionString: probeUrl(comoDono) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let sql = "";

// Um banco novo por caso, montado e entregue ao papel DONO: a migração roda como ele.
async function bancoDeProva(): Promise<void> {
  const suDb = su as Client;
  await suDb.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  await suDb.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
         CREATE ROLE "${PROBE_ROLE}" LOGIN PASSWORD '${PROBE_PASS}';
       END IF;
     END $$`,
  );
  await suDb.query(`CREATE DATABASE ${PROBE_DB}`);
  await onProbe(async (c) => {
    await c.query(BASE_SCHEMA);
    await c.query(LINHAS);
    await c.query(DA_DONA);
  });
}

describe.skipIf(!dbUp)("o recibo das mortes anteriores à entrega", () => {
  afterAll(async () => {
    if (su) {
      await su.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
      // O papel é do CLUSTER, não do banco: sem isto ele sobrevive a cada rodada da suíte.
      await su.query(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`);
      await su.end();
    }
  });

  // O nome da chave vive no código e no SQL, e os dois têm que dizer a mesma palavra. Um `rename` no
  // TypeScript não alcança uma string dentro de um `.sql`, e a divergência não dá erro: ela volta a
  // anunciar tudo duas vezes, em silêncio.
  test("a migração carimba a mesma chave que o código lê", async () => {
    sql = await Bun.file(MIGRATION).text();
    expect(sql).toContain(DEAD_LETTER_ANNOUNCED);
    expect(sql).toContain("claim_seq::text");
  });

  // O arquivo levanta o FORCE e abre a própria transação: uma falha no meio, sem ela, deixaria a
  // tabela sem FORCE, ou seja, sem sujeitar o próprio dono à policy de tenant.
  test("a migração levanta o FORCE e repõe, dentro de uma transação própria", async () => {
    sql = sql || (await Bun.file(MIGRATION).text());
    expect(sql).toMatch(/^\s*BEGIN;/m);
    expect(sql).toMatch(/^\s*COMMIT;/m);
    expect(sql).toMatch(
      /ALTER TABLE "scheduler_jobs" NO FORCE ROW LEVEL SECURITY/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "scheduler_jobs" FORCE ROW LEVEL SECURITY/,
    );
  });

  test("carimba a linha DEAD com a claim dela, e não toca em mais nada", async () => {
    sql = sql || (await Bun.file(MIGRATION).text());
    await bancoDeProva();
    // A migração roda como o DONO, que é o papel que FORCE sujeita.
    await onProbe(async (c) => {
      await c.query(sql);
    }, true);
    // A leitura roda como SUPERUSUÁRIO, que ignora RLS: o dono não enxergaria as próprias linhas
    // sem `app.tenant_id`, e um SELECT vazio aqui diria "não carimbou" sobre um carimbo que houve.
    const recibos = await onProbe(async (c) => {
      const { rows } = await c.query(
        `SELECT dedupe_key, payload->>'${DEAD_LETTER_ANNOUNCED}' AS recibo,
                payload->>'messageId' AS msg,
                (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'scheduler_jobs') AS force
           FROM scheduler_jobs ORDER BY dedupe_key`,
      );
      return rows as Array<{
        dedupe_key: string;
        recibo: string | null;
        msg: string | null;
        force: boolean;
      }>;
    });

    const por = (k: string) => recibos.find((r) => r.dedupe_key === k);
    expect(por("stamp:morta")?.recibo).toBe("3");
    // Já carimbada com a claim CERTA: a migração não reescreve o que já está correto.
    expect(por("stamp:carimbada")?.recibo).toBe("4");
    // Carimbada com uma claim VELHA, que é o que um re-arm sem payload deixa para trás: a linha
    // está morta numa claim nova e ainda deve o recibo DESTA morte.
    expect(por("stamp:velha")?.recibo).toBe("9");
    // O que não morreu não ganha recibo: quando morrer, o anúncio é devido.
    expect(por("stamp:viva")?.recibo).toBeNull();
    expect(por("stamp:emvoo")?.recibo).toBeNull();
    // Cross-tenant de propósito: a migração roda sem contexto de tenant e tem que alcançar todos.
    expect(por("stamp:outrotenant")?.recibo).toBe("7");
    // O resto do payload sobrevive ao carimbo: ele é a mensagem que a ingestão ia processar.
    expect(por("stamp:morta")?.msg).toBe("10");
    // E o FORCE volta. Sem esta asserção, um arquivo que esquecesse a reposição passaria, deixando
    // a tabela sem sujeitar o dono à policy de tenant para sempre.
    expect(por("stamp:morta")?.force).toBe(true);
  });

  // A prova de que o `NO FORCE` é o que faz o UPDATE morder. Sem ele, o dono é sujeito à policy e,
  // sem `app.tenant_id`, a policy não casa com nada: o UPDATE decide sobre zero linhas e relata
  // sucesso, que é o modo de falhar mais caro que existe aqui.
  test("sem o NO FORCE, o mesmo UPDATE decide sobre zero linhas", async () => {
    sql = sql || (await Bun.file(MIGRATION).text());
    const semBypass = sql
      .replace(
        /ALTER TABLE "scheduler_jobs" NO FORCE ROW LEVEL SECURITY;\n/,
        "",
      )
      .replace(/ALTER TABLE "scheduler_jobs" FORCE ROW LEVEL SECURITY;\n/, "");
    await bancoDeProva();
    await onProbe(async (c) => {
      await c.query(semBypass);
    }, true);
    const recibo = await onProbe(async (c) => {
      const { rows } = await c.query(
        `SELECT payload->>'${DEAD_LETTER_ANNOUNCED}' AS recibo
           FROM scheduler_jobs WHERE dedupe_key = 'stamp:morta'`,
      );
      return (rows[0] as { recibo: string | null }).recibo;
    });
    expect(recibo).toBeNull();
  });
});
