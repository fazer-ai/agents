import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { metricsPoolOptions } from "@/api/lib/pool-options";
import { instrumentPool } from "@/lib/pool-stats";

// The metrics reads' own pool; its options live in ./pool-options.ts.
const metricsPrisma = new PrismaClient({
  adapter: new PrismaPg(
    instrumentPool("metrics", new Pool(metricsPoolOptions())),
    // Built here, so the adapter ends it on `$disconnect` only when told to.
    { disposeExternalPool: true },
  ),
});

export default metricsPrisma;
