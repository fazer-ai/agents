-- The follow-up ladder for a snoozed conversation a person owns (issue #1184). Add-value only: the
-- value is first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'SNOOZED_FOLLOWUP';
