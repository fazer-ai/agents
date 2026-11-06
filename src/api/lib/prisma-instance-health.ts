import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { instanceHealthPoolOptions } from "./pool-options";

// The instance health sampler's own client, one connection: the reads that measure a saturated main
// pool must not queue on it, and must not take a connection from the turns it is measuring. Counted
// in the connection budget (src/lib/db-budget.ts). Bounded like the other side pools: a read that
// cannot get its connection or answer in time fails, and the sampler keeps the last value as old.
const instanceHealthPrisma = new PrismaClient({
  adapter: new PrismaPg(instanceHealthPoolOptions()),
});

export default instanceHealthPrisma;
