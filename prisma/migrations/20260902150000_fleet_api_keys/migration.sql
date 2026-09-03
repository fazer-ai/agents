-- A fleet-scoped API key (issue #308): SUPER_ADMIN authority and no home tenant, the shape `users`
-- already gives a SUPER_ADMIN. The policy pair on api_keys needs nothing new for the NULL row:
-- `tenant_id = <guc>` is never TRUE for NULL, so a tenant never lists a fleet key, and only the
-- fleet role reaches it.
ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- SUPER_ADMIN has no tenant; everyone else must have one (the CHECK `users` carries).
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_role_tenant_check" CHECK (
  ("role" = 'SUPER_ADMIN' AND "tenant_id" IS NULL)
  OR ("role" <> 'SUPER_ADMIN' AND "tenant_id" IS NOT NULL)
);

-- The password step-up a key was minted under (review round 3 on #308). NULL for every row that
-- predates the rule: such a key was minted with no password anywhere, so it keeps answering the
-- step-up with its creator's password rather than by itself. Not backfilled on purpose: a step-up
-- that never happened is not invented by a migration.
ALTER TABLE "api_keys" ADD COLUMN "step_up_at" TIMESTAMP(3);
