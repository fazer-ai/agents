-- The per-tenant sweep that finds inbound deliveries stranded between the ack and the dispatch (issue #817). Add-value only: the value is first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'INBOUND_SWEEP';
