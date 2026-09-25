-- A person is ONE user, and the tenants they work in are memberships (issue #756).
--
-- Until now `users.tenant_id` was a direct foreign key and `users.role` a single role, with the email
-- unique PER TENANT. A person who worked in two tenants was two rows, two passwords and two roles with
-- nothing linking them, and login picked one of the rows by email with no tenant and no order. This is
-- Chatwoot's model instead (`users` + `account_users`): the email is unique across the install, there
-- is one password, and the role lives on the membership. SUPER_ADMIN stays a property of the person
-- (`is_super_admin`) and needs no membership.
--
-- ONE TRANSACTION. The file merges rows and then drops the columns the merge reads; stopping between
-- the two would leave people with memberships AND a stale tenant column, and the retry would meet
-- `duplicate_table` on its first statement. `.claude/rules/prisma.md` (#555): Prisma runs the file
-- outside a transaction unless the file opens one.
--
-- No table this file touches carries row-level security: `users`, `invitations` and `mcp_oauth_*` are
-- global by design (baseline migration), and `tenant_users` joins them for the same reason. The
-- session reads a person's memberships before any tenant is chosen.
BEGIN;

-- ── Memberships ──
CREATE TABLE "tenant_users" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'AGENT',
    "invited_by_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_users_tenant_id_user_id_key" ON "tenant_users"("tenant_id", "user_id");
CREATE INDEX "tenant_users_user_id_idx" ON "tenant_users"("user_id");

ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SUPER_ADMIN is who the person is, never a role inside one tenant.
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_role_not_superadmin_check" CHECK ("role" <> 'SUPER_ADMIN');

ALTER TABLE "users" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;
UPDATE "users" SET "is_super_admin" = true WHERE "role" = 'SUPER_ADMIN';

-- Every tenant row becomes its own membership first, with the role it had there. The merge below then
-- only has to move memberships between people, never invent one.
INSERT INTO "tenant_users" ("tenant_id", "user_id", "role", "created_at", "updated_at")
SELECT "tenant_id", "id", "role", "created_at", CURRENT_TIMESTAMP
  FROM "users"
 WHERE "tenant_id" IS NOT NULL;

-- ── One person per email ──
-- The row that stays is the one that logged in last (the owner's decision on #756): its password is the
-- one the person used most recently. A row that never logged in loses to one that did; `id` breaks the
-- remaining ties so the choice does not depend on the planner.
CREATE TEMP TABLE "user_merge" ON COMMIT DROP AS
SELECT "id" AS "dup_id", "keeper_id"
  FROM (
    SELECT "id",
           first_value("id") OVER (
             PARTITION BY lower("email")
             ORDER BY "last_login_at" DESC NULLS LAST, "id"
           ) AS "keeper_id"
      FROM "users"
  ) ranked
 WHERE "id" <> "keeper_id";

-- The merged rows are named in the deploy log, which is where an operator looks when someone reports
-- that their other password stopped working.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT lower(k."email") AS "email", k."id" AS "keeper_id", array_agg(m."dup_id" ORDER BY m."dup_id") AS "dups"
      FROM "user_merge" m JOIN "users" k ON k."id" = m."keeper_id"
     GROUP BY lower(k."email"), k."id"
  LOOP
    RAISE NOTICE 'tenant_users: merged users % into user % (%), keeping the password of its most recent login', r."dups", r."keeper_id", r."email";
  END LOOP;
END $$;

-- The person keeps everything any of their rows had: super-admin authority, and a credential the kept
-- row lacks (a Google-only row merged with a password row keeps both ways in).
UPDATE "users" k
   SET "is_super_admin" = k."is_super_admin" OR agg."any_super",
       "password_hash" = COALESCE(k."password_hash", agg."password_hash")
  FROM (
    SELECT m."keeper_id",
           bool_or(d."is_super_admin") AS "any_super",
           (array_agg(d."password_hash" ORDER BY d."last_login_at" DESC NULLS LAST, d."id")
              FILTER (WHERE d."password_hash" IS NOT NULL))[1] AS "password_hash"
      FROM "user_merge" m JOIN "users" d ON d."id" = m."dup_id"
     GROUP BY m."keeper_id"
  ) agg
 WHERE k."id" = agg."keeper_id";

-- `google_id` is unique, so it is freed on the merged row before the kept row takes it.
CREATE TEMP TABLE "google_move" ON COMMIT DROP AS
SELECT DISTINCT ON (m."keeper_id") m."keeper_id", d."google_id"
  FROM "user_merge" m JOIN "users" d ON d."id" = m."dup_id"
  JOIN "users" k ON k."id" = m."keeper_id"
 WHERE d."google_id" IS NOT NULL AND k."google_id" IS NULL
 ORDER BY m."keeper_id", d."last_login_at" DESC NULLS LAST, d."id";
UPDATE "users" SET "google_id" = NULL
 WHERE "id" IN (SELECT "dup_id" FROM "user_merge") AND "google_id" IS NOT NULL;
UPDATE "users" k SET "google_id" = g."google_id"
  FROM "google_move" g WHERE k."id" = g."keeper_id";

-- Memberships move to the person. The old per-tenant email index guaranteed at most one row per
-- (tenant, email), so two rows of one person never shared a tenant and this cannot collide.
UPDATE "tenant_users" t SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE t."user_id" = m."dup_id";

-- What else names a user by id. These are loose columns (no foreign key), so a deleted row would
-- leave them pointing at nobody: an invitation's inviter, and the MCP connections the person
-- authorized, which keep working because the kept person holds the same membership the token was
-- issued under. A client approved from both rows keeps one approval.
UPDATE "invitations" i SET "invited_by_id" = m."keeper_id"
  FROM "user_merge" m WHERE i."invited_by_id" = m."dup_id";
UPDATE "mcp_oauth_authorization_codes" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
UPDATE "mcp_oauth_access_tokens" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
UPDATE "mcp_oauth_refresh_tokens" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
UPDATE "mcp_oauth_pending_authorizations" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
DELETE FROM "mcp_oauth_client_approvals" a
 USING "user_merge" m
 WHERE a."user_id" = m."dup_id"
   AND EXISTS (
     SELECT 1 FROM "mcp_oauth_client_approvals" b
      WHERE b."user_id" = m."keeper_id" AND b."client_id" = a."client_id"
   );
UPDATE "mcp_oauth_client_approvals" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";

-- The audit trail is NOT rewritten: it records which row acted, at the time, and history stays as it
-- was written.
DELETE FROM "users" WHERE "id" IN (SELECT "dup_id" FROM "user_merge");

-- ── The old shape goes ──
ALTER TABLE "users" DROP CONSTRAINT "users_role_tenant_check";
DROP INDEX "users_tenant_email_key";
DROP INDEX "users_superadmin_email_key";
DROP INDEX "users_tenant_id_idx";
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_fkey";
ALTER TABLE "users" DROP COLUMN "tenant_id";
ALTER TABLE "users" DROP COLUMN "role";

-- One person per email, across the install, whatever the case.
CREATE UNIQUE INDEX "users_email_key" ON "users" (lower("email"));

COMMIT;
