-- The job that answers a decided or expired document approval request in its conversation. Alone in
-- its file: a value added with ADD VALUE cannot be used in the migration that adds it
-- (.claude/rules/prisma.md).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'DOCUMENT_APPROVAL_OUTCOME';
