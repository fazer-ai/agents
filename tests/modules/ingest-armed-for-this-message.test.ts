import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { ingestDedupeKey } from "@/graph/ingest-job";

// ── "NENHUMA INGESTÃO FOI ARMADA PARA ESTA MENSAGEM" NÃO É UMA CONTAGEM ──
// A população de linhas `INGEST_MESSAGE` do tenant não é estável (a linha é APAGADA ao concluir), então
// a pergunta certa nomeia a linha: `ingestDedupeKey(graphThreadId, messageId)`, a mesma chave que a
// produção monta.

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
  // A mensagem sob teste, e vizinhas da mesma thread.
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

  test("a chave nomeia a mensagem, e é ela que a produção usa para montar a linha", () => {
    expect(ingestDedupeKey(thread, mine)).toBe(`ingest:${thread}:${mine}`);
    // Duas mensagens da mesma thread nunca colidem, que é a razão de a linha ser apagada ao concluir.
    expect(ingestDedupeKey(thread, mine)).not.toBe(
      ingestDedupeKey(thread, others[0] as number),
    );
  });
});
