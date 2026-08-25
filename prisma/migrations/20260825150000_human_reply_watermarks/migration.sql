-- Attendance watermarks: when the customer first spoke, and the two ends of the team's answer.
-- Additive and nullable: every existing row keeps NULL, which reads as "this conversation started
-- before the columns existed" and is excluded from the response-time sample rather than counted as
-- a zero.
ALTER TABLE "conversations" ADD COLUMN "first_inbound_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "first_human_reply_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "last_human_reply_at" TIMESTAMP(3);
