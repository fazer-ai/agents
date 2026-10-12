-- The job that carries a customer's file into the case it belongs to, when it arrives after the
-- case opened (issue #1374). Add-value only: the value is first used by application code, never by
-- this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'CASE_CARRY';
