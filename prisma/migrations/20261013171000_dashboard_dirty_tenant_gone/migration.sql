-- A deleted tenant leaves nothing in the queue. Deleting a tenant cascades to its conversations and
-- ledger, whose triggers would queue their days for a tenant no request can settle any more: a row
-- for a tenant that no longer exists is dropped as it is written, and the tenant's own rows go with
-- it. The check reads `tenants` as the writer: `tenants` forces its row-level policy even on its owner,
-- and the writer's policy is the one that matches its queue row, so a tenant writing to its own queue
-- sees itself, a SUPER_ADMIN sees every tenant, and a tenant being deleted is seen by no one.
BEGIN;

CREATE FUNCTION dashboard_dirty_tenant_alive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER dashboard_dirty_tenant_alive BEFORE INSERT ON "dashboard_dirty"
  FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_tenant_alive();

CREATE FUNCTION dashboard_dirty_tenant_gone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM dashboard_dirty WHERE tenant_id = OLD.id;
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_dirty_tenant_gone AFTER DELETE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION dashboard_dirty_tenant_gone();

COMMIT;
