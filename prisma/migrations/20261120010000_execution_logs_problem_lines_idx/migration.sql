-- THE FLOW-LOG LINES THE HEALTH BLOCK COUNTS AS PROBLEMS, INDEXED BY THEMSELVES. `getHealth`
-- (src/modules/analytics/health.ts) counts a window's `warn` and `error` lines. The
-- `(tenant_id, level, created_at)` index serves the same read a little slower; this one holds only
-- the problem lines, so the read touches fewer pages.
--
-- PARTIAL, so its size follows the problem lines and not the log. Text equality is leakproof, so the
-- reader's own `level IN ('warn', 'error')` proves the predicate under the tenant policy. CONCURRENTLY
-- with the DROP first, the same re-runnable shape as 20261011210000, and asserted valid by the
-- migration after this one.
DROP INDEX IF EXISTS "execution_logs_problem_lines_idx";
CREATE INDEX CONCURRENTLY "execution_logs_problem_lines_idx"
    ON "execution_logs"("tenant_id", "created_at")
 WHERE "level" IN ('warn', 'error');
