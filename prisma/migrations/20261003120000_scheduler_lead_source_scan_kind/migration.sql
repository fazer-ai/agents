-- The recurring scan of a discovery lead source (intervalMin/enabled). Add-value only: the value is
-- first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'LEAD_SOURCE_SCAN';
