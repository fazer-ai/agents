-- The version of a hand-back the takeover's status claim refused, which the takeover reads after its
-- settle wait. Additive and nullable: an existing row has no claim outstanding.
ALTER TABLE "conversations" ADD COLUMN "status_claim_handback_at" DOUBLE PRECISION;
