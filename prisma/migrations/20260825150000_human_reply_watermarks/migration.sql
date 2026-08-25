-- Attendance watermarks: when the customer first spoke, and the two ends of the team's answer.
-- Existing rows are ineligible by default. New rows become eligible only when the mirror creates
-- them from conversation_created, which proves local tracking preceded source messages. This
-- durable provenance also survives /reset clearing last_inbound_at.
ALTER TABLE "conversations" ADD COLUMN "first_inbound_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "first_human_reply_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "last_human_reply_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "first_human_message_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "attendance_tracked_from_start" BOOLEAN NOT NULL DEFAULT false;
