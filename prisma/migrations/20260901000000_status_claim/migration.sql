-- THE LOCAL STATUS CLAIM (issue #436). The human-reply takeover writes `open` on the mirrored row
-- before it asks Chatwoot to move the status, because every reader that decides whether the agent may
-- speak reads that row and never Chatwoot. That write claims no version — the toggle endpoint renders
-- a status blob and no `updated_at` (issue #77) — so it lands with the ordering marks where they were,
-- and a payload still in flight compares greater and walks it back, with the agent then answering
-- over the colleague who just replied.
--
-- No version can close that: a customer message advances `conversation.updated_at` on its own
-- account, so the same number cannot separate a snapshot taken before our write from one taken after.
-- The write announces itself instead, and says both how long it fences the status and which status it
-- replaced — the only one it refuses.
--
-- ROLLOUT: no window. Both columns are NULL for every existing row, which reads as "no local write is
-- outstanding" — exactly the behaviour of the release that did not have them. A process from the
-- previous release takes no claim and respects none, so during a rolling overlap the window this
-- closes is simply still open on the old replicas.
ALTER TABLE "conversations" ADD COLUMN "status_claim_until" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "status_claim_from" TEXT;
