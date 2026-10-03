-- The step's `channel` (dm | reply) frozen onto the staged outbox row at render
-- time, so the card can name the rail the operator should send on without
-- re-reading a sequence that may have been edited since. Closed vocabulary ->
-- a real enum, members kept lowercase to mirror the Json step shape they are
-- written from.

-- CreateEnum
CREATE TYPE "NurtureChannel" AS ENUM ('dm', 'reply');

-- AlterTable: the transient default backfills rows staged before the column
-- existed; the drain always writes it explicitly, so it is dropped at once.
ALTER TABLE "nurture_outbox" ADD COLUMN "channel" "NurtureChannel" NOT NULL DEFAULT 'dm';
ALTER TABLE "nurture_outbox" ALTER COLUMN "channel" DROP DEFAULT;
