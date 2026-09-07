-- THE COUNTER IS THE DATABASE'S, NOT THE APPLICATION'S (issue #540, PR review round 1).
--
-- `binding_generation` was stepped by the five application sites that move a binding, and a counter
-- kept that way is only as good as the list of writers somebody remembered. The review found two
-- holes in that list on the first pass, and they are the same hole twice:
--
--   * `softDisconnectChatwootInstance` clears `agent_id` with a raw UPDATE of its own. A delivery
--     stamped before a disconnect then read equal generations and settled against a responder that
--     had just been removed.
--   * A ROLLING DEPLOY (docs/deploy.md) has the previous release binding, unbinding, observing and
--     unobserving for the length of the overlap, and that release names no such column at all. Every
--     inbox it touches keeps the generation it had, so a reader on the new release takes a stale
--     route derivation for a current one -- which is the exact reading the column exists to refuse.
--
-- A trigger has no list. Every writer counts: this release, the previous one, a repair somebody
-- makes by hand, and whatever site is added next without reading this file.
--
-- BEFORE UPDATE on the inbox, so the counter rides the same row version as the binding and no second
-- statement can be lost between them. `IS DISTINCT FROM` rather than `<>`, since null on either side
-- is the unbind and the first bind.
CREATE OR REPLACE FUNCTION bump_binding_generation_on_inbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.binding_generation := COALESCE(OLD.binding_generation, 0) + 1;
  RETURN NEW;
END;
$$;

-- REPLACE rather than CREATE, because a migration file is not a transaction here (.claude/rules/prisma.md):
-- a deploy interrupted between these two statements would meet `duplicate_object` on the retry and
-- stop the rollout dead until somebody edited database state by hand. `CREATE OR REPLACE TRIGGER` is
-- atomic where a DROP-then-CREATE would leave a window in which a write is not counted at all.
CREATE OR REPLACE TRIGGER inboxes_bump_binding_generation
  BEFORE UPDATE ON "inboxes"
  FOR EACH ROW
  WHEN (OLD.agent_id IS DISTINCT FROM NEW.agent_id)
  EXECUTE FUNCTION bump_binding_generation_on_inbox();

-- The observer side is a row in another table, so it is an AFTER trigger writing the inbox.
--
-- It runs with the caller's own privileges and therefore under the caller's RLS, which is what makes
-- it correct rather than a hazard: an `inbox_observers` write already had to satisfy that table's
-- tenant policy, and the inbox it names belongs to the same tenant, so the UPDATE is inside the same
-- policy. The INSERT arm asserts it anyway -- a row this trigger cannot reach would otherwise leave
-- the counter silently behind, which is the failure mode the whole column exists to remove.
--
-- The DELETE arm deliberately does NOT assert. `inbox_observers` cascades from `inboxes`, so
-- dropping an inbox fires this trigger for a parent row the same command has already removed; there
-- the counter has nothing left to count and a raise would break the delete.
CREATE OR REPLACE FUNCTION bump_binding_generation_on_observer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "inboxes"
       SET binding_generation = binding_generation + 1
     WHERE id = OLD.inbox_id;
    RETURN OLD;
  END IF;
  UPDATE "inboxes"
     SET binding_generation = binding_generation + 1
   WHERE id = NEW.inbox_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'binding generation not stepped for inbox % (the observer write could not reach it)',
      NEW.inbox_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER inbox_observers_bump_binding_generation
  AFTER INSERT OR DELETE ON "inbox_observers"
  FOR EACH ROW
  EXECUTE FUNCTION bump_binding_generation_on_observer();
