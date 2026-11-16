# Scheduler jobs: what is kept, and how the hot reads reach an index

`scheduler_jobs` is one table for every kind of background work (`src/modules/scheduler/`). A row is armed by key (`tenant_id, kind, dedupe_key`), claimed, and ends `DONE` or `DEAD`; a re-arm of the same key reuses the row (`Rearm` in `service.ts`). This page covers what stays in the table once the work is finished, and the indexes the hot reads depend on. Why the scheduler is homegrown at all is [`job-libraries.md`](job-libraries.md).

## Retention of finished rows

Kinds whose key names one unit of traffic (`JOB_DELETE_ON_DONE` in `lanes.ts`: ingestion, the delivery recoveries, document approvals, a blank-message judgement) delete their row on `DONE`. Every other kind keeps it, and its key is reused by the next arm. Measured on a production instance (issue #1817): 425k rows, almost all `DONE`, the oldest from the instance's first day (OBSERVE 201k, DEBOUNCE 104k, MEMORY_COMPACT 76k, FOLLOWUP 40k).

The flow-log retention sweep (`FLOWLOG_SWEEP`, [`logs.md`](logs.md) § Retention) deletes those rows, as its sixth table, with the same batches, pass budget and catch-up re-run. A row leaves when all of this holds (`expiredDoneJobs` in `done-retention.ts`):

- it is `DONE`;
- `attempts = 0`;
- `updated_at` is older than its kind's window in `JOB_DONE_RETENTION_MS`.

| Kinds | DONE kept for | Why |
| --- | --- | --- |
| `MEDIA_TEXT_FALLBACK`, `INBOUND_REDISPATCH`, `SUGGESTION_REVIEW` | forever | Armed `once`: the DONE row is the dedupe. Deleted, a redelivered webhook would send the text again, the sweep would arm the same redispatch again, a decided suggestion would be reviewed again. |
| every other kind | 7 days | A DONE row with `attempts = 0` reads the same as no row to a `new-work` or `same-work` arm (both write a fresh PENDING row with zero attempts). What reads a DONE row by key in the meantime is work still settling on it: a claim being finished, the observer's refusal mark (`retireRefusedObserve`) against an allow still in flight, an appointment's cancellation stamp against a send already claimed. That is minutes; the week is for support questions about a job. |

Not deleted, whatever their age:

- **`DEAD` rows.** The follow-up sweep reads a FOLLOWUP that died in the current silence to keep the conversation out of the next pass (`followups/handlers.ts`, `conversations/service.ts`), and that silence has no end date. The debounce and compaction dead-letter paths read their own DEAD row. They are few (36 on the instance above).
- **A DONE row with attempts left on it.** A follow-up retired by a reply keeps its counted attempts, and a `same-work` arm carries them into the next run. Deleted, the budget would start over.
- **`PENDING`, `CLAIMED`, `FAILED`.** Work that is not finished.

The delete repeats its predicate outside the batch's `id = ANY(...)`, so a row re-armed between the select and the delete is re-checked under its row lock and kept, and a short batch is re-asked before the table is called done. `tests/modules/scheduler-done-retention.test.ts` holds each of these, the race included.

## The hot reads and their indexes

The claims and the reaper run as the fleet; the prefix reads run under the tenant policy. The enum columns are the trap in both, as on the delivery ledger ([`tenancy.md`](tenancy.md) § A scoped read cannot index an enum column). As the fleet, the policy hides the statistics of `status` and the planner took PENDING for a third of the table and scanned it. Under the tenant policy, neither `kind` nor `status` nor `LIKE` reaches an index at all. Deleting DONE rows does not fix either one: the heap keeps its pages after a `DELETE`, and a scan reads them all.

| Read | Role | Index | Measured before (production, 425k rows) |
| --- | --- | --- | --- |
| every lane's claim (`claimSql`) | fleet | `scheduler_jobs_pending_idx`, `(run_at) WHERE status = 'PENDING'` | 18k buffers per call on average over 951k calls, 4.9 h of execution in nine days |
| the reaper (`reapSql`) | fleet | `scheduler_jobs_claimed_idx`, `(claimed_at) WHERE status = 'CLAIMED'` | 6k buffers per call |
| the turn barrier's fallback reads (`pendingFallbacksSql`, `waitingFallbacksSql`) | tenant | `scheduler_jobs_tenant_id_dedupe_key_pattern_idx`, `(tenant_id, dedupe_key text_pattern_ops)`, through `starts_with` (`dedupeKeyStartsWith`) | 15k buffers and 73 ms per call, 70k calls |
| a conversation's pending reminders (`threadRemindersSql`) | tenant | the same key index, by the `reminder:` key root | 16k buffers and 121 ms per call |

`starts_with` is leakproof and Postgres turns it into a range over a byte-ordered index, so it reaches the key index where Prisma's `startsWith` (a `LIKE`) cannot. The key index replaces the old `(tenant_id, dedupe_key)` one: `text_pattern_ops` carries `=` too, so the correlated lookups by key that index served are served by this one. `tests/modules/scheduler-hot-plans.test.ts` reads the plan of each read under its own role, on a table of finished rows.
