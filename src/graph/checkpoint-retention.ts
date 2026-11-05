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
  withinGrace,
} from "@/graph/checkpoint-reconcile";
import {
  type BatchGuard,
  type Bounded,
  type CheckpointTable,
  checkpointTransaction,
  SWEEP_ROWS,
} from "@/graph/checkpoint-sweep";
import { getCheckpointPool } from "@/graph/checkpointer";
import { runInPoolClass } from "@/lib/pool-class";

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
// of TOAST and run past the batch's cut, failing on the same thread at every pass.
export const RETENTION_BATCH_BYTES = 32 * 1024 * 1024;

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
    const got = await indexed((query) =>
      retainRows(query, table, due, rows, budget),
    );
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

// A whole pass: the key of `checkpoints` walked once, batch after batch, pausing after each batch that
// deleted something. Stops early, keeping what it did, when `shouldStop` answers true. Null when
// another pass holds the lock. Background work, on the background pool.
const PASS_LOCK = "fazerai:checkpoint-retention";

export function retainCheckpoints(
  pool: Pick<Pool, "connect">,
  opts: RetentionOptions & {
    pauseMs?: number;
    shouldStop?: () => boolean;
    lockConnection?: () => Promise<LockConnection>;
    lockQueryMs?: number;
  } = {},
): Promise<RetentionTotals | null> {
  return runInPoolClass("background", () =>
    holdingPassLock(PASS_LOCK, opts, async (beforeBatch) => {
      const pauseMs = opts.pauseMs ?? RETENTION_PAUSE_MS;
      const threads = new Set<string>();
      const totals: RetentionTotals = {
        threads: 0,
        checkpoints: 0,
        checkpoint_writes: 0,
        checkpoint_blobs: 0,
        bytes: 0,
      };
      let cursor: string | null = "";
      while (cursor !== null) {
        if (opts.shouldStop?.()) break;
        await beforeBatch();
        const res = await retainCheckpointBatch(pool, cursor, opts);
        for (const table of RETAIN_ORDER) totals[table] += res.deleted[table];
        totals.bytes += res.bytes;
        for (const id of res.threads) threads.add(id);
        cursor = res.next;
        if (res.threads.length > 0 && pauseMs > 0)
          await new Promise((r) => setTimeout(r, pauseMs));
      }
      totals.threads = threads.size;
      return totals;
    }),
  );
}

// The timer, on globalThis so `bun --hot` keeps one, and the pass in flight, so two never overlap.
interface Holder {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
}

const KEY = Symbol.for("fazerai.checkpointRetention");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= { timer: null, running: false, stopped: false };
  return g[KEY];
}

async function runPass(): Promise<void> {
  const h = holder();
  if (h.running || h.stopped) return;
  h.running = true;
  const started = Date.now();
  try {
    const totals = await retainCheckpoints(await getCheckpointPool(), {
      shouldStop: () => holder().stopped,
    });
    if (totals === null) return;
    // Every pass logs its summary, the ones that deleted nothing too: it is how an operator sees the
    // pass is armed and what the last one did.
    logger.info(
      { ...totals, ms: Date.now() - started },
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
