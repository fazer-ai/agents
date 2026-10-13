-- A conversation moved to another thread takes the suggestions proposed on the new thread under its
-- inbox too: their days are queued along with the old thread's.
BEGIN;

CREATE OR REPLACE FUNCTION dashboard_dirty_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.thread_id IS DISTINCT FROM NEW.thread_id) THEN
    INSERT INTO dashboard_dirty (tenant_id, section, at)
    SELECT DISTINCT OLD.tenant_id, 'know', date_bin('15 minutes', q.created_at, TIMESTAMP '2000-01-01')
      FROM approval_queue_items q
     WHERE q.tenant_id = OLD.tenant_id AND q.thread_id = OLD.thread_id AND q.created_at < cutoff;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.thread_id IS DISTINCT FROM NEW.thread_id THEN
    INSERT INTO dashboard_dirty (tenant_id, section, at)
    SELECT DISTINCT NEW.tenant_id, 'know', date_bin('15 minutes', q.created_at, TIMESTAMP '2000-01-01')
      FROM approval_queue_items q
     WHERE q.tenant_id = NEW.tenant_id AND q.thread_id = NEW.thread_id AND q.created_at < cutoff;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
