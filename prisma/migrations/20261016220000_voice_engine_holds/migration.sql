-- WHO IS STARTING A CALL ON AN ELEVENLABS AGENT, across processes. A call declares its tools on the
-- ElevenLabs agent, which every call to it shares, and its conversation takes them as they are when it
-- starts; so one call holds the agent from that declaration until its conversation started. Web
-- replicas take calls too (docs/deploy.md), and an in-process queue let two of them overwrite each
-- other's declaration. The hold is a lease: a process that dies holding it frees the agent when
-- `held_until` passes. `declared_digest` is what was last declared, written under the hold, so a
-- process skips a declaration only when the agent really carries it.
--
-- Not tenant data: keyed by the ElevenLabs agent id, holding a hash. No tenant_id and no RLS, like
-- `process_leases`.
CREATE TABLE IF NOT EXISTS "voice_engine_holds" (
    "engine_agent_id" TEXT NOT NULL,
    "holder" UUID,
    "held_until" TIMESTAMPTZ(3),
    "declared_digest" TEXT,

    CONSTRAINT "voice_engine_holds_pkey" PRIMARY KEY ("engine_agent_id")
);
