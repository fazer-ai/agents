-- A transfer line deleted from the flow log (the retention sweep, mostly) queues its conversation. A
-- later `taken_over` line is a person's handoff only when no transfer precedes it, so the line's
-- going changes the cause of the conversation's later handoffs, which may fall in days still within
-- retention and already kept. Settling drops those days and leaves the expired ones as they are.
-- Every other line of the flow log is swept without a trace: no figure of a later day reads it.
BEGIN;

CREATE TRIGGER dashboard_dirty_swept_transfer AFTER DELETE ON "execution_logs"
  FOR EACH ROW
  WHEN (OLD.conversation_id IS NOT NULL
        AND ((OLD.stage = 'handoff'
              AND OLD.detail->>'outcome' IN ('taken_over', 'opened_after_skip', 'guardrail_handoff'))
             OR (OLD.stage = 'tool' AND OLD.detail->>'tool' = 'handoff_to_human')))
  EXECUTE FUNCTION dashboard_dirty_row('log');

COMMIT;
