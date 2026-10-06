-- A fleet invitation makes the invitee a SUPER_ADMIN and names no tenant.
ALTER TABLE "invitations" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- The old CHECK forbade SUPER_ADMIN outright; the new one ties the role to the missing tenant, so a
-- tenant invitation still can never mint a SUPER_ADMIN and a fleet one can mint nothing else.
ALTER TABLE "invitations" DROP CONSTRAINT "invitations_role_not_superadmin_check";
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_fleet_role_check"
  CHECK (("role" = 'SUPER_ADMIN') = ("tenant_id" IS NULL));

-- `invitations_tenant_id_email_key` treats every null tenant as distinct, so it does not hold one
-- fleet invitation per email; this does.
CREATE UNIQUE INDEX "invitations_fleet_email_key" ON "invitations"("email") WHERE "tenant_id" IS NULL;
