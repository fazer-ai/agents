import type { Client, Pool } from "pg";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runtimePoolOptions } from "@/api/lib/pool-options";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  type BatchGuard,
  type CheckpointTable,
  checkpointTransaction,
  deleteCheckpointRows,
  nextSweepTable,
  SWEEP_ROWS,
  SWEEP_START,
  SWEEP_THREADS,
  type SweepCursor,
} from "@/graph/checkpoint-sweep";
import { getCheckpointPool } from "@/graph/checkpointer";
import { parseDbId } from "@/lib/db-id";
import { runInPoolClass } from "@/lib/pool-class";
import { asSuperAdminOn } from "@/lib/tenancy";

// The periodic pass over the checkpoint threads whose owner is gone. A teardown deletes its threads
// by prefix (checkpoint-sweep.ts), but only the ones that exist while it runs: a turn that writes
// after it, a teardown that dies before its last batch, and everything orphaned before the
// teardowns swept at all are left behind, and nothing else points at them. This pass walks the
// checkpoint key, reads who owns each thread from its id, and deletes the threads whose owner no
// longer exists. docs/graph.md has the rest.

// How often a pass runs, how long after the boot the first one does (not with the boot, which already
// pays the scheduler's re-arms), and the grace: a thread whose newest checkpoint is younger than it
// is never taken, whatever its owner, since the owner is read in one transaction and the rows are
// deleted in another, and a late write is taken by a later pass anyway. All three are
// `config.checkpointReconcile`.
// How many distinct thread ids one batch walks, and how long a pass waits after a batch that
// deleted something: a backlog is gigabytes of TOAST, and a pass is housekeeping, so it goes slowly
// rather than taking the database's write bandwidth.
export const RECONCILE_PROBES = 500;
export const RECONCILE_PAUSE_MS = 500;
// The longest one batch's transaction runs.
export const RECONCILE_BATCH_MS = 10_000;

// Who a thread belongs to, read from its id (src/graph/checkpointer.ts, src/graph/detached-thread.ts):
// `tenant:instance:display_id` and `tenant:instance:ci:contactInbox` are an account's,
// `tenant:playground:agent:uuid` an agent's playground, `tenant:client:agent:uuid` a client channel
// thread, owned by its `detached_threads` row. A tenant that reads as a number and nothing else is
// `other`: its thread goes only with its tenant. An id whose tenant does not read is never taken.
export type ThreadOwner =
  | { kind: "account"; tenantId: bigint; instanceId: bigint }
  | { kind: "playground"; tenantId: bigint; agentId: bigint }
  | { kind: "client"; tenantId: bigint; threadId: string }
  | { kind: "other"; tenantId: bigint };

export function threadOwner(threadId: string): ThreadOwner | null {
  const parts = threadId.split(":");
  const tenantId = parseDbId(parts[0]);
  if (tenantId === null) return null;
  if (
    parts.length === 4 &&
    (parts[1] === "playground" || parts[1] === "client")
  ) {
    const agentId = parseDbId(parts[2]);
    if (agentId === null) return { kind: "other", tenantId };
    return parts[1] === "playground"
      ? { kind: "playground", tenantId, agentId }
      : { kind: "client", tenantId, threadId };
  }
  const instanceId = parseDbId(parts[1]);
  const accountShaped =
    instanceId !== null &&
    ((parts.length === 3 && parseDbId(parts[2]) !== null) ||
      (parts.length === 4 &&
        parts[2] === "ci" &&
        parseDbId(parts[3]) !== null));
  return accountShaped && instanceId !== null
    ? { kind: "account", tenantId, instanceId }
    : { kind: "other", tenantId };
}

// Which of these threads have no owner left, read in one transaction as the fleet (the owners'
// tables are under RLS, and a scoped read would answer every other tenant's owner as missing).
export async function ownerlessThreads(
  threadIds: string[],
  base: PrismaClient = basePrisma,
): Promise<Set<string>> {
  const owners = new Map<string, ThreadOwner>();
  for (const id of threadIds) {
    const owner = threadOwner(id);
    if (owner) owners.set(id, owner);
  }
  if (owners.size === 0) return new Set();
  const list = [...owners.values()];
  const ids = <K extends ThreadOwner["kind"]>(
    kind: K,
    pick: (o: Extract<ThreadOwner, { kind: K }>) => bigint,
  ) => [
    ...new Set(
      list
        .filter((o): o is Extract<ThreadOwner, { kind: K }> => o.kind === kind)
        .map(pick),
    ),
  ];
  const tenantIds = [...new Set(list.map((o) => o.tenantId))];
  const instanceIds = ids("account", (o) => o.instanceId);
  const agentIds = ids("playground", (o) => o.agentId);
  const clientThreads = list
    .filter(
      (o): o is Extract<ThreadOwner, { kind: "client" }> => o.kind === "client",
    )
    .map((o) => o.threadId);
  const found = await asSuperAdminOn(base, async (db) => ({
    tenants: await db.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true },
    }),
    instances:
      instanceIds.length === 0
        ? []
        : await db.chatwootInstance.findMany({
            where: { id: { in: instanceIds } },
            select: { id: true, tenantId: true },
          }),
    agents:
      agentIds.length === 0
        ? []
        : await db.agent.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, tenantId: true },
          }),
    detached:
      clientThreads.length === 0
        ? []
        : await db.detachedThread.findMany({
            where: { threadId: { in: clientThreads } },
            select: { threadId: true },
          }),
  }));
  const tenants = new Set(found.tenants.map((t) => t.id));
  const instances = new Set(
    found.instances.map((i) => `${i.tenantId}:${i.id}`),
  );
  const agents = new Set(found.agents.map((a) => `${a.tenantId}:${a.id}`));
  const detached = new Set(found.detached.map((d) => d.threadId));
  const gone = new Set<string>();
  for (const [id, o] of owners) {
    const kept =
      tenants.has(o.tenantId) &&
      (o.kind === "other" ||
        (o.kind === "account" &&
          instances.has(`${o.tenantId}:${o.instanceId}`)) ||
        (o.kind === "playground" && agents.has(`${o.tenantId}:${o.agentId}`)) ||
        (o.kind === "client" && detached.has(o.threadId)));
    if (!kept) gone.add(id);
  }
  return gone;
}

// The plain walk of one table's key from the cursor ($1), $2 distinct thread ids at most, one index
// probe each (checkpoint-sweep.ts, `walkSql`, without the prefix).
export function reconcileWalkSql(table: CheckpointTable): string {
  return `
  WITH RECURSIVE t(thread_id, n) AS (
    (SELECT thread_id, 1 FROM langgraph.${table} WHERE thread_id > $1 ORDER BY thread_id LIMIT 1)
    UNION ALL
    SELECT s.thread_id, t.n + 1
      FROM t, LATERAL (SELECT c.thread_id FROM langgraph.${table} c
                        WHERE c.thread_id > t.thread_id ORDER BY c.thread_id LIMIT 1) s
     WHERE t.n < $2)
  SELECT thread_id FROM t ORDER BY n`;
}

// The age of each of these threads: the `ts` of its newest checkpoint, read from the newest row of
// each through the primary key. A thread with no checkpoint left (a sweep took them, the blobs and
// writes are what is left) has no row here.
export const NEWEST_CHECKPOINT_SQL = `
  SELECT x.thread_id, n.ts FROM unnest($1::text[]) AS x(thread_id)
   CROSS JOIN LATERAL (
     SELECT c.checkpoint->>'ts' AS ts FROM langgraph.checkpoints c
      WHERE c.thread_id = x.thread_id
      ORDER BY c.checkpoint_ns DESC, c.checkpoint_id DESC LIMIT 1) n`;

const ISO_TS = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/;

// Whether a thread whose newest checkpoint says `ts` is protected by the grace: younger than it, or
// an age that does not read as a timestamp (decided here and not by a cast in SQL, which would fail
// the whole batch on one bad row). A date that does not exist (`2026-02-31`) does not read either.
export function withinGrace(
  ts: string | null,
  graceMs: number,
  now: number = Date.now(),
): boolean {
  const day = ts === null ? undefined : ISO_TS.exec(ts)?.[1];
  if (ts === null || day === undefined) return true;
  const at = Date.parse(ts);
  if (Number.isNaN(at) || !new Date(at).toISOString().startsWith(day))
    return true;
  return at > now - graceMs;
}

export interface ReconcileOptions {
  base?: PrismaClient;
  probes?: number;
  threads?: number;
  rows?: number;
  graceMs?: number;
  batchMs?: number;
  // Only the threads this answers true for are considered (tests, whose database other files share).
  scope?: (threadId: string) => boolean;
}

export type ReconcileBatch = {
  deleted: number;
  probed: number;
  next: SweepCursor | null;
};

// One batch: walks the cursor's table, keeps the threads with no owner and no recent checkpoint,
// and deletes up to `threads` of them, the first ones in key order, up to `rows` rows. Returns where
// the next batch starts: the same cursor while the threads it took still have rows, the last thread
// it decided on otherwise, and the next table once the walk reached the end of this one's key.
export async function reconcileCheckpointBatch(
  pool: Pick<Pool, "connect">,
  cursor: SweepCursor = SWEEP_START,
  opts: ReconcileOptions = {},
): Promise<ReconcileBatch> {
  const probes = opts.probes ?? RECONCILE_PROBES;
  const threads = opts.threads ?? SWEEP_THREADS;
  const rows = opts.rows ?? SWEEP_ROWS;
  const graceMs = opts.graceMs ?? config.checkpointReconcile.graceMs;
  const scope = opts.scope ?? (() => true);
  const guard: BatchGuard = {
    deadline: Date.now() + (opts.batchMs ?? RECONCILE_BATCH_MS),
    beforeCommit: async () => {},
  };
  const walked = await checkpointTransaction(pool, guard, async (query) =>
    (
      (await query(reconcileWalkSql(cursor.table), [cursor.after, probes])) as {
        rows: { thread_id: string }[];
      }
    ).rows.map((r) => r.thread_id),
  );
  const ended = walked.length < probes;
  const gone = await ownerlessThreads(walked.filter(scope), opts.base);
  let candidates = walked.filter((id) => gone.has(id));
  // The batch decides on the walk up to its `threads`-th candidate and no further, so the next one
  // starts right after the last thread this one took.
  let decidedUpTo = walked.at(-1);
  if (candidates.length > threads) {
    candidates = candidates.filter((_, i) => i < threads);
    decidedUpTo = candidates.at(-1);
  }
  const atEnd = ended && decidedUpTo === walked.at(-1);
  const after: SweepCursor | null =
    decidedUpTo === undefined || atEnd
      ? nextSweepTable(cursor.table)
      : { table: cursor.table, after: decidedUpTo };
  if (candidates.length === 0)
    return { deleted: 0, probed: walked.length, next: after };
  return checkpointTransaction(pool, guard, async (query) => {
    const newest = (
      (await query(NEWEST_CHECKPOINT_SQL, [candidates])) as {
        rows: { thread_id: string; ts: string | null }[];
      }
    ).rows;
    // In `checkpoints`, a thread goes once its newest checkpoint is past the grace. In the writes and
    // blobs, only once it has no checkpoint left: a thread kept by the grace in the first table may
    // age past it before the walk reaches the others, and taking its rows then would leave a
    // checkpoint the saver reads with part of its state gone.
    const kept = new Set(
      (cursor.table === "checkpoints"
        ? newest.filter((r) => withinGrace(r.ts, graceMs))
        : newest
      ).map((r) => r.thread_id),
    );
    const doomed = candidates.filter((id) => !kept.has(id));
    if (doomed.length === 0)
      return { deleted: 0, probed: walked.length, next: after };
    // Threads with rows left are walked again by the next batch, from the same cursor.
    if (
      (await deleteCheckpointRows(query, cursor.table, doomed, rows)) >= rows
    ) {
      return { deleted: 0, probed: walked.length, next: cursor };
    }
    return { deleted: doomed.length, probed: walked.length, next: after };
  });
}

export type ReconcileTotals = Record<CheckpointTable, number>;

// Held for a whole pass, on a connection of its own outside the checkpointer's pool: a second pass,
// in this process or another replica, finds it taken and returns at once, so two passes never delete
// the same rows at the same time (deleting the same rows in two orders deadlocks one of them). The
// batches take a pool connection one at a time and give it back between them, so a pool of one is
// shared with the turns instead of held by the pass. A process that dies drops the connection, and
// the lock with it.
const PASS_LOCK = "fazerai:checkpoint-reconcile";
// How long one query on the lock's connection may take: they are a try-lock and `SELECT 1`.
const LOCK_QUERY_MS = 10_000;

export class LockConnectionTimeout extends Error {
  constructor() {
    super("the checkpoint reconciler's lock connection did not answer in time");
    this.name = "LockConnectionTimeout";
  }
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LockConnectionTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type LockConnection = Pick<Client, "query" | "end">;

async function connectLock(): Promise<LockConnection> {
  // The pool's bounded client, so a server that accepts the socket and never answers fails the
  // connect after its bound instead of holding the pass forever.
  const { Client: Bounded, ...options } = runtimePoolOptions(
    config.langgraphDatabaseUrl ?? "",
    1,
  );
  const client = new Bounded(options);
  // A connection that drops mid-pass only loses the lock; it must not crash the process.
  client.on("error", (err) => {
    logger.warn({ err }, "checkpoint reconciler: the lock connection dropped");
  });
  await client.connect();
  return client;
}

// A whole pass: every table's key walked once, batch after batch, pausing after each batch that
// deleted something. Stops early, keeping what it did, when `shouldStop` answers true. Null when
// another pass holds the lock. Background work, on the background pool: the owner reads must not
// take the connections a customer turn needs.
export function reconcileCheckpoints(
  pool: Pick<Pool, "connect">,
  opts: ReconcileOptions & {
    pauseMs?: number;
    shouldStop?: () => boolean;
    lockConnection?: () => Promise<LockConnection>;
    lockQueryMs?: number;
  } = {},
): Promise<ReconcileTotals | null> {
  return runInPoolClass("background", async () => {
    const lock = await (opts.lockConnection ?? connectLock)();
    // A connection that stops answering after it opened would hold the pass, and every pass after
    // it, forever: each query on it has a deadline, past which the pass fails and the connection is
    // dropped.
    const ask = (sql: string, params?: unknown[]) =>
      bounded(
        lock.query<{ ok: boolean }>(sql, params),
        opts.lockQueryMs ?? LOCK_QUERY_MS,
      );
    try {
      const got = await ask("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
        PASS_LOCK,
      ]);
      if (!got.rows[0]?.ok) return null;
      // The lock lives as long as its connection: one the server closed (an idle session timeout, a
      // restart) has released it, and another pass may already hold it. Each batch asks first, and
      // a connection that does not answer ends the pass before it deletes anything more.
      return await reconcileAll(pool, {
        ...opts,
        beforeBatch: async () => {
          await ask("SELECT 1");
        },
      });
    } finally {
      // Closing the connection releases the lock. A connection that no longer answers may not
      // close either, so the wait for it is bounded too.
      await bounded(lock.end(), opts.lockQueryMs ?? LOCK_QUERY_MS).catch(
        () => {},
      );
    }
  });
}

async function reconcileAll(
  pool: Pick<Pool, "connect">,
  opts: ReconcileOptions & {
    pauseMs?: number;
    shouldStop?: () => boolean;
    beforeBatch?: () => Promise<void>;
  },
): Promise<ReconcileTotals> {
  const totals: ReconcileTotals = {
    checkpoints: 0,
    checkpoint_writes: 0,
    checkpoint_blobs: 0,
  };
  const pauseMs = opts.pauseMs ?? RECONCILE_PAUSE_MS;
  let cursor: SweepCursor | null = SWEEP_START;
  while (cursor !== null) {
    if (opts.shouldStop?.()) break;
    await opts.beforeBatch?.();
    const from: SweepCursor = cursor;
    const res = await reconcileCheckpointBatch(pool, from, opts);
    totals[from.table] += res.deleted;
    cursor = res.next;
    const deleted = res.deleted > 0 || res.next === from;
    if (deleted && pauseMs > 0)
      await new Promise((r) => setTimeout(r, pauseMs));
  }
  return totals;
}

// The timer, on globalThis so `bun --hot` keeps one, and the pass in flight, so two never overlap.
interface Holder {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  stopped: boolean;
}

const KEY = Symbol.for("fazerai.checkpointReconciler");

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
    const totals = await reconcileCheckpoints(await getCheckpointPool(), {
      shouldStop: () => holder().stopped,
    });
    if (totals === null) return;
    const threads =
      totals.checkpoints + totals.checkpoint_writes + totals.checkpoint_blobs;
    if (threads > 0) {
      logger.info(
        { ...totals, ms: Date.now() - started },
        "checkpoint reconciler: deleted the checkpoints of threads whose owner is gone",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "checkpoint reconciler: the pass failed; the next one starts over",
    );
  } finally {
    h.running = false;
  }
}

// Arms the pass: the first one `firstDelayMs` after the boot, then every `intervalMs`. Idempotent.
export function startCheckpointReconciler(): void {
  const h = holder();
  if (h.timer !== null) return;
  h.stopped = false;
  const arm = (ms: number) => {
    h.timer = setTimeout(() => {
      void runPass().finally(() => {
        if (!holder().stopped) arm(config.checkpointReconcile.intervalMs);
      });
    }, ms);
    h.timer.unref?.();
  };
  arm(config.checkpointReconcile.firstDelayMs);
}

// Stops arming passes, and makes the one in flight stop after its current batch.
export function stopCheckpointReconciler(): void {
  const h = holder();
  h.stopped = true;
  if (h.timer !== null) clearTimeout(h.timer);
  h.timer = null;
}
