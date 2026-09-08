-- WHO ROUTES AN INBOX, COUNTED (issue #540). Every write that moves a binding -- a responder bound,
-- rebound or unbound, an observer attached or detached -- increments the inbox's counter in the same
-- transaction as the binding itself, and a webhook delivery records the counter it was RECEIVED
-- under. A later reader compares the two: equal means the world the message arrived in is still the
-- world, so a fact re-derived from the binding is evidence about receipt time; different means the
-- re-derivation is about a world the message never arrived in.
--
-- ADDITIVE AND COMPATIBLE WITH THE PREVIOUS RELEASE SERVING BESIDE IT, which is what a rolling
-- deploy requires (docs/deploy.md). The inbox counter has a default, so a release that does not know
-- the column writes rows that read as generation zero and never move it -- which is exactly what
-- "nothing has changed" should look like. The delivery column is nullable and the previous release
-- leaves it null, which every reader added here treats as "this row cannot say" rather than as
-- generation zero.
--
-- NO BACKFILL, and the null is the point. A delivery row that already exists was received under a
-- world nothing recorded, and writing 0 onto it would claim it arrived under the current binding --
-- the one lie this column exists to prevent. Those rows keep the readings they always had.
ALTER TABLE "inboxes"
  ADD COLUMN "binding_generation" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "chatwoot_webhook_deliveries"
  ADD COLUMN "binding_generation" INTEGER;
