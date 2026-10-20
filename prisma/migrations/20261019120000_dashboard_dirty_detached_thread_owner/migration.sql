-- A client thread changing owner (an anonymous visitor signing in hands it over) or going away (an
-- anonymous thread expiring, or its user deleted) changes which audience its knowledge suggestions
-- count under, so the kept knowledge days of those suggestions are queued like any other late change.
-- Per statement, over the transition tables: the expiry sweep deletes threads in batches and
-- `approval_queue_items` has no index on `thread_id`, so one scan per statement, led by the tenant.
CREATE FUNCTION dashboard_dirty_detached_thread() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (now() AT TIME ZONE 'UTC') - interval '24 hours';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO dashboard_dirty (tenant_id, section, at)
    SELECT DISTINCT q.tenant_id, 'know', q.created_at
      FROM old_rows o
      JOIN new_rows n ON n.thread_id = o.thread_id
      JOIN approval_queue_items q ON q.tenant_id = o.tenant_id AND q.thread_id = o.thread_id
     WHERE split_part(o.thread_id, ':', 2) = 'client'
       AND o.external_user_id IS DISTINCT FROM n.external_user_id
       AND q.created_at < cutoff;
  ELSE
    INSERT INTO dashboard_dirty (tenant_id, section, at)
    SELECT DISTINCT q.tenant_id, 'know', q.created_at
      FROM old_rows o
      JOIN approval_queue_items q ON q.tenant_id = o.tenant_id AND q.thread_id = o.thread_id
     WHERE split_part(o.thread_id, ':', 2) = 'client'
       AND q.created_at < cutoff;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_dirty_update AFTER UPDATE ON "detached_threads"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION dashboard_dirty_detached_thread();

CREATE TRIGGER dashboard_dirty_delete AFTER DELETE ON "detached_threads"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION dashboard_dirty_detached_thread();
