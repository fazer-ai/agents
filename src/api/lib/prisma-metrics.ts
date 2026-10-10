import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { lockTimeoutOption } from "@/api/lib/pool-options";
import config from "@/config";

// The metrics reads' own pool (src/modules/analytics, the console's metrics routes and the MCP
// metrics tools, and the authentication of those routes): one dashboard load fires about a dozen
// aggregates, and on the main pool (./prisma.ts) they took the connections turns and ingest need.
// Small on purpose, so a load queues here instead of running every aggregate at once. A query on it
// that does not open a transaction (the session or key lookup in front of a metrics route) waits for
// a connection, and then runs, no longer than a metrics request may.
export function metricsPoolOptions(connectionString = config.databaseUrl) {
  return {
    connectionString,
    max: config.metrics.poolMax,
    connectionTimeoutMillis: config.metrics.timeoutMs,
    statement_timeout: config.metrics.timeoutMs,
    ...lockTimeoutOption(),
  };
}

const metricsPrisma = new PrismaClient({
  adapter: new PrismaPg(metricsPoolOptions()),
});

export default metricsPrisma;
