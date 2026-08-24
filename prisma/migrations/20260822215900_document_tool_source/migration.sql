-- The new grant source, ALONE in its own migration.
--
-- NOTE: not tidiness. Postgres will not let a transaction USE an enum value the same transaction
-- added, and Prisma runs one migration file per transaction — so the CHECK constraint in the next
-- migration, whose expression compares `source` against 'DOCUMENT', has to land after this one has
-- committed. It happens to be accepted on the version this was written against, which is exactly the
-- kind of thing that holds locally and fails on an operator's older server.
ALTER TYPE "AgentToolSource" ADD VALUE 'DOCUMENT';
