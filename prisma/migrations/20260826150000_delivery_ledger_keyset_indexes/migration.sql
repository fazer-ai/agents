-- The delivery ledger became a read surface in issue #305 (`GET /v1/webhooks/deliveries`, keyset
-- paginated by id desc, optionally filtered by status), and the indexes the table shipped with were
-- built for the WORKER: `(tenant_id)` alone, and `(status, next_attempt_at)` for the claim.
--
-- Neither serves the operator's page. Measured on a 60k-row table where one tenant's 2,000 rows sit
-- UNDERNEATH a neighbour's 58,000 — a busy installation, which is the case that matters and the one
-- a table with the tenant's rows at the end hides:
--
--   first page, no filter   3.209 ms / 1038 buffers  ->  0.022 ms /  8 buffers
--   first page, status=DEAD 0.125 ms /   34 buffers  ->  0.026 ms / 11 buffers
--
-- The 1038 is the planner walking the primary key backwards through the neighbour's rows to find
-- 51 of ours, and it grows with the NEIGHBOUR's traffic, not with the reader's. The dead-letter
-- page was sorting every matching row on every request.
--
-- Ascending, not `id DESC`: the "after" numbers above were taken with these exact definitions, and
-- the plan reads `Index Only Scan Backward` — a btree walks either way. `(tenant_id)` is left in
-- place: it is the convention on every model here, and removing an index is a separate decision
-- from adding one.
CREATE INDEX "outbound_webhook_deliveries_tenant_id_id_idx"
  ON "outbound_webhook_deliveries" ("tenant_id", "id");

CREATE INDEX "outbound_webhook_deliveries_tenant_id_status_id_idx"
  ON "outbound_webhook_deliveries" ("tenant_id", "status", "id");
