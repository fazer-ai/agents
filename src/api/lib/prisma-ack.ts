import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { instrumentPool } from "@/lib/pool-stats";
import { ackPoolOptions } from "./pool-options";

// The Chatwoot webhook ack's own pool: the ack writes its ledger row before answering,
// and Chatwoot opens the conversation on a slow or failed ack, so that write must not queue behind the
// turns, flushes and jobs that drain the main pool (./prisma.ts) under a burst. Small on purpose: one
// short transaction per delivery, and every connection here is one the server cannot give the main
// pool. Its own module so a test that swaps the main client's module keeps this one.
const ackPrisma = new PrismaClient({
  adapter: new PrismaPg(
    instrumentPool("ack", new Pool(ackPoolOptions())),
    // Built here, so the adapter ends it on `$disconnect` only when told to.
    { disposeExternalPool: true },
  ),
});

export default ackPrisma;
