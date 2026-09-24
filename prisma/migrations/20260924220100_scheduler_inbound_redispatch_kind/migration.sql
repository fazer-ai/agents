-- One re-dispatch of one stranded inbound delivery, armed by INBOUND_SWEEP (issue #817). A kind of its own because it can run an agent turn and the sweep only queries. Add-value only: the value is first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'INBOUND_REDISPATCH';
