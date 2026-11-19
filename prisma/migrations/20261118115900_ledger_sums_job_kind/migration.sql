-- The job that keeps a tenant's ledger sums (issue #1750). Alone in its file: a value added with ADD
-- VALUE cannot be used in the migration that adds it (.claude/rules/prisma.md).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'LEDGER_SUMS';
