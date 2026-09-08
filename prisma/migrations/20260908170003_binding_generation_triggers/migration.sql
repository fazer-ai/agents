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
-- THE WHOLE FILE IS ONE INVARIANT: every write that moves a binding is counted. Installed half-way
-- -- the inbox trigger in, the observer triggers not -- it counts responder moves and misses
-- observer moves, which is a counter that lies rather than one that is missing. `migrate deploy`
-- does not wrap a migration, so the file opens its own transaction (.claude/rules/prisma.md, and
-- nothing here is a `CONCURRENTLY` that would refuse the block).
BEGIN;

CREATE OR REPLACE FUNCTION bump_binding_generation_on_inbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.binding_generation := COALESCE(OLD.binding_generation, 0) + 1;
  RETURN NEW;
END;
$$;

-- REPLACE rather than CREATE even with the transaction above, and the two answer different failures.
-- The `BEGIN` covers a deploy that dies mid-file; `OR REPLACE` covers the file meeting a trigger that
-- is ALREADY THERE -- a repair applied by hand, a database restored from one that had it -- where
-- `CREATE` alone would raise `duplicate_object` and stop the rollout dead. It is also atomic where a
-- DROP-then-CREATE would leave a window in which a write is not counted at all.
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
-- AN UPDATE THAT MOVES THE ROW COUNTS TOO, on BOTH inboxes (PR review round 6). A repair that
-- rewrites `agent_id` or `inbox_id` in place changes who observes an inbox exactly as an insert and
-- a delete would, and the whole point of a trigger over a list of call sites is that it does not
-- depend on anybody choosing the shape this release happens to write. The inbox the row LEFT is
-- stepped as well: it lost an observer, and a delivery stamped before the move must not read its old
-- route derivation as current.
--
-- The move is a SECOND trigger rather than a third arm of this one, and Postgres leaves no choice: a
-- `WHEN` clause may not name OLD on a trigger that also fires on INSERT (nor NEW on one that fires
-- on DELETE), and `TG_OP` is a plpgsql variable that does not exist in `WHEN` at all. One function,
-- two triggers.
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
  -- The inbox it left, when the move crossed inboxes. Not asserted: the row may have come from an
  -- inbox this statement has already removed, the same reason the DELETE arm does not assert.
  IF TG_OP = 'UPDATE' AND OLD.inbox_id IS DISTINCT FROM NEW.inbox_id THEN
    UPDATE "inboxes"
       SET binding_generation = binding_generation + 1
     WHERE id = OLD.inbox_id;
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

-- The `WHEN` is what keeps THE STAMP out of the count: `observeInbox` settles a pending row by
-- writing `attached_at`, and that write moves nothing -- a pending row already counts as observing
-- for every reader that gates a refusal. Counted, it would step the generation in the middle of the
-- attach window and make the receiver refuse deliveries whose route derivation was right all along.
-- `UPDATE OF` narrows by the columns the statement names; the `WHEN` narrows by what actually
-- changed, since naming a column is not changing it.
CREATE OR REPLACE TRIGGER inbox_observers_bump_binding_generation_on_move
  AFTER UPDATE OF agent_id, inbox_id ON "inbox_observers"
  FOR EACH ROW
  WHEN (
    OLD.agent_id IS DISTINCT FROM NEW.agent_id
    OR OLD.inbox_id IS DISTINCT FROM NEW.inbox_id
  )
  EXECUTE FUNCTION bump_binding_generation_on_observer();

COMMIT;
