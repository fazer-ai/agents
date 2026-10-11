-- The job that summarizes a conversation in another inbox for the same contact's turns elsewhere.
-- Alone in its file: a value added with ADD VALUE cannot be used in the migration that adds it
-- (.claude/rules/prisma.md).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'OTHER_INBOX_SUMMARY';
