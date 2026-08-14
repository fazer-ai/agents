-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "chatwoot_updated_at" DOUBLE PRECISION,
ADD COLUMN     "chatwoot_state_local_at" TIMESTAMP(3);
