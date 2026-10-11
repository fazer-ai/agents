-- THE FLOW-LOG LINES THE DASHBOARD COUNTS, INDEXED BY THEMSELVES. The handoff reasons, the silences
-- and the follow-up activity (src/modules/analytics/activity.ts) each want a few percent of a
-- window's lines, picked by a key inside `detail`; without this they read every `tool` and
-- `generate` line of the window, and a `generate` line's `detail` is large enough to be stored out of
-- line, so the scan decompresses most of the log to throw it away.
--
-- PARTIAL, so it holds only those lines and its size follows them, not the log. Each reader's own
-- predicate implies one arm, which is what lets Postgres use it. CONCURRENTLY with the DROP first, the
-- same re-runnable shape as 20261010120100, and asserted valid by the migration after this one.
DROP INDEX IF EXISTS "execution_logs_dashboard_lines_idx";
CREATE INDEX CONCURRENTLY "execution_logs_dashboard_lines_idx"
    ON "execution_logs"("tenant_id", "stage", "created_at")
 WHERE "stage" = 'handoff'
    OR ("stage" = 'tool' AND ("detail"->>'tool') IN ('handoff_to_human', 'skip_reply'))
    OR ("stage" = 'generate' AND ("detail"->>'trigger') = 'followup');
