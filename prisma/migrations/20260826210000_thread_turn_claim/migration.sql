-- Who owns a thread's message channel right now, across processes (issue #203).
--
-- The in-process registry (src/graph/inflight.ts) answers this today, and on the topology
-- docs/deploy.md §4 sanctions it answers wrong: the turn runs on whichever replica the Chatwoot
-- webhook landed on, continuous ingestion runs on the leader, and they hold different Maps. The
-- append lands inside a turn's read-modify-write of the whole channel, the turn's save erases it,
-- and the row records the message as ingested. The message is gone and marked handled.
--
-- Three columns rather than one flag, because the question has three parts:
--   turn_holders      how many invokes own the channel. COUNTED, not a boolean: two turns really do
--                     overlap on one thread, and with a flag the first to finish releases a claim
--                     the other is still holding.
--   turn_held_until   when that ownership expires. A crashed holder would otherwise strand the
--                     thread forever, which is worse than the in-process registry it replaces (a
--                     restart clears that one). Expiry lands on exactly today's behaviour.
--   ingest_write_until  the other direction: an append in progress, which a starting turn has to
--                     wait out. Without it the exclusion is only narrowed, never closed, the
--                     ingestion reads "free", the turn marks and loads, and the append still lands
--                     inside the invoke.
--
--   turn_epoch        which OCCUPANCY the count belongs to. A lease can expire under a holder that
--                     is merely slow, and that holder still runs its release: without a
--                     discriminator the release decrements a count that now belongs to a DIFFERENT
--                     turn, zeroes it, and hands the thread to an append that the newer invoke then
--                     erases, which is the loss these columns exist to stop. Bumped every time the
--                     count restarts from nobody, and carried by each holder so a release from a
--                     previous occupancy matches nothing.
--   ingest_write_token the same discriminator for the append side, where there is only ever one
--                     holder, so a value per claim says it exactly.
--
-- No backfill: a NULL lease and a zero count are exactly "nobody owns it", which is the state every
-- existing row is in.
ALTER TABLE "agent_threads"
  ADD COLUMN "turn_holders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "turn_epoch" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "turn_held_until" TIMESTAMP(3),
  ADD COLUMN "ingest_write_until" TIMESTAMP(3),
  ADD COLUMN "ingest_write_token" TEXT;
