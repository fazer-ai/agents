-- THE DASHBOARD'S KEPT DAYS AND WHAT INVALIDATES THEM (issue #1383, docs/dashboard.md "Kept days").
--
-- `dashboard_days` holds, per tenant, filter, timezone, local day and section, the figures of that day
-- in a form that adds up over days. `dashboard_dirty` is written by the triggers below whenever a row a
-- kept day was computed from changes after the fact, and the next dashboard request drops the days it
-- names. A trigger and not the writers: the outcome of a conversation changes through the Chatwoot
-- webhook, a turn, a sweep, an operator action and a repricing script, and a kept day must not depend
-- on each of them remembering.
--
-- Only rows older than a day reach the queue. A kept day is at least the day before yesterday in the
-- viewer's zone, so it ends before `now() - 24 hours` in every zone, and a row written now (the
-- ordinary insert, which carries `created_at = now()`) pays one comparison and writes nothing.
--
-- Wrapped in a transaction: a failure between a CREATE TABLE and its FORCE ROW LEVEL SECURITY leaves a
-- tenant-scoped table that does not bind its owner (.claude/rules/prisma.md).
BEGIN;

CREATE TABLE "dashboard_days" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "version" TEXT NOT NULL,
    "filter_key" TEXT NOT NULL,
    "tz" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "section" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_days_tenant_id_version_filter_key_tz_section_day_key" ON "dashboard_days"("tenant_id", "version", "filter_key", "tz", "section", "day");

ALTER TABLE "dashboard_days" ADD CONSTRAINT "dashboard_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dashboard_dirty" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT,
    "section" TEXT,
    "at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "dashboard_dirty_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dashboard_dirty_tenant_id_processed_at_idx" ON "dashboard_dirty"("tenant_id", "processed_at");
CREATE INDEX "dashboard_dirty_tenant_id_created_at_idx" ON "dashboard_dirty"("tenant_id", "created_at");

ALTER TABLE "dashboard_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_days" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_dirty" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_dirty" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dashboard_days"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "dashboard_dirty"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "dashboard_days" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "dashboard_dirty" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

-- The ledger and the flow log: a row of an old day written, repriced or removed. With its
-- conversation, every kept day that conversation reaches is dropped, since a late turn changes
-- whether the agent ran on it and which day first counted it; without one, only its own day.
-- A flow-log DELETE is the retention sweep and invalidates nothing: a kept day keeps its figures
-- after its lines are gone, which is the point of keeping it.
CREATE FUNCTION dashboard_dirty_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.created_at < cutoff THEN
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (OLD.tenant_id, OLD.conversation_id, TG_ARGV[0], OLD.created_at);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.created_at < cutoff THEN
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (NEW.tenant_id, NEW.conversation_id, TG_ARGV[0], NEW.created_at);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_dirty AFTER INSERT OR UPDATE OR DELETE ON "llm_usage"
  FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_row('ledger');
CREATE TRIGGER dashboard_dirty AFTER INSERT OR UPDATE ON "execution_logs"
  FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_row('log');

-- A conversation: what its figures read changed (outcome, owner, inbox, labels, the customer writing
-- again, the first-response readings). Every kept day it reaches is dropped: its creation day, the
-- days it was billed, logged and proposed knowledge on.
CREATE FUNCTION dashboard_dirty_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (NEW.tenant_id, NEW.id, NULL, NEW.created_at);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.created_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (OLD.tenant_id, OLD.id, NULL, OLD.created_at);
    END IF;
  ELSIF OLD.created_at < cutoff
    AND (OLD.status, OLD.resolved_by, OLD.assignee_type, OLD.inbox_id, OLD.labels,
         OLD.last_inbound_at, OLD.chatwoot_created_at, OLD.chatwoot_first_reply_at, OLD.created_at)
        IS DISTINCT FROM
        (NEW.status, NEW.resolved_by, NEW.assignee_type, NEW.inbox_id, NEW.labels,
         NEW.last_inbound_at, NEW.chatwoot_created_at, NEW.chatwoot_first_reply_at, NEW.created_at) THEN
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (NEW.tenant_id, NEW.id, NULL, OLD.created_at);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_dirty AFTER INSERT OR UPDATE OR DELETE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_conversation();

-- A knowledge suggestion of an old day changing status, agent or thread.
CREATE FUNCTION dashboard_dirty_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.created_at < cutoff THEN
    IF TG_OP = 'DELETE' OR (OLD.status, OLD.agent_id, OLD.thread_id, OLD.created_at)
                            IS DISTINCT FROM (NEW.status, NEW.agent_id, NEW.thread_id, NEW.created_at) THEN
      INSERT INTO dashboard_dirty (tenant_id, section, at) VALUES (OLD.tenant_id, 'know', OLD.created_at);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.created_at < cutoff THEN
    IF TG_OP = 'INSERT' OR (OLD.status, OLD.agent_id, OLD.thread_id, OLD.created_at)
                            IS DISTINCT FROM (NEW.status, NEW.agent_id, NEW.thread_id, NEW.created_at) THEN
      INSERT INTO dashboard_dirty (tenant_id, section, at) VALUES (NEW.tenant_id, 'know', NEW.created_at);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_dirty AFTER INSERT OR UPDATE OR DELETE ON "approval_queue_items"
  FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_suggestion();

-- An inbox bound to another agent: under an agent filter the view's conversations are the ones whose
-- inbox is bound to it, on every day, so every kept conversation day of the tenant goes.
CREATE FUNCTION dashboard_dirty_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO dashboard_dirty (tenant_id, section) VALUES (NEW.tenant_id, 'conv-all');
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_dirty AFTER UPDATE OF "agent_id" ON "inboxes"
  FOR EACH ROW WHEN (OLD.agent_id IS DISTINCT FROM NEW.agent_id)
  EXECUTE FUNCTION dashboard_dirty_inbox();

COMMIT;
