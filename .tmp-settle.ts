import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import * as fresh from "@/modules/analytics/rollup/store";
import * as old from "@/modules/analytics/rollup/.old-store";
const url = process.env.MIGRATION_DATABASE_URL!.replace("${POSTGRES_PORT}", "5432");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
class Rollback extends Error {}
async function trial(name: string, kind: string, fn: (tx: never) => Promise<number>) {
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '120s'");
      await tx.$executeRawUnsafe(`INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, section, day, data)
        SELECT tenant_id, version, filter_key || g::text, (ARRAY['America/Sao_Paulo','America/Lima','Asia/Tokyo'])[1 + g % 3], section, day, data
          FROM dashboard_days, generate_series(1, 7) g WHERE tenant_id = 1`);
      if (kind === "log")
        await tx.$executeRawUnsafe(`INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at, created_at)
          SELECT tenant_id, conversation_id, 'log', created_at, (now() AT TIME ZONE 'UTC') - interval '1 hour' FROM execution_logs WHERE tenant_id = 1 ORDER BY id LIMIT 124035`);
      else
        await tx.$executeRawUnsafe(`INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at, created_at)
          SELECT tenant_id, ${kind === "reprice-old" ? "conversation_id" : "NULL"}, 'ledger', created_at, (now() AT TIME ZONE 'UTC') - interval '1 hour' FROM llm_usage, generate_series(1,2) WHERE tenant_id = 1 AND created_at >= '2026-09-27 03:00' AND created_at < '2026-09-28 03:00'`);
      const t0 = performance.now();
      const n = await fn(tx as never);
      console.log(name, kind, "batch", n, ((performance.now() - t0) / 1000).toFixed(2), "s");
      throw new Rollback();
    }, { timeout: 600_000, maxWait: 60_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const kind = process.argv[2]!;
if (process.argv[3] !== "new") await trial("old", kind, (tx) => old.settleDirty(tx, "k"));
await trial("new", kind, (tx) => fresh.settleDirty(tx, "k"));
await db.$disconnect();
