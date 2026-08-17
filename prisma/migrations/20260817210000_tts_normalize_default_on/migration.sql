-- The speech rewrite before audio synthesis (agent.settings.tts.normalize) becomes ON by default.
-- A default only reaches an agent whose settings do NOT carry the key: the reader takes the stored
-- value whenever it is a boolean, and every save through the editor or the MCP write tool writes
-- `normalize` out explicitly. So flipping the constant alone would change nothing for anyone who
-- already exists. Deleting the key is what makes the new default apply.
--
-- Deliberately NOT filtered by tts.mode: with mode 'never' the flag is inert (synthesizeReply is
-- never called), so sparing those agents protects nothing, and it would leave them permanently
-- behind: the day the operator switches to 'mirror', the editor reads the stored false and saves it
-- back forever, invisibly.
--
-- Two things this statement has to survive, both measured rather than assumed:
--
--   * `#-` RAISES when the path does not land in an object ("path element at position 2 is not an
--     integer"), and `jsonb_exists` does NOT filter those rows out on its own: over an array it means
--     "contains this element" and over a scalar string "is equal to this", so {"tts":["normalize"]}
--     and {"tts":"normalize"} both pass it. A settings bag in that shape is reachable through
--     PATCH /v1/agents/:id, which stores what it is given verbatim, and the container runs
--     `migrate deploy` BEFORE `serve`, so one such row would crash-loop that install's deploy. The
--     jsonb_typeof guard is what makes those rows fall out first. (No guard on `settings` itself is
--     needed: `<non-object> -> 'tts'` yields NULL, which fails the type test.)
--
--   * "agents" has FORCE ROW LEVEL SECURITY, which subjects even the table OWNER to the policy.
--     MIGRATION_DATABASE_URL is documented as "superuser OR owner" (docs/deploy.md); on managed
--     Postgres (RDS/Neon/Supabase) the admin role is usually the owner WITHOUT rolsuper, and there
--     this UPDATE would match zero rows and report success. `app.is_super_admin` is the same escape
--     hatch the runtime's asSuperAdmin uses.
--
-- Idempotent: on a second run jsonb_exists is false and nothing is written. updated_at is left alone
-- on purpose (Prisma's @updatedAt is client-side, and the editor's concurrency check compares that
-- column, so bumping it would 409 every tab an operator has open).
SET app.is_super_admin = 'on';

UPDATE "agents"
   SET "settings" = "settings" #- '{tts,normalize}'
 WHERE jsonb_typeof("settings" -> 'tts') = 'object'
   AND jsonb_exists("settings" -> 'tts', 'normalize');

RESET app.is_super_admin;
