#!/usr/bin/env bun
import { connectionErrorCode, isConnectionLoss } from "@/lib/connection-loss";
import { bootstrap } from "./db-bootstrap";

// The database half of the image's boot (Dockerfile CMD): db-bootstrap, then `prisma migrate deploy`,
// each run again while the database is not reachable, up to DB_BOOT_WAIT_MS. A boot that exits at the
// first refused connection is a container the orchestrator restarts into the same refusal, which is
// how a 20s database restart becomes a restart loop and an alert. Any other failure (a bad password,
// a migration that fails) exits at once, as before.

export const DEFAULT_BOOT_WAIT_MS = 120_000;
const MAX_BOOT_WAIT_MS = 2_147_483_647;
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5_000;
// The bound on one connect: `pg`'s default is none.
const CONNECT_BOUND_MS = 10_000;
const MIN_CONNECT_BOUND_MS = 1_000;

// What `prisma migrate deploy` prints when it could not reach the database, or lost it mid-run.
// P1001 unreachable, P1002 timed out, P1017 closed by the server.
const MIGRATE_CONNECTION_LOSS =
  /\b(P1001|P1002|P1017|57P0[123])\b|ECONNREFUSED|ECONNRESET|Connection terminated|the database system is (starting up|shutting down|in recovery mode)/i;

// The part of the migrate output that says the database was not reached, or null.
export function migrateConnectionLoss(output: string): string | null {
  return output.match(MIGRATE_CONNECTION_LOSS)?.[0] ?? null;
}

export class TransientStepError extends Error {}

export interface WaitOptions {
  deadlineMs: number;
  // When the wait began; the steps of one boot share it, so the deadline bounds the whole boot.
  startedAt?: number;
  target: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

function describe(err: unknown): string {
  const code = connectionErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  return [code, message].filter(Boolean).join(": ") || "no detail";
}

// `pg`'s texts for a connect past `connectionTimeoutMillis`, which carry no code.
const CONNECT_TIMEOUT = /timeout expired|due to connection timeout/i;

function transient(err: unknown): boolean {
  if (err instanceof TransientStepError || isConnectionLoss(err)) return true;
  return CONNECT_TIMEOUT.test(err instanceof Error ? err.message : "");
}

// Runs `step` until it resolves, again after each lost-connection failure, with a doubling pause
// capped at MAX_BACKOFF_MS, and no new try past the deadline. `step` gets what is left of the wait,
// to bound its own connect by: a server that accepts the socket and never answers would otherwise
// hold one try, and the boot, forever.
export async function untilReachable<T>(
  name: string,
  step: (leftMs: number) => Promise<T>,
  opts: WaitOptions,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? Bun.sleep;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const startedAt = opts.startedAt ?? now();
  let backoff = FIRST_BACKOFF_MS;
  const expired = (err: unknown) =>
    new Error(
      `db-boot: the database at ${opts.target} was not reached within ${opts.deadlineMs / 1000}s ` +
        `(DB_BOOT_WAIT_MS); last error: ${describe(err)}`,
    );
  let lastError: unknown;
  for (let attempt = 1; ; attempt++) {
    const left = opts.deadlineMs - (now() - startedAt);
    // NOTE: a retry never starts past the deadline, a late timer included; the first try of a step
    // always runs, since the previous step may have spent the wait and succeeded.
    if (attempt > 1 && left <= 0) throw expired(lastError);
    try {
      return await step(Math.max(MIN_CONNECT_BOUND_MS, left));
    } catch (err) {
      if (!transient(err)) throw err;
      lastError = err;
      const after = opts.deadlineMs - (now() - startedAt);
      if (after <= 0) throw expired(err);
      const pause = Math.min(backoff, after);
      log(
        `db-boot: ${name}: the database at ${opts.target} is not reachable (${describe(err)}); ` +
          `attempt ${attempt}, next in ${(pause / 1000).toFixed(1)}s, giving up in ${Math.ceil(after / 1000)}s`,
      );
      await sleep(pause);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

// `host:port/database` of a connection URL, without its credentials, for the log.
export function targetOf(url: string | undefined): string {
  if (!url) return "(MIGRATION_DATABASE_URL unset)";
  try {
    const u = new URL(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${POSTGRES_PORT} placeholder from .env.
      url.replace("${POSTGRES_PORT}", process.env.POSTGRES_PORT ?? "5432"),
    );
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparsable MIGRATION_DATABASE_URL)";
  }
}

export function bootWaitMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_BOOT_WAIT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_BOOT_WAIT_MS) {
    throw new Error(
      `DB_BOOT_WAIT_MS must be a whole number of milliseconds from 1 to ${MAX_BOOT_WAIT_MS}, got "${raw}"`,
    );
  }
  return ms;
}

interface MigrateRun {
  code: number;
  output: string;
}

// `url` with Prisma's `connect_timeout` (whole seconds) set to `seconds`, replacing one it carries.
// A string edit and not `URL`: the `${POSTGRES_PORT}` placeholder is not a port `URL` accepts.
export function withConnectTimeout(url: string, seconds: number): string {
  const value = `connect_timeout=${Math.max(1, Math.ceil(seconds))}`;
  if (/[?&]connect_timeout=[^&]*/.test(url)) {
    return url.replace(/([?&])connect_timeout=[^&]*/, `$1${value}`);
  }
  return `${url}${url.includes("?") ? "&" : "?"}${value}`;
}

// `prisma migrate deploy`, its output passed through to the boot log and kept for the verdict. Its
// connect is bounded like db-bootstrap's, which leaves a migration already running uninterrupted.
async function spawnMigrate(connectTimeoutMs: number): Promise<MigrateRun> {
  const url = process.env.MIGRATION_DATABASE_URL;
  const env = url
    ? {
        ...process.env,
        MIGRATION_DATABASE_URL: withConnectTimeout(
          url,
          connectTimeoutMs / 1000,
        ),
      }
    : process.env;
  const proc = Bun.spawn(["bun", "prisma", "migrate", "deploy"], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  let output = "";
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    sink: NodeJS.WriteStream,
  ) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      sink.write(text);
    }
  };
  const [code] = await Promise.all([
    proc.exited,
    pump(proc.stdout, process.stdout),
    pump(proc.stderr, process.stderr),
  ]);
  return { code, output };
}

// One migrate run: a failure that says the database was not reached is one the boot waits on.
export async function migrateDeploy(
  run: () => Promise<MigrateRun>,
): Promise<void> {
  const { code, output } = await run();
  if (code === 0) return;
  const failure = `prisma migrate deploy exited ${code}`;
  const lost = migrateConnectionLoss(output);
  if (lost) throw new TransientStepError(`${failure} (${lost})`);
  throw new Error(failure);
}

async function main(): Promise<void> {
  const opts = {
    deadlineMs: bootWaitMs(process.env.DB_BOOT_WAIT_MS),
    target: targetOf(process.env.MIGRATION_DATABASE_URL),
    startedAt: Date.now(),
  };
  await untilReachable(
    "db-bootstrap",
    (left) => bootstrap({ connectTimeoutMs: Math.min(CONNECT_BOUND_MS, left) }),
    opts,
  );
  await untilReachable(
    "prisma migrate deploy",
    (left) =>
      migrateDeploy(() => spawnMigrate(Math.min(CONNECT_BOUND_MS, left))),
    opts,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
