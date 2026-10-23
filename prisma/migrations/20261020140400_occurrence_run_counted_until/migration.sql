-- Where each round's count of readings stopped, written with the count, so the next round counts from
-- the last window actually counted (docs/occurrences.md, "Rounds"). The table is new and empty until
-- a monitor is switched on.
BEGIN;

ALTER TABLE "occurrence_runs" ADD COLUMN "counted_until" TIMESTAMP(3);

COMMIT;
