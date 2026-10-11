import { Client } from "pg";
import config from "@/config";

// The connections one replica may open, per database server, against what that server accepts.
// Every pool here is lazy, so nothing fails at boot when the sum is too high: it fails later, at the
// first burst, as "too many clients" on whichever pool asks last. Checked at start instead, and a
// replica over the limit refuses to start (docs/deploy.md "Connection budget"). Per replica: N
// replicas open N times this.

export interface PoolShare {
  env: string;
  size: number;
  url: string;
  // Shown with the value when the size was not set on its own.
  note?: string;
}

export function poolShares(): PoolShare[] {
  return [
    {
      env: "DB_POOL_MAX",
      size: config.dbPoolMax,
      url: config.databaseUrl ?? "",
    },
    {
      env: "LANGGRAPH_POOL_MAX",
      size: config.langgraphPoolMax,
      url: config.langgraphDatabaseUrl ?? "",
      ...(config.langgraphPoolFollowsMain
        ? { note: "follows DB_POOL_MAX" }
        : {}),
    },
    {
      env: "CHATWOOT_ACK_POOL_MAX",
      size: config.chatwoot.ackPoolMax,
      url: config.databaseUrl ?? "",
    },
    {
      env: "BACKGROUND_POOL_MAX",
      size: config.backgroundPoolMax,
      url: config.databaseUrl ?? "",
    },
    {
      env: "METRICS_POOL_MAX",
      size: config.metrics.poolMax,
      url: config.databaseUrl ?? "",
    },
  ];
}

// host:port, which is what `max_connections` belongs to: two databases on one server share it. It
// is logged, so a URL that does not parse is never echoed back: it carries the password.
export const UNPARSEABLE_SERVER = "a database URL that does not parse";

export function serverOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return UNPARSEABLE_SERVER;
  }
}

// An error from connecting may quote the connection string it was given.
function withoutUrl(message: string, url: string): string {
  return url ? message.split(url).join("<database URL>") : message;
}

export function groupByServer(pools: PoolShare[]): Map<string, PoolShare[]> {
  const out = new Map<string, PoolShare[]>();
  for (const p of pools) {
    const key = serverOf(p.url);
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return out;
}

export interface ServerLimits {
  maxConnections: number;
  // `superuser_reserved_connections` plus `reserved_connections` (Postgres 16+): slots the runtime
  // role, which is not a superuser, cannot take.
  reserved: number;
}

export function describeShares(pools: PoolShare[]): string {
  return pools
    .map((p) => `${p.env}=${p.size}${p.note ? ` (${p.note})` : ""}`)
    .join(", ");
}

// The refusal for one server, or null when its pools fit. Equal to the limit fits.
export function budgetRefusal(
  server: string,
  pools: PoolShare[],
  limits: ServerLimits,
): string | null {
  const total = pools.reduce((n, p) => n + p.size, 0);
  const available = limits.maxConnections - limits.reserved;
  if (total <= available) return null;
  return (
    `the database pools of this replica can open ${total} connections to ${server}, and that server ` +
    `accepts ${available} from the runtime role (max_connections ${limits.maxConnections} minus ` +
    `${limits.reserved} reserved): ${describeShares(pools)}. Lower them, or raise max_connections ` +
    "on the server. The sum is per replica: each replica opens this many."
  );
}

export class ConnectionBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionBudgetError";
  }
}

// Bounded in both phases, because boot waits on it before binding the port: connecting, and the
// settings query itself (`query_timeout` rejects on the client even when the server stops
// answering). The client is not awaited on the way out, since closing a connection whose server
// went silent can wait as long as the query would have.
type SettingsClient = Pick<Client, "connect" | "query" | "end" | "on">;

export async function readServerLimits(
  url: string,
  open: (options: ConstructorParameters<typeof Client>[0]) => SettingsClient = (
    options,
  ) => new Client(options),
): Promise<ServerLimits> {
  const client = open({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  // A connection the server drops after `connect()` rejects the pending query AND emits `error` on the
  // client; with no listener that event is thrown outside this function and ends the boot, instead of
  // reaching the caller as a server it could not read.
  client.on("error", () => {});
  try {
    await client.connect();
    const { rows } = await client.query<{ m: number; s: number; r: number }>(
      `SELECT current_setting('max_connections')::int AS m,
              current_setting('superuser_reserved_connections')::int AS s,
              COALESCE(current_setting('reserved_connections', true), '0')::int AS r`,
    );
    const row = rows[0];
    if (!row) throw new Error("no settings row");
    return { maxConnections: row.m, reserved: row.s + row.r };
  } finally {
    void client.end().catch(() => {});
  }
}

// One line per server for the boot log, and whether that server's limits could be read.
export interface BudgetLine {
  server: string;
  line: string;
  checked: boolean;
}

// Throws ConnectionBudgetError when any server it could read is over its limit. A server that does not
// answer is reported as not checked and never masks another server's refusal: each server is read on
// its own.
export async function assertConnectionBudget(
  pools: PoolShare[] = poolShares(),
  read: (url: string) => Promise<ServerLimits> = readServerLimits,
): Promise<BudgetLine[]> {
  const lines: BudgetLine[] = [];
  const refusals: string[] = [];
  for (const [server, group] of groupByServer(pools)) {
    const total = group.reduce((n, p) => n + p.size, 0);
    let limits: ServerLimits;
    try {
      limits = await read(group[0]?.url ?? "");
    } catch (error) {
      const reason = withoutUrl((error as Error).message, group[0]?.url ?? "");
      lines.push({
        server,
        checked: false,
        line: `${server}: ${total} connections (${describeShares(group)}), not checked: ${reason}`,
      });
      continue;
    }
    const refusal = budgetRefusal(server, group, limits);
    if (refusal) refusals.push(refusal);
    lines.push({
      server,
      checked: true,
      line: `${server}: ${total} of ${limits.maxConnections - limits.reserved} connections (${describeShares(group)})`,
    });
  }
  if (refusals.length > 0) throw new ConnectionBudgetError(refusals.join(" "));
  return lines;
}
