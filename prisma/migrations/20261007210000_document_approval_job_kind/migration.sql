-- The job that expires a document approval request. Alone in its file: a value added with ADD VALUE
-- cannot be used in the migration that adds it (.claude/rules/prisma.md).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'DOCUMENT_APPROVAL_EXPIRY';
