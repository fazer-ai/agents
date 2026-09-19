-- A delivery that went out UNSIGNED records why (issue #724).
--
-- A signing secret is a vault reference. When it stops resolving -- the entry was deleted, or it
-- exists and was never filled -- both workers already POST unsigned rather than hold the payload
-- back, which is the right call in these two families: not arriving is the damage itself. What was
-- missing is the record. The row was written DELIVERED with `last_error` cleared, so nothing
-- separated it from a delivery that really was signed, and a receiver that verifies signatures drops
-- it in silence on the other side.
--
-- Why not `last_error`: the delivery SUCCEEDED. `finalizeDelivered` nulls that column on purpose, and
-- overloading it would either make a delivered row look failed or lose the note on the write that
-- records the success.
--
-- The value is a SENTENCE, not a code: "deleted" and "never filled" send the operator to different
-- places, and the column is read by a person, on a screen, next to the row it explains.
--
-- Both statements or neither: the code reads the column on both families, and one table carrying it
-- while the other does not is exactly the half-applied state worth a rollback (see
-- `.claude/rules/prisma.md` -- the file does not run in a transaction unless it opens one).
BEGIN;

ALTER TABLE "alert_deliveries" ADD COLUMN "unsigned_reason" TEXT;
ALTER TABLE "outbound_webhook_deliveries" ADD COLUMN "unsigned_reason" TEXT;

COMMIT;
