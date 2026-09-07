-- The role of the route a delivery arrived on (issue #476), recorded by the receiver rather than
-- inferred by the recovery: the observer row follows Chatwoot's agreement, so a delivery inside the
-- attach window has none, and a binding that changed since answers about a different moment.
--
-- THREE STATES, not two (issue #476 review, round 26). True is the observer's route, false the
-- responder's, and NULL is "nobody stated one" — a delivery that stranded between the claim and the
-- receiver's statement of the role. The recovery refuses to guess for a NULL, because guessing
-- "responder" is what loses an observation silently on an inbox nobody answers and hands the
-- responder a message its own route already carried on one it does.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "route_observed" BOOLEAN;

-- Every row that predates the column would read as "nobody stated one" and be refused by that rule.
-- Only the ones the recovery can still pick up matter, and DEAD is one of them (issue #476 review,
-- round 41): the sweep's verdict is not the end of a delivery, `DELIVERY_RECOVERY` reclaims a DEAD
-- row and replays it. Left null, such a row whose inbox was rebound to a different bot since is
-- refused by the new ambiguity checks — a delivery the build before this one recovered against the
-- current responder, stopped by a question that did not exist when it stranded. PROCESSED is the
-- only genuinely terminal status and is left alone, so this touches the worklist and not the table.
--
-- FALSE for all of them, and it is a statement of fact rather than a default: observers did not
-- exist before this column, so every route these rows arrived on was a responder's.
-- STOP THE OLD PROCESS FIRST. This is one shot, and the column has NO DEFAULT on purpose: a
-- default would make a row between its insert and its claim say "the responder's", which is a
-- false statement rather than a missing one, and the wide settlement would close a watcher's row
-- before it is done. So a delivery the PREVIOUS release inserts after this commits keeps a null
-- role, and if that process is drained mid-delivery the row is skipped by the settlement and
-- refused by the recovery after a rebind. docs/deploy.md names this migration in the list that
-- wants stop-old -> migrate -> start-new; re-running the backfill afterwards repairs a rollout
-- done the other way round, since it only ever touches rows that are still NULL.
-- FORCE binds this statement like any other, and a backfill that decides on zero rows reports
-- success, so the table is unbracketed for the write and put back straight after.
ALTER TABLE "chatwoot_webhook_deliveries" NO FORCE ROW LEVEL SECURITY;

UPDATE "chatwoot_webhook_deliveries"
   SET "route_observed" = false
 WHERE "route_observed" IS NULL
   AND "status" IN ('PENDING', 'PROCESSING', 'DEAD');

ALTER TABLE "chatwoot_webhook_deliveries" FORCE ROW LEVEL SECURITY;
