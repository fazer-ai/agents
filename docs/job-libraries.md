# Job libraries: pg-boss and graphile-worker, evaluated and not adopted

The scheduler runtime (`src/modules/scheduler/`) is homegrown: one table, `scheduler_jobs`, claimed with `FOR UPDATE SKIP LOCKED` by lanes of their own. #807 asked whether a Postgres-native job library should replace it. Redis-based libraries were ruled out from the start, because they add a service to every install. This page records what the spike (#813) measured on the two candidates, with DEBOUNCE and FOLLOWUP as the test cases, and why neither was adopted. Read it before proposing a swap again.

Measured on 2026-09-24 against pg-boss 12.34.0 and graphile-worker 0.18.0, on Postgres 17, with the scripts in the spike's comment on #813.

## What was measured

**1. pg-boss's expiry ends the run, and runs its retry beside the handler it could not stop.** A job with `expireInSeconds: 2` and one retry, and a handler that ignores its signal and returns at 6 s:
- the handler's `job.signal` aborted at 2.0 s;
- pg-boss failed the attempt in the same instant ("handler execution exceeded 2s") and freed the worker slot;
- the retry started 10 ms later, while the first handler was still running: two runs of the same job at once;
- both late returns were discarded, and the job ended `failed`.

With `localConcurrency: 1` the same happened: pg-boss counts the slot free at the expiry, and the retry started 10 ms later beside the handler still running ("active now 2" on a one-slot worker). #811 frees the slot at the deadline too, and that part is the same. What differs is the job itself: there the row stays out of every claim until its handler has actually returned, so a job never runs beside itself.

**2. A late return does not complete a newer attempt on pg-boss.** Run 1 expired at 3 s and returned at 4 s, while its retry was active. The job completed at 6 s with the retry's output. The in-process timeout settles an attempt once, which covers what `claim_seq` covers (#164) within one process.

**3. pg-boss's per-key serialization is released by expiry.** DEBOUNCE as a `stately` queue keyed by thread (one queued and one active per key), armed with `upsert()`:
- `upsert()` moved the pending job's `startAfter` and replaced its data, which is the rolling window;
- a message during the flush queued a second job, which waited for the active one, as it should;
- at the active job's expiry it was failed and the queued one started at once, while the expired handler ran for 5 more seconds: two flushes of the same conversation at once.

**4. graphile-worker has no per-job deadline at all.** Its `abortSignal` fires on worker shutdown only (the type says so). A job whose worker died is re-offered after a lock expiry of 4 hours, written into its SQL (`locked_at < NOW() - interval '4 hours'`), against our 5 minutes.

**5. graphile-worker's `jobKey` re-arm runs beside the running job.** In `replace` mode `addJob` moves a pending job's `run_at` (the rolling window works). A re-arm while the job runs creates a new job, which started immediately beside the first. Putting each thread in its own `queueName` serializes them: the second job waited for the first. That costs one named queue per conversation.

## What neither library can express

- **The turn barrier.** `src/graph/ingest-drain.ts` claims a thread's PENDING rows by `dedupe_key` prefix, due or not, from inside a turn, and memory compaction counts what a thread still owes by the same prefix. Neither library claims by key prefix: pg-boss fetches by queue name, graphile-worker by task and queue. Both would need raw SQL against the library's private tables (`pgboss.job`, `graphile_worker._private_jobs`), whose layout is theirs to change between versions (pg-boss partitions per queue).
- **Tenant isolation.** Neither table has `tenant_id` or RLS. Every job row would sit outside the tenancy model (`docs/tenancy.md`), readable by whichever role runs the worker.
- **Encrypted payloads.** `payload_secret` is encrypted at rest. The libraries store `data` as plain JSON, so the encryption would move into every producer and consumer.
- **The dead-letter hooks.** Per-kind death levels (`JOB_DEATH_LEVEL`) and per-kind hooks reached from both roads to DEAD (`failJob`'s cap and the reaper) map onto pg-boss's `deadLetter` queue only in part. The reaper's road has no equivalent in graphile-worker short of its 4-hour expiry.

## What the libraries offered, and where it is now

| offered | where the homegrown runtime has it |
| --- | --- |
| per-node slots (pg-boss `localConcurrency`) | the debounce lane's slots (#807) |
| per-group concurrency (pg-boss `groupConcurrency`) | the fair share of the debounce claim (#810) |
| per-job expiry with a signal (pg-boss `expireInSeconds`) | the job deadline (#811), which also keeps the row out of every claim until its handler returns |
| rolling debounce (pg-boss `upsert`, graphile-worker `jobKey`) | `armDebounce`'s upsert |

Neither replaces a deadline on the model call itself (#809), and neither would have prevented the double run that measurements 1 and 3 show.

## Migration path, had one been chosen

The rows in flight during an upgrade would have to be drained, not copied:
1. stop claiming, and let the CLAIMED rows finish or reach their deadline;
2. copy the PENDING rows, decrypting `payload_secret` into the library's plain `data`;
3. rewrite every producer.

The twelve files under `src/` that read or write `scheduler_jobs` directly would all change, including the turn barrier, which has no counterpart.

## Decision

Keep the homegrown runtime. Reopen the question only if a requirement appears that the table cannot serve: several replicas claiming the same lanes (the single-replica rule in `docs/deploy.md` would go first), or a job volume at which one table with `SKIP LOCKED` measurably stops keeping up.
