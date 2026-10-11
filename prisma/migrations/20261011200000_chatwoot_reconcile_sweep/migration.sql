-- The Chatwoot reconciliation sweep: its scheduler kind, and how far it has read each
-- account. The enum value is only added here; nothing in this file uses it.
ALTER TYPE "SchedulerJobKind" ADD VALUE IF NOT EXISTS 'RECONCILE_SWEEP';

ALTER TABLE "chatwoot_instances" ADD COLUMN IF NOT EXISTS "reconciled_until" TIMESTAMP(3);
