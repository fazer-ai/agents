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
-- `users`, `invitations` and `mcp_oauth_*` carry no row-level security, global by design (baseline
-- migration), and `tenant_users` joins them for the same reason: the session reads a person's
-- memberships before any tenant is chosen. The two FORCE-RLS tables this file writes, `api_keys` and
-- `audit_logs`, have the FORCE lifted around their own statements and restored before COMMIT.
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

-- The merged rows are named in the deploy log for whoever runs the file by hand. `prisma migrate
-- deploy` does not print a NOTICE, so the record an operator can actually find is the audit trail
-- written further down, once the memberships have moved.
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

-- `google_id` is unique, so the kept row takes it only once the merged row is gone (at the end of the
-- merge, below). Nulling it on the merged row first is not an option: a Google-only row would then
-- hold no credential at all, and `users_auth_method_check` aborts the whole file (review round 2).
CREATE TEMP TABLE "google_move" ON COMMIT DROP AS
SELECT DISTINCT ON (m."keeper_id") m."keeper_id", d."google_id"
  FROM "user_merge" m JOIN "users" d ON d."id" = m."dup_id"
  JOIN "users" k ON k."id" = m."keeper_id"
 WHERE d."google_id" IS NOT NULL AND k."google_id" IS NULL
 ORDER BY m."keeper_id", d."last_login_at" DESC NULLS LAST, d."id";

-- Memberships move to the person. The old per-tenant email index guaranteed at most one row per
-- (tenant, email), so two rows of one person never shared a tenant and this cannot collide.
UPDATE "tenant_users" t SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE t."user_id" = m."dup_id";

-- What else names a user by id. These are loose columns (no foreign key), so a deleted row would
-- leave them pointing at nobody: an invitation's inviter, an API key's creator (who answers the
-- step-up for a key minted before it had one of its own), and the MCP connections the person
-- authorized, which keep working because the kept person holds the same membership the token was
-- issued under.
UPDATE "invitations" i SET "invited_by_id" = m."keeper_id"
  FROM "user_merge" m WHERE i."invited_by_id" = m."dup_id";
-- `api_keys` is FORCE-RLS, and its owner, which runs this file, is subject to the tenant policy: without
-- lifting it the UPDATE decides over zero rows and reports success. Restored in the same transaction.
ALTER TABLE "api_keys" NO FORCE ROW LEVEL SECURITY;
UPDATE "api_keys" x SET "created_by_user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."created_by_user_id" = m."dup_id";
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
UPDATE "mcp_oauth_authorization_codes" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
UPDATE "mcp_oauth_access_tokens" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
UPDATE "mcp_oauth_refresh_tokens" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
UPDATE "mcp_oauth_pending_authorizations" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";
-- One approval per (person, client) survives, decided over the WHOLE merge group: two merged rows can
-- both have approved a client the kept row never did (review round 1). The kept person's own approval
-- wins, then the oldest.
DELETE FROM "mcp_oauth_client_approvals" a
 USING (
   SELECT x."id",
          row_number() OVER (
            PARTITION BY COALESCE(m."keeper_id", x."user_id"), x."client_id"
            ORDER BY (m."keeper_id" IS NULL) DESC, x."id"
          ) AS "rn"
     FROM "mcp_oauth_client_approvals" x
     LEFT JOIN "user_merge" m ON m."dup_id" = x."user_id"
 ) ranked
 WHERE a."id" = ranked."id" AND ranked."rn" > 1;
UPDATE "mcp_oauth_client_approvals" x SET "user_id" = m."keeper_id"
  FROM "user_merge" m WHERE x."user_id" = m."dup_id";

-- Each merge is written to the audit trail, where an operator answers "my other password stopped
-- working": one row in the fleet trail and one in every tenant the person now belongs to, naming the
-- rows that went and the one that stayed. Filed by the system, like the upgrade renames before it
-- (`tool.renamed_by_upgrade`). `audit_logs` is FORCE-RLS for the same reason as `api_keys` above.
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;
INSERT INTO "audit_logs" ("tenant_id", "actor_id", "actor_type", "action", "target", "before", "after", "created_at")
SELECT scope."tenant_id", NULL, 'system', 'user.merged_by_upgrade', 'user:' || g."keeper_id",
       jsonb_build_object('userIds', g."dup_ids"),
       jsonb_build_object('userId', g."keeper_id"::text, 'email', g."email"),
       NOW()
  FROM (
    SELECT m."keeper_id", lower(k."email") AS "email",
           jsonb_agg(m."dup_id"::text ORDER BY m."dup_id") AS "dup_ids"
      FROM "user_merge" m JOIN "users" k ON k."id" = m."keeper_id"
     GROUP BY m."keeper_id", lower(k."email")
  ) g
  CROSS JOIN LATERAL (
    SELECT NULL::bigint AS "tenant_id"
    UNION ALL
    SELECT t."tenant_id" FROM "tenant_users" t WHERE t."user_id" = g."keeper_id"
  ) scope;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

-- Nothing else in the audit trail is rewritten: it records which row acted, at the time, and history
-- stays as it was written.
DELETE FROM "users" WHERE "id" IN (SELECT "dup_id" FROM "user_merge");
UPDATE "users" k SET "google_id" = g."google_id"
  FROM "google_move" g WHERE k."id" = g."keeper_id";

-- ── The old shape stops binding ──
-- The previous image keeps serving until the new one replaces it, and every cookie request it answers
-- names `users.tenant_id` and `users.role`. The two COLUMNS therefore stay for one release, frozen at
-- what they held here and ignored by this image's client (`@ignore` in the schema); the release after
-- drops them (.claude/rules/prisma.md, "Dropping a column"). What goes now is everything that would
-- make them bind: the CHECK tying role to tenant, the per-tenant email indexes, and the foreign key,
-- whose cascade would otherwise delete a PERSON, with every other membership, when the tenant their
-- old row pointed at is deleted.
ALTER TABLE "users" DROP CONSTRAINT "users_role_tenant_check";
DROP INDEX "users_tenant_email_key";
DROP INDEX "users_superadmin_email_key";
DROP INDEX "users_tenant_id_idx";
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_fkey";

-- ── The previous image, until it exits ──
-- `docs/deploy.md` asks for the old process to be stopped before this file runs. A rollout done the
-- other way round leaves it WRITING the old shape for a while: an invitation it accepts inserts a
-- `users` row with `tenant_id` and `role` and no membership, and a role change it makes updates
-- `users.role`. Read by this image, the first is a person locked out and the second a change that
-- never happened (review round 3). These triggers mirror those writes onto the new shape while the
-- columns exist. This image never writes either column (`@ignore`), so nothing it does fires them.
-- The release that drops the columns drops the triggers with them.
CREATE FUNCTION "users_legacy_role_sync"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."role" IS DISTINCT FROM OLD."role" THEN
    UPDATE "users" SET "is_super_admin" = (NEW."role" = 'SUPER_ADMIN') WHERE "id" = NEW."id";
  END IF;
  IF NEW."tenant_id" IS NOT NULL AND NEW."role" <> 'SUPER_ADMIN' THEN
    INSERT INTO "tenant_users" ("tenant_id", "user_id", "role", "updated_at")
    VALUES (NEW."tenant_id", NEW."id", NEW."role", CURRENT_TIMESTAMP)
    ON CONFLICT ("tenant_id", "user_id")
    DO UPDATE SET "role" = EXCLUDED."role", "updated_at" = CURRENT_TIMESTAMP;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_legacy_insert_sync" AFTER INSERT ON "users"
  FOR EACH ROW WHEN (NEW."tenant_id" IS NOT NULL)
  EXECUTE FUNCTION "users_legacy_role_sync"();
CREATE TRIGGER "users_legacy_update_sync" AFTER UPDATE OF "role", "tenant_id" ON "users"
  FOR EACH ROW WHEN (NEW."role" IS DISTINCT FROM OLD."role" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id")
  EXECUTE FUNCTION "users_legacy_role_sync"();

-- One person per email, across the install, whatever the case.
CREATE UNIQUE INDEX "users_email_key" ON "users" (lower("email"));

COMMIT;
