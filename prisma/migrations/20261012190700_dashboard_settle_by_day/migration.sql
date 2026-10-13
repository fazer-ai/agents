-- Settling a long queue walked every kept day against every instant it reached, in every zone at
-- once: a bulk repricing or a restore of old flow-log lines could not settle within the budget, and
-- every dashboard request of the tenant failed. The kept days are now reached by zone and day through
-- this index, and a ledger line whose change stays within its own day no longer queues its
-- conversation.
BEGIN;

CREATE INDEX "dashboard_days_tenant_id_tz_day_idx" ON "dashboard_days"("tenant_id", "tz", "day");

CREATE OR REPLACE FUNCTION dashboard_dirty_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
  conv_at timestamp;
BEGIN
  -- A ledger line repriced, or otherwise changed in what only its own day sums (cost, tokens,
  -- duration), reaches that day alone: queued without its conversation, whose other days it leaves
  -- as they were. A bulk repricing then costs one cheap row per line, not a walk of every conversation.
  -- Nested, so the flow log's rows, which have no node, never evaluate it.
  IF TG_OP = 'UPDATE' AND TG_ARGV[0] = 'ledger' THEN
    IF OLD.created_at < cutoff
       AND (OLD.conversation_id, OLD.created_at, OLD.agent_id, OLD.source, OLD.node, OLD.model)
           IS NOT DISTINCT FROM (NEW.conversation_id, NEW.created_at, NEW.agent_id, NEW.source, NEW.node, NEW.model) THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (NEW.tenant_id, NULL, 'ledger', NEW.created_at);
      RETURN NULL;
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.created_at < cutoff THEN
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (OLD.tenant_id, OLD.conversation_id, TG_ARGV[0], OLD.created_at);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.created_at < cutoff THEN
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (NEW.tenant_id, NEW.conversation_id, TG_ARGV[0], NEW.created_at);
  END IF;
  -- An update counts only when it moves what decides whether the agent ran: a repricing does not.
  -- Returned early, so the flow log's rows, which have no such columns, never evaluate them.
  IF TG_ARGV[0] <> 'ledger' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.conversation_id, OLD.source, OLD.node, OLD.agent_id)
     IS NOT DISTINCT FROM (NEW.conversation_id, NEW.source, NEW.node, NEW.agent_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.created_at >= cutoff AND OLD.conversation_id IS NOT NULL THEN
    SELECT c.created_at INTO conv_at FROM conversations c WHERE c.id = OLD.conversation_id;
    IF conv_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (OLD.tenant_id, NULL, 'conv', conv_at);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.created_at >= cutoff AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.created_at INTO conv_at FROM conversations c WHERE c.id = NEW.conversation_id;
    IF conv_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (NEW.tenant_id, NULL, 'conv', conv_at);
    END IF;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
