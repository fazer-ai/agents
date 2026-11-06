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

// Each probe's whole read, a pool's first connection and the checkpointer's setup included, gets
// this long. Boot awaits the check before starting any worker, and a server that accepts a
// connection and then stops answering would otherwise hold the process there with nothing logged.
export const ZONE_PROBE_TIMEOUT_MS = 5_000;

export class ZoneProbeTimeoutError extends Error {
  constructor(pool: string, ms: number) {
    super(`the ${pool} pool did not answer its time zone within ${ms}ms`);
    this.name = "ZoneProbeTimeoutError";
  }
}

async function bounded(probe: ZoneProbe, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ZoneProbeTimeoutError(probe.pool, ms)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Throws SessionZoneError naming every pool whose session is not UTC. Returns the pools that could
// not be read in time, which never hide another pool's refusal. The probes run side by side, so the
// check costs one probe's bound, not the sum.
export async function assertSessionZones(
  probes: ZoneProbe[],
  timeoutMs: number = ZONE_PROBE_TIMEOUT_MS,
): Promise<{ unchecked: { pool: string; error: unknown }[] }> {
  const read = await Promise.allSettled(
    probes.map((probe) => bounded(probe, timeoutMs)),
  );
  const offenders: string[] = [];
  const unchecked: { pool: string; error: unknown }[] = [];
  read.forEach((outcome, i) => {
    const pool = (probes[i] as ZoneProbe).pool;
    if (outcome.status === "rejected")
      unchecked.push({ pool, error: outcome.reason });
    else if (!isUtcZone(outcome.value))
      offenders.push(`${pool} (${outcome.value})`);
  });
  if (offenders.length > 0) throw new SessionZoneError(offenders.join(", "));
  return { unchecked };
}

export async function checkSessionZoneAtBoot(
  probes: ZoneProbe[] = runtimeZoneProbes(),
  timeoutMs: number = ZONE_PROBE_TIMEOUT_MS,
): Promise<void> {
  const { unchecked } = await assertSessionZones(probes, timeoutMs);
  for (const { pool, error } of unchecked) {
    logger.warn(
      { error },
      `Could not verify the ${pool} pool's session time zone (DB unavailable?); continuing`,
    );
  }
}
