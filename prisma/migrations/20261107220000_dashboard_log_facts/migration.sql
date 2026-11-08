-- THE FLOW-LOG LINES THE DASHBOARD READS, KEPT AS FACTS (issue #1731, docs/dashboard.md "Log facts").
--
-- The handoff, silence and follow-up figures read a few lines out of the busiest table of the
-- database, and decide what each line is from keys inside its `detail`. Here that is decided once,
-- when the line is written, by a trigger and not by the writer: every writer of `execution_logs` (the
-- flow-log writer, a script, a fixture) gets the same fact. A line leaves the facts with the line
-- itself, whatever deletes it.
--
-- One part of a cause is NOT fixed here: whether a `taken_over` line is a person taking the
-- conversation or a later sighting of a person already holding it. That depends on the conversation's
-- other transfers and turns, which can be written after the line (a transaction that commits late)
-- or swept before it (retention), so the readers work it out over these facts when they read, the
-- same rule `CAUSE_SQL` applies to the log.
--
-- Lines written before this migration are filled in by the DASHBOARD_LOG_FACTS_BACKFILL job, in
-- batches, never here: a tenant's readers keep reading `execution_logs` while its
-- `dashboard_log_facts_state` row says the backfill has not finished. A tenant created after this
-- migration has no such row and reads the facts from the start.
--
-- Wrapped in a transaction: a failure between a CREATE TABLE and its FORCE ROW LEVEL SECURITY leaves a
-- tenant-scoped table that does not bind its owner (.claude/rules/prisma.md).
BEGIN;

-- The log first, then the tenants. During a rolling deploy the old container keeps writing lines, and
-- a line's insert holds `execution_logs` while its tenant foreign key reads `tenants`; taking
-- `tenants` here before the triggers' lock on `execution_logs` would be the opposite order, and one
-- of the two would be aborted as a deadlock. Held to COMMIT, so writers wait for the migration.
LOCK TABLE "execution_logs" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "dashboard_log_facts" (
    "line_id" BIGINT NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "turn_id" TEXT NOT NULL,
    "conversation_id" BIGINT,
    "agent_id" BIGINT,
    "inbox_id" BIGINT,
    "source" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "cause" TEXT,
    "target" TEXT,
    "reason" TEXT,

    CONSTRAINT "dashboard_log_facts_pkey" PRIMARY KEY ("line_id")
);

CREATE INDEX "dashboard_log_facts_tenant_id_kind_created_at_idx" ON "dashboard_log_facts"("tenant_id", "kind", "created_at");
-- The earlier transfers of a conversation, which decide whether a `taken_over` is a person.
CREATE INDEX "dashboard_log_facts_tenant_id_conversation_id_created_at_idx" ON "dashboard_log_facts"("tenant_id", "conversation_id", "created_at");

ALTER TABLE "dashboard_log_facts" ADD CONSTRAINT "dashboard_log_facts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dashboard_log_facts_state" (
    "tenant_id" BIGINT NOT NULL,
    "cursor_at" TIMESTAMP(3),
    "backfilled_at" TIMESTAMP(3),

    CONSTRAINT "dashboard_log_facts_state_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "dashboard_log_facts_state" ADD CONSTRAINT "dashboard_log_facts_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dashboard_log_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_log_facts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_log_facts_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_log_facts_state" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dashboard_log_facts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "dashboard_log_facts_state"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

-- Every tenant that exists now has lines from before the facts: each waits for its backfill. Both
-- tables lifted around the statement, since a forced table read or written here decides on zero rows
-- (.claude/rules/prisma.md).
ALTER TABLE "tenants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_log_facts_state" NO FORCE ROW LEVEL SECURITY;
INSERT INTO "dashboard_log_facts_state" ("tenant_id") SELECT "id" FROM "tenants";
ALTER TABLE "dashboard_log_facts_state" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "dashboard_log_facts" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "dashboard_log_facts_state" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

-- The fact a line is, or none: a transfer with its cause and, for a hand-over line, where it went; a
-- `skip_reply` call that ran, with its reason; a follow-up step that reached the customer. The same
-- definitions the readers have over `execution_logs` (`CAUSE_SQL`, `TARGET_SQL`, `callRanSql`,
-- src/modules/analytics/activity.ts), with `taken_over` kept as itself: the readers decide whether it
-- is a person. Every transfer is a fact, so the facts also hold the earlier transfers that decision
-- looks for. Shared by the trigger and the backfill, and a no-op on a line already in.
CREATE FUNCTION dashboard_log_fact_put(l execution_logs) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_cause text;
  v_target text;
  v_reason text;
  ran boolean := l.status = 'ok' AND l.detail->>'phase' IS NULL;
BEGIN
  IF l.stage = 'handoff' OR (l.stage = 'tool' AND l.detail->>'tool' = 'handoff_to_human') THEN
    IF l.conversation_id IS NULL THEN
      RETURN;
    END IF;
    v_cause := CASE
      WHEN l.stage = 'tool' AND ran AND COALESCE(l.detail->>'handedOff', 'true') = 'true' THEN 'agent'
      WHEN l.stage = 'handoff' AND l.detail->>'outcome' = 'opened_after_skip'
        THEN 'skip_' || COALESCE(l.detail->>'reason', 'unanswered')
      WHEN l.stage = 'handoff' AND l.detail->>'outcome' = 'guardrail_handoff' THEN 'guardrail'
      WHEN l.stage = 'handoff' AND l.detail->>'outcome' = 'taken_over' THEN 'taken_over'
    END;
    IF v_cause IS NULL THEN
      RETURN;
    END IF;
    v_kind := 'handoff';
    IF l.stage = 'handoff' THEN
      v_target := CASE l.detail->>'assigned'
        WHEN 'agent' THEN 'pinned' WHEN 'team' THEN 'pinned' WHEN 'routing' THEN 'routing'
        WHEN 'failed' THEN 'not_assigned' WHEN 'withdrawn' THEN 'not_assigned' END;
    END IF;
  ELSIF l.stage = 'tool' AND l.detail->>'tool' = 'skip_reply' AND ran THEN
    v_kind := 'silence';
    v_reason := COALESCE(l.detail->>'skipReason', 'unrecorded');
  ELSIF l.stage = 'generate' AND l.detail->>'trigger' = 'followup'
        AND l.detail->>'outcome' IN ('messaged', 'templated') AND l.conversation_id IS NOT NULL THEN
    v_kind := 'followup';
  ELSE
    RETURN;
  END IF;
  INSERT INTO dashboard_log_facts (line_id, tenant_id, created_at, turn_id, conversation_id, agent_id,
                                   inbox_id, source, anonymous, kind, cause, target, reason)
  VALUES (l.id, l.tenant_id, l.created_at, l.turn_id, l.conversation_id, l.agent_id, l.inbox_id,
          l.source, l.anonymous, v_kind, v_cause, v_target, v_reason)
  ON CONFLICT (line_id) DO NOTHING;
END $$;

CREATE FUNCTION dashboard_log_fact_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dashboard_log_fact_put(NEW);
  RETURN NULL;
END $$;

-- Only the stages a fact can come from reach the function.
CREATE TRIGGER dashboard_log_fact_insert AFTER INSERT ON "execution_logs"
  FOR EACH ROW WHEN (NEW.stage IN ('handoff', 'tool', 'generate'))
  EXECUTE FUNCTION dashboard_log_fact_insert();

-- Nothing in the product rewrites a line, but a line that is rewritten is the fact it now is.
CREATE FUNCTION dashboard_log_fact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM dashboard_log_facts WHERE line_id = OLD.id;
  PERFORM dashboard_log_fact_put(NEW);
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_log_fact_update AFTER UPDATE ON "execution_logs"
  FOR EACH ROW WHEN (OLD.stage IN ('handoff', 'tool', 'generate') OR NEW.stage IN ('handoff', 'tool', 'generate'))
  EXECUTE FUNCTION dashboard_log_fact_update();

-- Once per statement, by the ids it deleted: the retention sweep deletes in batches, and a row-level
-- trigger would add a statement per line to it. Only the stages a fact can come from are looked up.
CREATE FUNCTION dashboard_log_fact_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM dashboard_log_facts f
   WHERE f.line_id = ANY (ARRAY(SELECT id FROM gone WHERE stage IN ('handoff', 'tool', 'generate')));
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_log_fact_delete AFTER DELETE ON "execution_logs"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION dashboard_log_fact_delete();

-- A TRUNCATE takes every line of every tenant, so every fact goes with it, by a TRUNCATE too: it is not
-- bound by row security, where a DELETE run without a tenant would remove nothing. A
-- `TRUNCATE tenants CASCADE` truncates both tables in one statement, and the second TRUNCATE is then
-- refused as a table in use: the facts are already being emptied by that statement.
CREATE FUNCTION dashboard_log_fact_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    TRUNCATE dashboard_log_facts;
  EXCEPTION WHEN object_in_use THEN
    NULL;
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER dashboard_log_fact_truncate AFTER TRUNCATE ON "execution_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION dashboard_log_fact_truncate();

COMMIT;
