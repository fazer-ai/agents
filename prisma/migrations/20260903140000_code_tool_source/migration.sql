-- A new grant source for operator-authored code tools (issue #363). The value is added ALONE:
-- Postgres refuses to use an enum value in the migration that adds it, so the table that references
-- it comes in the next file (.claude/rules/prisma.md).
ALTER TYPE "AgentToolSource" ADD VALUE 'CODE';
