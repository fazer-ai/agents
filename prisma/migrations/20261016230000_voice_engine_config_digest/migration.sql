-- What an ElevenLabs agent's configuration (prompt, voice, call settings) was last written with, across
-- processes, beside what its tools were declared with. A process-local cache let a replica skip a
-- write the agent needed: A writes v1, B writes v2, the operator restores v1 through A, and A's cache
-- still said v1. Nullable, a catalog change only.
ALTER TABLE "voice_engine_holds" ADD COLUMN IF NOT EXISTS "config_digest" TEXT;
