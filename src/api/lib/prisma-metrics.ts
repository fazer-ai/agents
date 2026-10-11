import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { metricsPoolOptions } from "@/api/lib/pool-options";

// The metrics reads' own pool; its options live in ./pool-options.ts.
const metricsPrisma = new PrismaClient({
  adapter: new PrismaPg(metricsPoolOptions()),
});

export default metricsPrisma;
