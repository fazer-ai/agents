-- Two more changes that move kept days. A conversation whose creation is corrected from a day never
-- kept (today, yesterday) into one that is: its new day is queued. A ledger line whose turn changes,
-- or a fresh billed call on an older conversation, changes whether a person taking over counts as a
-- handoff, which is read on the conversation's flow-log days: the fresh call now queues its
-- conversation as a ledger change (its creation day, its ledger days and its flow-log days), and a
-- changed turn is no repricing. A first reply found to be the platform's (`chatwoot_platform_reply_at`)
-- moves the first-response figures, so it queues its conversation too.
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
  ELSIF (OLD.created_at < cutoff OR NEW.created_at < cutoff)
    AND (OLD.status, OLD.resolved_by, OLD.assignee_type, OLD.inbox_id, OLD.labels,
         OLD.last_inbound_at, OLD.chatwoot_created_at, OLD.chatwoot_first_reply_at,
         OLD.chatwoot_platform_reply_at, OLD.created_at)
        IS DISTINCT FROM
        (NEW.status, NEW.resolved_by, NEW.assignee_type, NEW.inbox_id, NEW.labels,
         NEW.last_inbound_at, NEW.chatwoot_created_at, NEW.chatwoot_first_reply_at,
         NEW.chatwoot_platform_reply_at, NEW.created_at) THEN
    -- Backdated from a day never kept into one that is, the conversation's new day is queued.
    INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
    VALUES (NEW.tenant_id, NEW.id, NULL,
            CASE WHEN OLD.created_at < cutoff THEN OLD.created_at ELSE NEW.created_at END);
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
       AND (OLD.conversation_id, OLD.created_at, OLD.agent_id, OLD.inbox_id, OLD.source, OLD.node, OLD.model, OLD.turn_id)
           IS NOT DISTINCT FROM (NEW.conversation_id, NEW.created_at, NEW.agent_id, NEW.inbox_id, NEW.source, NEW.node, NEW.model, NEW.turn_id) THEN
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
  IF TG_OP = 'UPDATE' AND (OLD.conversation_id, OLD.source, OLD.node, OLD.agent_id, OLD.turn_id)
     IS NOT DISTINCT FROM (NEW.conversation_id, NEW.source, NEW.node, NEW.agent_id, NEW.turn_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.created_at >= cutoff AND OLD.conversation_id IS NOT NULL THEN
    SELECT c.created_at INTO conv_at FROM conversations c WHERE c.id = OLD.conversation_id;
    IF conv_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (OLD.tenant_id, OLD.conversation_id, 'ledger', conv_at);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.created_at >= cutoff AND NEW.conversation_id IS NOT NULL THEN
    SELECT c.created_at INTO conv_at FROM conversations c WHERE c.id = NEW.conversation_id;
    IF conv_at < cutoff THEN
      INSERT INTO dashboard_dirty (tenant_id, conversation_id, section, at)
      VALUES (NEW.tenant_id, NEW.conversation_id, 'ledger', conv_at);
    END IF;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
