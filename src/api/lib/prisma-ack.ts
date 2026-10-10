import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";

// The Chatwoot webhook ack's own pool: the ack writes its ledger row before answering,
// and Chatwoot opens the conversation on a slow or failed ack, so that write must not queue behind the
// turns, flushes and jobs that drain the main pool (./prisma.ts) under a burst. Small on purpose: one
// short transaction per delivery, and every connection here is one the server cannot give the main
// pool. Its own module so a test that swaps the main client's module keeps this one.
const ackPrisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: config.databaseUrl,
    max: config.chatwoot.ackPoolMax,
    // Bounded, both: the ack's write is a batch transaction, which has no `maxWait` of its own, and a
    // wait past Chatwoot's ~5s budget is an escalated conversation whatever it ends in. Past these the
    // write fails and the ack answers 503, which Chatwoot retries.
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
  }),
});

export default ackPrisma;
