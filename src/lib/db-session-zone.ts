import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import ackPrisma from "@/api/lib/prisma-ack";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { getCheckpointPool } from "@/graph/checkpointer";
import { runInPoolClass } from "@/lib/pool-class";
import { SESSION_TIME_ZONE } from "@/lib/session-zone";

// Boot-time fail-fast: every pool's session must run in UTC (./session-zone.ts). Each pool pins it
// at connect, so a session in another zone means the pin did not reach the server, which is what a
// connection pooler that drops or ignores the `options` startup parameter does. A session shifted
// by its offset writes wrong instants silently, so this refuses rather than warns; a pool that does
// not answer only warns, like the runtime role check.

export class SessionZoneError extends Error {
  constructor(offenders: string) {
    super(
      `database sessions must run in ${SESSION_TIME_ZONE}, and these do not: ${offenders}. Every ` +
        "pool asks for it at connect (`options=-c TimeZone=UTC`), so something between the app " +
        "and the server dropped that parameter, typically a connection pooler. Every timestamp " +
        "written or compared with `now()` would be shifted by the zone's offset. Either let the " +
        "`options` startup parameter through, or set the server's zone: " +
        "`ALTER DATABASE <db> SET timezone = 'UTC'` (and on the role, if it sets its own).",
    );
    this.name = "SessionZoneError";
  }
}

// The names Postgres accepts for a zone that is UTC at every instant. A zone that is merely at
// offset 0 today (Europe/London in winter) is not one of them.
const UTC_NAMES = new Set(
  [
    "UTC",
    "Etc/UTC",
    "UCT",
    "Etc/UCT",
    "Universal",
    "Etc/Universal",
    "Zulu",
    "Etc/Zulu",
    "GMT",
    "Etc/GMT",
    "GMT0",
    "Etc/GMT0",
    "GMT+0",
    "Etc/GMT+0",
    "GMT-0",
    "Etc/GMT-0",
    "Greenwich",
    "Etc/Greenwich",
  ].map((n) => n.toLowerCase()),
);

export function isUtcZone(name: string): boolean {
  return UTC_NAMES.has(name.trim().toLowerCase());
}

export interface ZoneProbe {
  pool: string;
  read: () => Promise<string>;
}

const ZONE_SQL = "SELECT current_setting('TimeZone') AS tz";

async function viaPrisma(db: {
  $queryRawUnsafe: <T>(sql: string) => Promise<T>;
}): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ tz: string }[]>(ZONE_SQL);
  const tz = rows[0]?.tz;
  if (typeof tz !== "string") throw new Error("no TimeZone row");
  return tz;
}

export function runtimeZoneProbes(): ZoneProbe[] {
  return [
    { pool: "main", read: () => viaPrisma(basePrisma) },
    {
      pool: "background",
      read: () => runInPoolClass("background", () => viaPrisma(basePrisma)),
    },
    {
      pool: "checkpointer",
      read: async () => {
        const pool = await getCheckpointPool();
        const { rows } = await pool.query<{ tz: string }>(ZONE_SQL);
        const tz = rows[0]?.tz;
        if (typeof tz !== "string") throw new Error("no TimeZone row");
        return tz;
      },
    },
    { pool: "ack", read: () => viaPrisma(ackPrisma) },
    { pool: "instance-health", read: () => viaPrisma(instanceHealthPrisma) },
    { pool: "metrics", read: () => viaPrisma(metricsPrisma) },
  ];
}

// Throws SessionZoneError naming every pool whose session is not UTC. Returns the pools that could
// not be read, which never hide another pool's refusal.
export async function assertSessionZones(
  probes: ZoneProbe[],
): Promise<{ unchecked: { pool: string; error: unknown }[] }> {
  const offenders: string[] = [];
  const unchecked: { pool: string; error: unknown }[] = [];
  for (const probe of probes) {
    let tz: string;
    try {
      tz = await probe.read();
    } catch (error) {
      unchecked.push({ pool: probe.pool, error });
      continue;
    }
    if (!isUtcZone(tz)) offenders.push(`${probe.pool} (${tz})`);
  }
  if (offenders.length > 0) throw new SessionZoneError(offenders.join(", "));
  return { unchecked };
}

export async function checkSessionZoneAtBoot(
  probes: ZoneProbe[] = runtimeZoneProbes(),
): Promise<void> {
  const { unchecked } = await assertSessionZones(probes);
  for (const { pool, error } of unchecked) {
    logger.warn(
      { error },
      `Could not verify the ${pool} pool's session time zone (DB unavailable?); continuing`,
    );
  }
}
