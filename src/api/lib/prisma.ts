import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { lockTimeoutOption } from "@/api/lib/pool-options";
import config from "@/config";
import type { PoolClass } from "@/lib/pool-class";
import { instrumentPool } from "@/lib/pool-stats";
import { routeByPoolClass } from "./pool-route";

// The pool is built here, not by the adapter, so the instance health sampler can read its queue
// (src/lib/pool-stats.ts).
function poolClient(name: PoolClass, max: number): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg(
      instrumentPool(
        name,
        new Pool({
          connectionString: config.databaseUrl,
          max,
          ...lockTimeoutOption(),
        }),
      ),
      // Built here, so the adapter ends it on `$disconnect` only when told to.
      { disposeExternalPool: true },
    ),
  });
}

// One client per class of work (src/lib/pool-class.ts), each with its own pool: `DB_POOL_MAX` for the
// main one (turns, the Chatwoot delivery path, the console), `BACKGROUND_POOL_MAX` for background work.
const clients: Record<PoolClass, PrismaClient> = {
  main: poolClient("main", config.dbPoolMax),
  background: poolClient("background", config.backgroundPoolMax),
};

// The client every module imports, routed by the work running at the moment (./pool-route.ts).
const prisma = routeByPoolClass(clients);

export default prisma;
