-- The account's own identity, read from Chatwoot: an account claimed through one address of an
-- installation is the same account through every other one. Nullable and backfilled by the reconcile
-- sweep, so a row connected before this column keeps working until its Chatwoot answers; NULLs are
-- distinct under the unique index, so those rows never collide with anything. The table holds one row
-- per connected account, and the build is one transaction with the column.
BEGIN;
ALTER TABLE "chatwoot_instances" ADD COLUMN "account_created_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "chatwoot_instances_account_id_account_created_at_key" ON "chatwoot_instances"("account_id", "account_created_at");
COMMIT;
