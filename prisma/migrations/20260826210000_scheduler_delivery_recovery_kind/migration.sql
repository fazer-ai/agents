-- The recovery that answers a delivery the sweep declared lost (issue #295).
--
-- Alone in its own migration because Postgres refuses to use a value added to an enum inside the
-- same transaction that added it, and Prisma runs one migration file per transaction. The next
-- migration is free to reference 'DELIVERY_RECOVERY'; this one must not.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'DELIVERY_RECOVERY';
