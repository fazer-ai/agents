-- One round-trip at a time per thread outside Chatwoot. The client channel suspends a turn while the
-- browser runs its tools, and both the browser's late answers and the user's next message can arrive
-- for it; the claim is what lets exactly one of them act. Nullable: a thread at rest holds no claim.
ALTER TABLE "detached_threads" ADD COLUMN     "active_turn_id" TEXT,
ADD COLUMN     "active_until" TIMESTAMP(3);
