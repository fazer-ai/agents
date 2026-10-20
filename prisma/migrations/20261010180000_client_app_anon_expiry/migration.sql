-- An anonymous conversation left with no message for this many days is deleted by the tenant's
-- CLIENT_ANON_SWEEP job (issue #235): the thread row, its checkpoint and the anonymous user once it
-- has no thread left.
ALTER TABLE "client_apps" ADD COLUMN "anon_expiry_days" INTEGER NOT NULL DEFAULT 30;

-- The job. Value only: the first use is in code, never in this migration (an enum value added here
-- cannot be used in the same transaction).
ALTER TYPE "SchedulerJobKind" ADD VALUE 'CLIENT_ANON_SWEEP';
