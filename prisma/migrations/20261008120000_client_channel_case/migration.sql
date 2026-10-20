-- The client channel opens a case in the team's inbox (open_case_in_inbox). The host states the email
-- its user is reached at, and the thread remembers the case it opened so a second call adds to it.
BEGIN;
ALTER TABLE "external_users" ADD COLUMN "email" TEXT;
ALTER TABLE "detached_threads" ADD COLUMN "case_instance_id" BIGINT,
ADD COLUMN "case_conversation_id" INTEGER,
ADD COLUMN "case_email" TEXT;
COMMIT;
