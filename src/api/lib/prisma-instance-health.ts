import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { absorbPoolErrors } from "@/lib/pool-errors";
import { instanceHealthPoolOptions } from "./pool-options";

// The instance health sampler's own client, one connection: the reads that measure a saturated main
// pool must not queue on it, and must not take a connection from the turns it is measuring. Counted
// in the connection budget (src/lib/db-budget.ts). Bounded like the other side pools: a read that
// cannot get its connection or answer in time fails, and the sampler keeps the last value as old.
const instanceHealthPrisma = new PrismaClient({
  adapter: new PrismaPg(
    absorbPoolErrors("instance-health", new Pool(instanceHealthPoolOptions())),
    // Built here, so the adapter ends it on `$disconnect` only when told to.
    { disposeExternalPool: true },
  ),
});

export default instanceHealthPrisma;
