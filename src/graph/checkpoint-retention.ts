import { TASKS } from "@langchain/langgraph-checkpoint";
import type { Pool } from "pg";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import config from "@/config";
import {
  holdingPassLock,
  type LockConnection,
  NEWEST_CHECKPOINT_SQL,
  ownerlessThreads,
  reconcileWalkSql,
  threadOwner,
  withinGrace,
} from "@/graph/checkpoint-reconcile";
import {
  type BatchGuard,
  type Bounded,
  type CheckpointTable,
  checkpointTransaction,
  SWEEP_ROWS,
  SweepDeadlineError,
} from "@/graph/checkpoint-sweep";
import { getCheckpointPool } from "@/graph/checkpointer";
import { runInPoolClass } from "@/lib/pool-class";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";

// The periodic pass that keeps, of every live thread, only what the saver resumes from. A thread keeps
// every checkpoint it ever wrote, and every step writes a new version of the `messages` blob holding
// the whole conversation so far, so a conversation of N turns stores about N copies of its own
// history. Nothing reads that history: every reader resumes through `getTuple`/`getState` on the newest checkpoint. What the
// saver reads for a thread (PostgresSaver 1.x, `SELECT_SQL`) is, per namespace, the newest checkpoint,
// the blob versions its `channel_versions` names, and the writes of that checkpoint; a checkpoint of
// format v<4 also reads the TASKS writes of its parent (`SELECT_PENDING_SENDS_SQL`). The pass deletes
// everything else. docs/graph.md has the rest.

// How many distinct thread ids one batch walks, and the pause after a batch that deleted something: a
// thread is about fifty prunable blob rows, most of their bytes in TOAST, and the pass is housekeeping,
// so it goes slowly rather than taking the database's write bandwidth.
export const RETENTION_PROBES = 100;
export const RETENTION_PAUSE_MS = 500;
// The longest one batch's transaction runs.
export const RETENTION_BATCH_MS = 10_000;

// How many stored bytes one statement deletes at most, beside the row bound: the blob of a long
// conversation is hundreds of kilobytes, so a row bound alone would let one statement take gigabytes
// of TOAST and run past the batch's cut, failing on the same thread at every pass. Deleting TOAST
// writes about as much WAL as it deletes (a full-page image per page touched after a checkpoint), so
// this is also what one statement writes in one go, and it has to stay far below `max_wal_size`, or
// each statement forces a checkpoint.
export const RETENTION_BATCH_BYTES = 8 * 1024 * 1024;

// The share of the WAL rate that would force a checkpoint the pass lets the whole instance write, and
// the longest it waits after one batch. Half leaves the other half to the instance's own traffic, and
// the pass counts that traffic too: it measures the instance's WAL, not its own.
export const RETENTION_WAL_SHARE = 0.5;
export const RETENTION_MAX_PAUSE_MS = 60_000;

// What paces the pass: how many bytes of WAL a second the instance may write while it runs, and how
// to read the instance's WAL position. `sleep` and `now` are the test's seams.
export interface RetentionPacing {
  budgetBytesPerSec: number;
  readWal: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// The budget from the server's own settings: Postgres requests a checkpoint once about
// max_wal_size / (1 + checkpoint_completion_target) is written since the last one, and times one every
// checkpoint_timeout, so writing faster than that ratio forces checkpoints. A tuned instance gets its
// own budget.
export async function serverWalPacing(
  pool: Pick<Pool, "connect">,
): Promise<RetentionPacing> {
  const read = async <T>(sql: string): Promise<T | undefined> => {
    const client = await pool.connect();
    try {
      return (await client.query(sql)).rows[0] as T | undefined;
    } finally {
      client.release();
    }
  };
  const s = await read<{ max_wal: string; target: string; timeout: string }>(
    `SELECT (SELECT setting FROM pg_settings WHERE name = 'max_wal_size') AS max_wal,
            (SELECT setting FROM pg_settings WHERE name = 'checkpoint_completion_target') AS target,
            (SELECT setting FROM pg_settings WHERE name = 'checkpoint_timeout') AS timeout`,
  );
  // max_wal_size is in megabytes and checkpoint_timeout in seconds, the units pg_settings reports.
  const forced =
    (Number(s?.max_wal) * 1024 * 1024) /
    (1 + Number(s?.target)) /
    Number(s?.timeout);
  if (!Number.isFinite(forced) || forced <= 0)
    throw new Error("checkpoint retention: unreadable WAL settings");
  return {
    budgetBytesPerSec: forced * RETENTION_WAL_SHARE,
    readWal: async () =>
      Number(
        (
          await read<{ b: number }>(
            // The insert position, which moves as WAL is written; pg_current_wal_lsn moves only when
            // the WAL buffers reach the disk.
            "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '0/0')::float8 AS b",
          )
        )?.b,
      ),
  };
}

// The errors a smaller batch can get past: the batch's cut (statement timeout, or the deadline the
// guard checks itself), a lock it waited on, and a deadlock it lost. Anything else (the connection,
// a missing table) fails the pass as before.
// What a batch that threw had already committed: one transaction per table, so the tables before the
// failing one stay deleted, and the pass counts them although the batch never returned.
const committedBefore = new WeakMap<object, RetentionBatch>();

function retryable(err: unknown): boolean {
  if (err instanceof SweepDeadlineError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === "57014" || code === "55P03" || code === "40P01";
}

// The rows of these threads ($1) the saver does not read, through the primary key in its order, $2
// rows and $3 stored bytes at most per statement (every row weighs one byte at least; the first row
// always goes), deleted by their own address; `more` says a bound left some. Conditions are read when
// the statement runs, so a checkpoint a turn writes meanwhile is the newest and keeps what it names.
// The newest is the greatest `checkpoint_id` under the column's collation, as the saver picks it.
// Each lookup of `checkpoints` runs per row through the key's prefix: `OFFSET 0` keeps the planner from
// making it an anti-join, which on the JSON it cannot index hashes the whole table.
function retainSql(
  table: CheckpointTable,
  dead: string,
  order: string,
  size: (alias: string) => string,
): string {
  return `
  WITH cand AS (
    SELECT x.ctid, greatest(${size("x")}, 1) AS sz FROM langgraph.${table} x
     WHERE x.thread_id = ANY($1::text[]) AND ${dead}
     ORDER BY ${order} LIMIT $2::int + 1),
  pick AS (
    SELECT ctid FROM (
      SELECT ctid, sz, sum(sz) OVER w AS run, row_number() OVER w AS rn
        FROM cand WINDOW w AS (ORDER BY ctid)) s
     WHERE rn <= $2::int AND run - sz < $3::bigint),
  d AS (
    DELETE FROM langgraph.${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM pick))
    RETURNING thread_id, ${size(`langgraph.${table}`)} AS bytes)
  SELECT thread_id, count(*)::int AS n, sum(bytes)::bigint AS bytes,
         (SELECT count(*) FROM cand) > (SELECT count(*) FROM pick) AS more
    FROM d GROUP BY thread_id`;
}

const blobSize = (a: string) => `coalesce(pg_column_size(${a}.blob), 0)`;

export const RETAIN_SQL: Record<CheckpointTable, string> = {
  // A checkpoint goes once a newer one of its namespace exists.
  checkpoints: retainSql(
    "checkpoints",
    `x.checkpoint_id < (
       SELECT max(k.checkpoint_id) FROM langgraph.checkpoints k
        WHERE k.thread_id = x.thread_id AND k.checkpoint_ns = x.checkpoint_ns)`,
    "x.thread_id, x.checkpoint_ns, x.checkpoint_id",
    (a) => `pg_column_size(${a}.checkpoint) + pg_column_size(${a}.metadata)`,
  ),
  // A write is kept while a checkpoint of its namespace is it, and a TASKS write also while one names
  // it as its parent: a v<4 checkpoint reads its pending sends from there, with no need of the parent's
  // row. And only a write of a checkpoint older than the newest one goes: under the graph's async
  // durability a step's writes can be stored before the checkpoint they belong to is, and that
  // checkpoint's id is greater than every committed one (ids grow with time), so the writes of a
  // checkpoint still on its way are never taken for leftovers.
  checkpoint_writes: retainSql(
    "checkpoint_writes",
    `x.checkpoint_id < (
       SELECT max(k.checkpoint_id) FROM langgraph.checkpoints k
        WHERE k.thread_id = x.thread_id AND k.checkpoint_ns = x.checkpoint_ns)
     AND NOT EXISTS (
       SELECT 1 FROM langgraph.checkpoints c
        WHERE c.thread_id = x.thread_id AND c.checkpoint_ns = x.checkpoint_ns
          AND c.checkpoint_id = x.checkpoint_id OFFSET 0)
     AND NOT (x.channel = '${TASKS}' AND EXISTS (
       SELECT 1 FROM langgraph.checkpoints c
        WHERE c.thread_id = x.thread_id AND c.checkpoint_ns = x.checkpoint_ns
          AND c.parent_checkpoint_id = x.checkpoint_id OFFSET 0))`,
    "x.thread_id, x.checkpoint_ns, x.checkpoint_id, x.task_id, x.idx",
    blobSize,
  ),
  // A blob version is kept while a checkpoint of its namespace names it.
  checkpoint_blobs: retainSql(
    "checkpoint_blobs",
    `NOT EXISTS (
       SELECT 1 FROM langgraph.checkpoints c
        WHERE c.thread_id = x.thread_id AND c.checkpoint_ns = x.checkpoint_ns
          AND c.checkpoint -> 'channel_versions' ->> x.channel = x.version OFFSET 0)`,
    "x.thread_id, x.checkpoint_ns, x.channel, x.version",
    blobSize,
  ),
};

// The tables in the order a batch takes them: the old checkpoints first, which is what frees the
// writes and blobs only they named.
const RETAIN_ORDER: CheckpointTable[] = [
  "checkpoints",
  "checkpoint_writes",
  "checkpoint_blobs",
];

export interface RetentionTotals {
  // Distinct threads that lost at least one row.
  threads: number;
  checkpoints: number;
  checkpoint_writes: number;
  checkpoint_blobs: number;
  // pg_column_size of what was deleted: the stored (compressed) size, the figure the space comes from.
  bytes: number;
}

export interface RetentionOptions {
  base?: PrismaClient;
  probes?: number;
  rows?: number;
  bytes?: number;
  graceMs?: number;
  batchMs?: number;
  // Only the threads this answers true for are considered (tests, whose database other files share).
  scope?: (threadId: string) => boolean;
}

export type RetentionBatch = {
  // What this batch deleted, per table, with the threads it took rows from.
  deleted: Record<CheckpointTable, number>;
  bytes: number;
  threads: string[];
  probed: number;
  // Where the next batch starts: the same cursor while a statement reached its bound (the threads
  // still have rows to lose), after the last thread walked otherwise, null once the walk reached the
  // end of the key.
  next: string | null;
};

async function retainRows(
  query: Bounded,
  table: CheckpointTable,
  threadIds: string[],
  rows: number,
  budget: number,
): Promise<{ n: number; bytes: number; threads: string[]; more: boolean }> {
  const res = (await query(RETAIN_SQL[table], [threadIds, rows, budget])) as {
    rows: {
      thread_id: string;
      n: number;
      bytes: string | number | null;
      more: boolean;
    }[];
  };
  let n = 0;
  let bytes = 0;
  for (const r of res.rows) {
    n += r.n;
    bytes += Number(r.bytes ?? 0);
  }
  return {
    n,
    bytes,
    threads: res.rows.map((r) => r.thread_id),
    more: res.rows.some((r) => r.more),
  };
}

// One batch: walks up to `probes` thread ids of `checkpoints` from the cursor, leaves out the threads
// whose owner is gone (the reconciler's, which deletes them whole: two passes deleting the same rows
// in two orders would deadlock one of them) and the ones whose newest checkpoint is younger than the
// grace, and deletes from the rest what nothing reads, up to `rows` rows and `bytes` stored bytes per
// table.
export async function retainCheckpointBatch(
  pool: Pick<Pool, "connect">,
  after = "",
  opts: RetentionOptions = {},
): Promise<RetentionBatch> {
  const probes = opts.probes ?? RETENTION_PROBES;
  const rows = opts.rows ?? SWEEP_ROWS;
  const budget = opts.bytes ?? RETENTION_BATCH_BYTES;
  const graceMs = opts.graceMs ?? config.checkpointRetention.graceMs;
  const scope = opts.scope ?? (() => true);
  const guard: BatchGuard = {
    deadline: Date.now() + (opts.batchMs ?? RETENTION_BATCH_MS),
    beforeCommit: async () => {},
  };
  const none = (): Record<CheckpointTable, number> => ({
    checkpoints: 0,
    checkpoint_writes: 0,
    checkpoint_blobs: 0,
  });
  const walked = await checkpointTransaction(pool, guard, async (query) =>
    (
      (await query(reconcileWalkSql("checkpoints"), [after, probes])) as {
        rows: { thread_id: string }[];
      }
    ).rows.map((r) => r.thread_id),
  );
  const last = walked.at(-1);
  const next = walked.length < probes || last === undefined ? null : last;
  const inScope = walked.filter(scope);
  const gone = await ownerlessThreads(inScope, opts.base);
  const owned = inScope.filter((id) => !gone.has(id));
  const result: RetentionBatch = {
    deleted: none(),
    bytes: 0,
    threads: [],
    probed: walked.length,
    next,
  };
  if (owned.length === 0) return result;
  // Every statement below has a path through the primary key, and the pass is housekeeping that must
  // not read a whole table: on a small one the planner would rather scan it all. Local to each
  // transaction.
  const indexed = <T>(fn: (query: Bounded) => Promise<T>) =>
    checkpointTransaction(pool, guard, async (query) => {
      await query("SET LOCAL enable_seqscan = off", []);
      return fn(query);
    });
  const newest = await indexed(
    async (query) =>
      (
        (await query(NEWEST_CHECKPOINT_SQL, [owned])) as {
          rows: { thread_id: string; ts: string | null }[];
        }
      ).rows,
  );
  // A thread with no checkpoint has no row here and nothing to resume from; its leftovers are the
  // reconciler's or a teardown's, never this pass's.
  const due = newest
    .filter((r) => !withinGrace(r.ts, graceMs))
    .map((r) => r.thread_id);
  if (due.length === 0) return result;
  const touched = new Set<string>();
  let bounded = false;
  // One transaction per table: a thread deleted whole (`deleteThread`, on a reset or a playground
  // session) locks its tables in another order, and a transaction holding one table's rows while
  // waiting on another's would deadlock with it. Each condition is read again when its statement runs,
  // so a batch stopped between tables leaves rows a later one takes, never a thread missing its state.
  for (const table of RETAIN_ORDER) {
    let got: Awaited<ReturnType<typeof retainRows>>;
    try {
      got = await indexed((query) =>
        retainRows(query, table, due, rows, budget),
      );
    } catch (err) {
      result.threads = [...touched];
      if (typeof err === "object" && err !== null)
        committedBefore.set(err, result);
      throw err;
    }
    result.deleted[table] = got.n;
    result.bytes += got.bytes;
    for (const id of got.threads) touched.add(id);
    if (got.more) bounded = true;
    // The writes and blobs are checked against every checkpoint their thread still has, so while old
    // checkpoints are left that check grows with their count (quadratic on a thread of thousands).
    // They wait until the batch's threads are down to their newest checkpoints, a later batch.
    if (table === "checkpoints" && got.more) break;
  }
  result.threads = [...touched];
  // A statement that reached its bound left rows of these threads: the next batch walks them again.
  if (bounded) result.next = after;
  return result;
}

// The thread right after `after` in the key of `checkpoints`, the one a batch of one walks.
async function threadAfter(
  pool: Pick<Pool, "connect">,
  after: string,
): Promise<string | null> {
  const rows = await checkpointTransaction(
    pool,
    undefined,
    async (query) =>
      (
        (await query(reconcileWalkSql("checkpoints"), [after, 1])) as {
          rows: { thread_id: string }[];
        }
      ).rows,
  );
  return rows[0]?.thread_id ?? null;
}

// A whole pass: the key of `checkpoints` walked once, batch after batch. A batch that fails with an
// error a smaller batch can get past is taken again from the same cursor with half the threads, down
// to one; a single thread that still fails is skipped and handed to `onSkip`, and the pass goes on,
// so one stuck thread never leaves every thread after it unpruned. A batch that succeeds lets the size grow back. After a batch that deleted something
// the pass waits `pauseMs`, or, with `pacing`, as long as the instance's WAL since the batch began
// takes at the budget's rate (up to RETENTION_MAX_PAUSE_MS). Stops early, keeping what it did, when
// `shouldStop` answers true. Null when another pass holds the lock. Background work, on the
// background pool.
const PASS_LOCK = "fazerai:checkpoint-retention";

export function retainCheckpoints(
  pool: Pick<Pool, "connect">,
  opts: RetentionOptions & {
    pauseMs?: number;
    pacing?: RetentionPacing;
    onSkip?: (threadId: string, err: unknown) => void;
    shouldStop?: () => boolean;
    lockConnection?: () => Promise<LockConnection>;
    lockQueryMs?: number;
  } = {},
): Promise<RetentionTotals | null> {
  return runInPoolClass("background", () =>
    holdingPassLock(PASS_LOCK, opts, async (beforeBatch) => {
      const pauseMs = opts.pauseMs ?? RETENTION_PAUSE_MS;
      const fullProbes = opts.probes ?? RETENTION_PROBES;
      const pacing = opts.pacing;
      const sleep =
        pacing?.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const readWal = async (): Promise<number | null> => {
        if (!pacing) return null;
        try {
          const b = await pacing.readWal();
          return Number.isFinite(b) ? b : null;
        } catch {
          return null;
        }
      };
      const threads = new Set<string>();
      const totals: RetentionTotals = {
        threads: 0,
        checkpoints: 0,
        checkpoint_writes: 0,
        checkpoint_blobs: 0,
        bytes: 0,
      };
      const add = (res: RetentionBatch) => {
        for (const table of RETAIN_ORDER) totals[table] += res.deleted[table];
        totals.bytes += res.bytes;
        for (const id of res.threads) threads.add(id);
      };
      // The wait after an attempt that may have written, on a virtual clock: each byte of instance WAL
      // since the last reading pushes `ready` forward at the budget's rate, from now when the pass is
      // not behind, and the pass waits until `ready`. The instance's own traffic during a sleep counts,
      // and one wait never pays for two batches. Between `pauseMs` and RETENTION_MAX_PAUSE_MS, with the
      // debt held to that ceiling. A failed attempt waits too: the tables committed before its failing
      // one stay deleted, and a rolled-back delete writes WAL as well.
      const now = pacing?.now ?? Date.now;
      let lastWal: number | null = null;
      let ready = 0;
      const markNow = async () => {
        lastWal = await readWal();
      };
      const pace = async () => {
        let wait = pauseMs;
        const wal = await readWal();
        const at = now();
        if (pacing && lastWal !== null && wal !== null) {
          ready = Math.min(
            Math.max(ready, at) +
              ((wal - lastWal) / pacing.budgetBytesPerSec) * 1000,
            at + RETENTION_MAX_PAUSE_MS,
          );
          wait = Math.max(wait, ready - at);
        }
        lastWal = wal;
        wait = Math.min(wait, RETENTION_MAX_PAUSE_MS);
        if (wait > 0) await sleep(wait);
      };
      let cursor: string | null = "";
      let probes = fullProbes;
      while (cursor !== null) {
        if (opts.shouldStop?.()) break;
        await beforeBatch();
        if (lastWal === null) await markNow();
        let res: RetentionBatch;
        try {
          res = await retainCheckpointBatch(pool, cursor, { ...opts, probes });
        } catch (err) {
          if (!retryable(err)) throw err;
          const partial =
            typeof err === "object" && err !== null
              ? committedBefore.get(err)
              : undefined;
          if (partial) add(partial);
          await pace();
          if (probes > 1) {
            probes = Math.ceil(probes / 2);
            continue;
          }
          const stuck = await threadAfter(pool, cursor);
          if (stuck === null) throw err;
          opts.onSkip?.(stuck, err);
          cursor = stuck;
          probes = fullProbes;
          continue;
        }
        probes = Math.min(fullProbes, probes * 2);
        add(res);
        cursor = res.next;
        if (res.threads.length === 0) continue;
        await pace();
      }
      totals.threads = threads.size;
      return totals;
    }),
  );
}

// The threads skipped by this pass that the previous pass skipped too, announced on `dead_letter`
// (the stage alert channels subscribe to; a pino line reaches nobody) at `warn`, since the next pass
// tries again and nothing was lost. One skip is usually a lock that went away; two in a row is a
// thread the pass cannot prune, and every pass leaves it whole until someone looks. On the background
// pool, like the pass: the flow-log writes and alert dispatches it starts outlive the call, and must
// not take connections from the customer turns.
export function announceStuckThreads(
  previous: ReadonlySet<string>,
  current: readonly string[],
  base?: PrismaClient,
): string[] {
  const stuck = current.filter((id) => previous.has(id));
  runInPoolClass("background", () => {
    for (const id of stuck) {
      const tenantId = threadOwner(id)?.tenantId;
      if (tenantId === undefined) continue;
      emitDeadLetter({
        tenantId,
        unit: "checkpoint_retention",
        level: "warn",
        error:
          "checkpoint retention: a thread failed two passes in a row and was left whole",
        detail: { passes: 2 },
        threadId: id,
        base,
      });
    }
  });
  return stuck;
}

// The timer, on globalThis so `bun --hot` keeps one, the pass in flight, so two never overlap, and the
// threads the last finished pass skipped.
interface Holder {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
  skipped: Set<string>;
}

const KEY = Symbol.for("fazerai.checkpointRetention");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= {
    timer: null,
    running: false,
    stopped: false,
    skipped: new Set(),
  };
  return g[KEY];
}

async function runPass(): Promise<void> {
  const h = holder();
  if (h.running || h.stopped) return;
  h.running = true;
  const started = Date.now();
  try {
    const pool = await getCheckpointPool();
    // Without readable WAL settings the pass falls back to its fixed pause, and says so.
    const pacing = await serverWalPacing(pool).catch((err: unknown) => {
      logger.warn(
        { err },
        "checkpoint retention: cannot read the WAL settings; pacing by the fixed pause",
      );
      return undefined;
    });
    const skipped: string[] = [];
    const totals = await retainCheckpoints(pool, {
      pacing,
      onSkip: (threadId, err) => {
        skipped.push(threadId);
        logger.warn(
          { threadId, code: (err as { code?: unknown } | null)?.code },
          "checkpoint retention: a thread failed alone and was left whole for this pass",
        );
      },
      shouldStop: () => holder().stopped,
    });
    if (totals === null) return;
    announceStuckThreads(h.skipped, skipped);
    h.skipped = new Set(skipped);
    // Every pass logs its summary, the ones that deleted nothing too: it is how an operator sees the
    // pass is armed and what the last one did.
    logger.info(
      { ...totals, skipped: skipped.length, ms: Date.now() - started },
      "checkpoint retention: deleted the checkpoints older than each thread's newest",
    );
  } catch (err) {
    logger.warn(
      { err },
      "checkpoint retention: the pass failed; the next one starts over",
    );
  } finally {
    h.running = false;
  }
}

// Arms the pass: the first one `firstDelayMs` after the boot, then every `intervalMs`. Idempotent.
export function startCheckpointRetention(): void {
  const h = holder();
  if (h.timer !== null) return;
  h.stopped = false;
  const arm = (ms: number) => {
    h.timer = setTimeout(() => {
      void runPass().finally(() => {
        if (!holder().stopped) arm(config.checkpointRetention.intervalMs);
      });
    }, ms);
    h.timer.unref?.();
  };
  arm(config.checkpointRetention.firstDelayMs);
}

// Stops arming passes, and makes the one in flight stop after its current batch.
export function stopCheckpointRetention(): void {
  const h = holder();
  h.stopped = true;
  if (h.timer !== null) clearTimeout(h.timer);
  h.timer = null;
}
