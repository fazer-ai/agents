-- A bare `(tenant_id)` index that `merchant_products_tenant_id_category_idx`
-- already answers: a btree serves any leading prefix of its key columns, so the
-- composite covers `WHERE tenant_id = $1`, and the bare one is a second index
-- tuple to write on every insert that answers nothing the composite could not.
--
-- CONCURRENTLY so the drop never takes ACCESS EXCLUSIVE, one statement per file
-- because `prisma migrate deploy` wraps a multi-statement file in a transaction
-- and `DROP INDEX CONCURRENTLY` cannot run inside one, and `IF EXISTS` so a
-- cancelled concurrent drop can be re-run cleanly.
DROP INDEX CONCURRENTLY IF EXISTS "merchant_products_tenant_id_idx";
