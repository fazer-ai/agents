-- An inbox carries several observers (issue #1111): the binding is unique per (tenant, inbox, agent).
-- The new index is created before the old one goes, so a table that somehow held a repeated pair
-- fails here instead of losing its guard. Existing rows satisfy it by construction: the old index
-- was stricter. Rolling back past this migration needs the extra observers removed first
-- (docs/deploy.md).
CREATE UNIQUE INDEX "inbox_observers_tenant_id_inbox_id_agent_id_key" ON "inbox_observers"("tenant_id", "inbox_id", "agent_id");

DROP INDEX "inbox_observers_tenant_id_inbox_id_key";
