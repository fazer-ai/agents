-- The version at which a conversation's status or holder last moved at the source (issue #1028). Nullable and
-- unbackfilled: a row without it is read through chatwoot_status_at, as before.
ALTER TABLE "conversations" ADD COLUMN "chatwoot_ownership_changed_at" DOUBLE PRECISION;
