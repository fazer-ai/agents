-- Whether the agent ran on a conversation is read over its whole ledger, so a fresh billed call
-- deleted, or moved to another conversation, agent, source or node, changes the kept figures of the
-- day an older conversation started, as a fresh call written does (migration
-- 20261013170300_dashboard_dirty_fresh_turns). The row is too recent to queue for itself: the
-- creation days of the conversations it leaves and joins are queued instead.
BEGIN;

CREATE OR REPLACE FUNCTION dashboard_dirty_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
  conv_at timestamp;
BEGIN
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
