-- The suggestion reviewer's two states and its job kind. Alone in their file: a value added with
-- ADD VALUE cannot be used in the migration that adds it (.claude/rules/prisma.md).
ALTER TYPE "ApprovalStatus" ADD VALUE 'SCREENING';
ALTER TYPE "ApprovalStatus" ADD VALUE 'DISCARDED';
ALTER TYPE "SchedulerJobKind" ADD VALUE 'SUGGESTION_REVIEW';
