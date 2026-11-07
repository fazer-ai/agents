-- The job that fills the dashboard's log facts from the lines written before they existed (issue
-- #1731). Alone in its file: a value added with ADD VALUE cannot be used in the migration that adds it
-- (.claude/rules/prisma.md).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'DASHBOARD_LOG_FACTS_BACKFILL';
