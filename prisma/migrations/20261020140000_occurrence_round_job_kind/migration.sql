-- The occurrence monitor's round (docs/occurrences.md). Add-value only: the value is first used by
-- application code, never by this file (.claude/rules/prisma.md).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'OCCURRENCE_ROUND';
