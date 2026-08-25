-- Attendance watermarks: when the customer first spoke, and the two ends of the team's answer.
-- Additive and nullable: every existing row keeps NULL. A row that already carries `last_inbound_at`
-- with `first_inbound_at` NULL is a conversation whose traffic predates these columns, and the
-- mirror never anchors one (see src/modules/chatwoot/attendance-watermarks.ts) — so it stays out of
-- the response-time sample instead of contributing a mid-conversation interval as if it were a
-- first response.
ALTER TABLE "conversations" ADD COLUMN "first_inbound_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "first_human_reply_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "last_human_reply_at" TIMESTAMP(3);
