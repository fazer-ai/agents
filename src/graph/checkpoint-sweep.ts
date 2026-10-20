import type { Pool, PoolClient } from "pg";

// Deleting the checkpoints of what a teardown removes, by thread id prefix (`tenant:instance:` for an
// account, `tenant:` for a tenant): the `langgraph` tables carry no tenant and no foreign key, so no
// cascade reaches them. Under the database's collation (`en_US` in production) the prefix uses no
// index and a range does not bound it, so a batch walks the primary key's distinct thread ids from a
// cursor, one index probe each, and deletes the ones under the prefix. docs/chatwoot.md has the rest.

// How many distinct thread ids one batch walks at most, and how many of the ones under the prefix it
// deletes. A thread is about fifty blob rows in production, most of their bytes in TOAST, so the
// second number is what keeps one batch's delete short.
export const SWEEP_PROBES = 2_000;
export const SWEEP_THREADS = 50;
// How many rows one batch deletes at most: a thread keeps its checkpoint history, so a
// long-lived one has no bound of its own, and a batch that never fits its deadline would be retried
// on the same threads forever. What does not fit is the next batch's, from the same cursor.
export const SWEEP_ROWS = 5_000;

export const CHECKPOINT_TABLES = [
  "checkpoints",
  "checkpoint_writes",
  "checkpoint_blobs",
] as const;
export type CheckpointTable = (typeof CHECKPOINT_TABLES)[number];

// The walk of one table's primary key, from the cursor ($1), until it has probed $2 ids or found $4
// under the prefix ($3), so a batch never walks past the threads it will delete and the next one
// starts where it stopped. The prefix compares with `=` on the leading bytes: equality under a
// deterministic collation is byte equality, so `1:1:` does not take `1:10:`. Exported so its plan is
// pinned by a test.
export function walkSql(table: CheckpointTable): string {
  return `
  WITH RECURSIVE t(thread_id, n, m) AS (
    (SELECT thread_id, 1, (left(thread_id, length($3)) = $3)::int
       FROM langgraph.${table} WHERE thread_id > $1 ORDER BY thread_id LIMIT 1)
    UNION ALL
    SELECT s.thread_id, t.n + 1, t.m + (left(s.thread_id, length($3)) = $3)::int
      FROM t, LATERAL (SELECT c.thread_id FROM langgraph.${table} c
                        WHERE c.thread_id > t.thread_id ORDER BY c.thread_id LIMIT 1) s
     WHERE t.n < $2 AND t.m < $4)
  SELECT thread_id, left(thread_id, length($3)) = $3 AS hit FROM t ORDER BY n`;
}

// Up to $2 rows of these threads, picked through the primary key and deleted by their own address.
// Checkpoints go oldest first: the saver reads a thread from its newest one, which keeps every blob
// and write it names until the batch that takes it, so to a reader a thread is whole or gone at any
// point of a sweep.
export function deleteThreadsSql(table: CheckpointTable): string {
  const order =
    table === "checkpoints"
      ? " ORDER BY thread_id, checkpoint_ns, checkpoint_id"
      : "";
  return `DELETE FROM langgraph.${table} WHERE ctid = ANY(ARRAY(
    SELECT ctid FROM langgraph.${table} WHERE thread_id = ANY($1::text[])${order} LIMIT $2))`;
}

// What a teardown holds around a batch. The checkpoints live on their own pool, so the teardown's
// lock is held by ANOTHER transaction, which its budget can end while the batch is still running:
// the batch commits only before `deadline` and after `beforeCommit` (the teardown's own check, on its
// own transaction, which fails once that transaction is gone) has passed, and each statement gets
// only the time left until then.
export interface BatchGuard {
  deadline: number;
  beforeCommit: () => Promise<void>;
}

export class SweepDeadlineError extends Error {
  constructor() {
    super("the checkpoint batch ran out of its teardown's budget");
    this.name = "SweepDeadlineError";
  }
}

// Before each statement: the time left until the deadline, not the time left when the batch began,
// so a run of slow statements cannot add up past it.
async function withinDeadline(
  client: Pick<PoolClient, "query">,
  guard: BatchGuard | undefined,
): Promise<void> {
  if (!guard) return;
  const left = guard.deadline - Date.now();
  if (left <= 0) throw new SweepDeadlineError();
  await client.query(`SET LOCAL statement_timeout = ${Math.ceil(left)}`);
}

export type Bounded = (sql: string, params: unknown[]) => Promise<unknown>;

export async function checkpointTransaction<T>(
  pool: Pick<Pool, "connect">,
  guard: BatchGuard | undefined,
  fn: (query: Bounded) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const query: Bounded = async (sql, params) => {
    await withinDeadline(client, guard);
    return client.query(sql, params);
  };
  try {
    await client.query("BEGIN");
    const out = await fn(query);
    if (guard) {
      await guard.beforeCommit();
      if (Date.now() >= guard.deadline) throw new SweepDeadlineError();
    }
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteCheckpointRows(
  query: Bounded,
  table: CheckpointTable,
  threadIds: string[],
  rows: number,
): Promise<number> {
  const res = (await query(deleteThreadsSql(table), [threadIds, rows])) as {
    rowCount: number | null;
  };
  return res.rowCount ?? 0;
}

// Deletes these threads' checkpoints, the tables in sweep order, a bounded transaction at a time.
export async function deleteCheckpointThreads(
  pool: Pick<Pool, "connect">,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;
  for (const table of CHECKPOINT_TABLES) {
    while (
      (await checkpointTransaction(pool, undefined, (query) =>
        deleteCheckpointRows(query, table, threadIds, SWEEP_ROWS),
      )) >= SWEEP_ROWS
    ) {}
  }
}

// A sweep takes the tables one after the other, each walked whole: `checkpoints` first, which is what
// a reader finds a thread by, then what its rows named. A thread whose checkpoints are gone is gone
// to the saver, so a sweep stopped after them leaves rows nothing reads, not a thread missing part of
// its state.
export type SweepCursor = { table: CheckpointTable; after: string };
export const SWEEP_START: SweepCursor = {
  table: CHECKPOINT_TABLES[0],
  after: "",
};

export function nextSweepTable(table: CheckpointTable): SweepCursor | null {
  const next = CHECKPOINT_TABLES[CHECKPOINT_TABLES.indexOf(table) + 1];
  return next ? { table: next, after: "" } : null;
}

// One batch of a sweep, walk and delete in one transaction: from `cursor`, deletes the rows of up to
// SWEEP_THREADS threads under `prefix` from the cursor's table and returns where the next batch
// starts, or null when the last table's walk reached the end of its key. A sweep run again from the
// start finds only what the last one did not delete, so a sweep that stopped halfway is finished by
// repeating it.
export async function sweepCheckpointBatch(
  pool: Pick<Pool, "connect">,
  prefix: string,
  cursor: SweepCursor = SWEEP_START,
  opts: {
    probes?: number;
    threads?: number;
    rows?: number;
    guard?: BatchGuard;
  } = {},
): Promise<{ deleted: number; probed: number; next: SweepCursor | null }> {
  if (!prefix.endsWith(":")) {
    // A prefix without its separator would take `1:10:…` along with `1:1`.
    throw new Error(`a checkpoint sweep prefix ends with ":", got ${prefix}`);
  }
  const probes = opts.probes ?? SWEEP_PROBES;
  const threads = opts.threads ?? SWEEP_THREADS;
  const rows = opts.rows ?? SWEEP_ROWS;
  return checkpointTransaction(pool, opts.guard, async (query) => {
    const walked = (
      (await query(walkSql(cursor.table), [
        cursor.after,
        probes,
        prefix,
        threads,
      ])) as { rows: { thread_id: string; hit: boolean }[] }
    ).rows;
    const kept = walked.filter((r) => r.hit).map((r) => r.thread_id);
    // Threads with rows left are walked again by the next batch, from the same cursor.
    if (
      kept.length > 0 &&
      (await deleteCheckpointRows(query, cursor.table, kept, rows)) >= rows
    ) {
      return { deleted: 0, probed: walked.length, next: cursor };
    }
    const ended = walked.length < probes && kept.length < threads;
    const last = walked.at(-1)?.thread_id;
    return {
      deleted: kept.length,
      probed: walked.length,
      next:
        ended || last === undefined
          ? nextSweepTable(cursor.table)
          : { table: cursor.table, after: last },
    };
  });
}

type Batch = { deleted: number; probed: number; next: SweepCursor | null };

// A whole sweep, batch after batch, each one run through `inBatch`: the teardown's own check that it
// is still removing what it started on, which answers null to stop without deleting, and hands the
// batch the guard it holds. False when it stopped.
export async function sweepCheckpoints(
  pool: Pick<Pool, "connect">,
  prefix: string,
  inBatch: (
    run: (guard?: BatchGuard) => Promise<Batch>,
  ) => Promise<Batch | null> = (run) => run(),
): Promise<boolean> {
  let cursor: SweepCursor | null = SWEEP_START;
  while (cursor !== null) {
    const from: SweepCursor = cursor;
    const res = await inBatch((guard) =>
      sweepCheckpointBatch(pool, prefix, from, { guard }),
    );
    if (res === null) return false;
    cursor = res.next;
  }
  return true;
}
