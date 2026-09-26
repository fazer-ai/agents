-- The delayed close of a conversation whose only message had nothing to answer (issue #895). Add-value only: the value is first used by application code, never by this file.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'NOTHING_TO_ANSWER';
