-- The recovery sweep for deliveries stranded on PROCESSING (issue #228).
--
-- Alone in its own migration because Postgres refuses to use a value added to an enum inside the
-- same transaction that added it, and Prisma runs one migration file per transaction. The next
-- migration is free to reference 'DELIVERY_SWEEP'; this one must not.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'DELIVERY_SWEEP';
