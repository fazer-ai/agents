import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { lockTimeoutOption } from "@/api/lib/pool-options";
import config from "@/config";
import { currentPoolClass, type PoolClass } from "@/lib/pool-class";

function poolClient(max: number): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: config.databaseUrl,
      max,
      ...lockTimeoutOption(),
    }),
  });
}

// One client per class of work (src/lib/pool-class.ts), each with its own pool: `DB_POOL_MAX` for the
// main one (turns, the Chatwoot delivery path, the console), `BACKGROUND_POOL_MAX` for background work.
const clients: Record<PoolClass, PrismaClient> = {
  main: poolClient(config.dbPoolMax),
  background: poolClient(config.backgroundPoolMax),
};

// The client every module imports. Each access resolves to the pool of the work running at that
// moment, so the about 130 modules that call `runScopedOn` with this client follow the class of the
// entry point that called them without being told. A transaction's own client (`tx`) is the one it
// was opened on, so a transaction never spans two pools.
export function routeByPoolClass(
  byClass: Record<PoolClass, PrismaClient>,
): PrismaClient {
  return new Proxy(byClass.main, {
    get(_target, prop) {
      const client = byClass[currentPoolClass()];
      const value = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

const prisma = routeByPoolClass(clients);

export default prisma;
