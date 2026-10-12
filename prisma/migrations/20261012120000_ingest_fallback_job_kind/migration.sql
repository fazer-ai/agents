-- A watcher's fallback for the memory owner's append (issue #1129). Add-value only: the value is
-- first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'INGEST_FALLBACK';
