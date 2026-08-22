-- CreateTable
CREATE TABLE "playground_turn_notes" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "message_id" TEXT,
    "anchor_message_id" TEXT,
    "user_message_id" TEXT,
    "user_text" TEXT,
    "reply" TEXT NOT NULL,
    "guardrails" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playground_turn_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "playground_turn_notes_tenant_id_thread_id_idx" ON "playground_turn_notes"("tenant_id", "thread_id");

-- AddForeignKey
ALTER TABLE "playground_turn_notes" ADD CONSTRAINT "playground_turn_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant fence every tenant-scoped table carries (see 20260727000000_init).
ALTER TABLE "playground_turn_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "playground_turn_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "playground_turn_notes"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
