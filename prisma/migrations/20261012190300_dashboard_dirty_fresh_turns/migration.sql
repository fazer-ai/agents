-- A fresh billed call on an older conversation changes that conversation's kept figures: whether the
-- agent ran on it is read over its whole ledger, so the funnel, the labels and the agent series of
-- the day it was created move. The row itself is too recent to queue, so its conversation's
-- creation day is queued for the conversation figures.
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
  ELSIF TG_OP = 'INSERT' AND TG_ARGV[0] = 'ledger' AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.created_at INTO conv_at FROM conversations c WHERE c.id = NEW.conversation_id;
    IF conv_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (NEW.tenant_id, NULL, 'conv', conv_at);
    END IF;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
