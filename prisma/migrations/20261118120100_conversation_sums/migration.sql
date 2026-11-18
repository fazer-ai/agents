-- THE CONVERSATION COUNTS (issue #1836, docs/dashboard.md "Conversation sums").
--
-- The funnel, the KPIs, the label outcomes and the agent and inbox splits read counts of conversations
-- per UTC quarter hour of creation, inbox, outcome and the agents that ran on them, instead of every
-- conversation of the window with a probe of the ledger each. The same LEDGER_SUMS job that keeps the
-- ledger's sums writes them, below the same safe mark (`ledger_sums_state.summed_until`), and keeps
-- `conversation_agent_runs`, the agents that took a turn on each conversation, from the ledger rows it
-- sums.
--
-- A conversation's figures depend on its own row and on the ledger rows of its agent turns, and both
-- change after a quarter is counted. The statement triggers below append to `conversation_sum_marks`
-- the creation quarter of a conversation whose row changed in a column a figure reads, or that got
-- its first turn from an agent not yet in its runs, and the conversation itself when a ledger row of
-- one of its agent turns was rewritten or deleted (its runs are recomputed). Readers read a marked
-- quarter from the rows until the job has recomputed it.
BEGIN;

CREATE TABLE "conversation_agent_runs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    -- 0 for a legacy ledger row with no agent: it counts as the agent running, under no agent filter.
    "agent_id" BIGINT NOT NULL,

    CONSTRAINT "conversation_agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_agent_runs_tenant_id_conversation_id_agent_id_key" ON "conversation_agent_runs"("tenant_id", "conversation_id", "agent_id");
CREATE INDEX "conversation_agent_runs_tenant_id_agent_id_idx" ON "conversation_agent_runs"("tenant_id", "agent_id");

CREATE TABLE "conversation_quarter_sums" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "quarter" TIMESTAMP(3) NOT NULL,
    "inbox_id" BIGINT,
    -- `outcomeSql`: handoff, unresolved, resolved_by_agent, resolved_before_tracking, resolved_by_other.
    "outcome" TEXT NOT NULL,
    -- Whether any agent turn ran on the conversation, a legacy one with no agent included.
    "ran_any" BOOLEAN NOT NULL,
    -- The agents that ran on it, ascending, without the legacy null.
    "ran_agents" BIGINT[] NOT NULL,
    "labeled" BOOLEAN NOT NULL,
    "conversations" INTEGER NOT NULL,

    CONSTRAINT "conversation_quarter_sums_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_quarter_sums_tenant_id_quarter_idx" ON "conversation_quarter_sums"("tenant_id", "quarter");

CREATE TABLE "conversation_label_quarter_sums" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "quarter" TIMESTAMP(3) NOT NULL,
    "inbox_id" BIGINT,
    "outcome" TEXT NOT NULL,
    "ran_any" BOOLEAN NOT NULL,
    "ran_agents" BIGINT[] NOT NULL,
    "label" TEXT NOT NULL,
    "conversations" INTEGER NOT NULL,

    CONSTRAINT "conversation_label_quarter_sums_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_label_quarter_sums_tenant_id_quarter_idx" ON "conversation_label_quarter_sums"("tenant_id", "quarter");

-- The same two counts per UTC day, added up from the quarters, for the days wholly below the mark. A
-- read with no split by local day takes the days wholly inside its window from here.
CREATE TABLE "conversation_day_sums" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "inbox_id" BIGINT,
    "outcome" TEXT NOT NULL,
    "ran_any" BOOLEAN NOT NULL,
    "ran_agents" BIGINT[] NOT NULL,
    "labeled" BOOLEAN NOT NULL,
    "conversations" INTEGER NOT NULL,

    CONSTRAINT "conversation_day_sums_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_day_sums_tenant_id_day_idx" ON "conversation_day_sums"("tenant_id", "day");

CREATE TABLE "conversation_label_day_sums" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "inbox_id" BIGINT,
    "outcome" TEXT NOT NULL,
    "ran_any" BOOLEAN NOT NULL,
    "ran_agents" BIGINT[] NOT NULL,
    "label" TEXT NOT NULL,
    "conversations" INTEGER NOT NULL,

    CONSTRAINT "conversation_label_day_sums_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_label_day_sums_tenant_id_day_idx" ON "conversation_label_day_sums"("tenant_id", "day");

-- The first response time per UTC day of creation, as a histogram of 5%-wide buckets of seconds.
CREATE TABLE "conversation_first_response_days" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "inbox_id" BIGINT,
    "ran_any" BOOLEAN NOT NULL,
    "ran_agents" BIGINT[] NOT NULL,
    "bucket" INTEGER NOT NULL,
    "conversations" INTEGER NOT NULL,
    "min_seconds" DOUBLE PRECISION NOT NULL,
    "max_seconds" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "conversation_first_response_days_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_first_response_days_tenant_id_day_idx" ON "conversation_first_response_days"("tenant_id", "day");

-- Append-only, like the ledger's: a quarter to recount, a conversation whose runs to recompute, or both.
CREATE TABLE "conversation_sum_marks" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "quarter" TIMESTAMP(3),
    "conversation_id" BIGINT,

    CONSTRAINT "conversation_sum_marks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_sum_marks_tenant_id_quarter_idx" ON "conversation_sum_marks"("tenant_id", "quarter");
CREATE INDEX "conversation_sum_marks_tenant_id_conversation_id_idx" ON "conversation_sum_marks"("tenant_id", "conversation_id");

ALTER TABLE "conversation_agent_runs" ADD CONSTRAINT "conversation_agent_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_agent_runs" ADD CONSTRAINT "conversation_agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_quarter_sums" ADD CONSTRAINT "conversation_quarter_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_label_quarter_sums" ADD CONSTRAINT "conversation_label_quarter_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_day_sums" ADD CONSTRAINT "conversation_day_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_label_day_sums" ADD CONSTRAINT "conversation_label_day_sums_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_first_response_days" ADD CONSTRAINT "conversation_first_response_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_sum_marks" ADD CONSTRAINT "conversation_sum_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_agent_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_quarter_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_quarter_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_label_quarter_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_label_quarter_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_day_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_day_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_label_day_sums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_label_day_sums" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_first_response_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_first_response_days" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversation_sum_marks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_sum_marks" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "conversation_agent_runs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "conversation_quarter_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "conversation_label_quarter_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "conversation_day_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "conversation_label_day_sums"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "conversation_first_response_days"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "conversation_sum_marks"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_agent_runs" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_quarter_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_label_quarter_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_day_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_label_day_sums" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_first_response_days" TO %I USING (true) WITH CHECK (true)', v_fleet);
  EXECUTE format('CREATE POLICY fleet_super_admin ON "conversation_sum_marks" TO %I USING (true) WITH CHECK (true)', v_fleet);
END $$;

-- A conversation row: a mark for the creation quarter (old and new) of every row older than the grace
-- whose figures could have moved. The webhook rewrites a conversation on most events, and most of
-- those touch no column read here, so the comparison is per row and only a real change marks.
CREATE FUNCTION conversation_sum_mark() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO conversation_sum_marks (tenant_id, quarter)
    SELECT DISTINCT n.tenant_id, ledger_quarter(n.created_at) FROM new_rows n
     WHERE n.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = n.tenant_id);
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO conversation_sum_marks (tenant_id, quarter)
    SELECT DISTINCT r.tenant_id, ledger_quarter(r.created_at)
      FROM old_rows o JOIN new_rows n ON n.id = o.id
     CROSS JOIN LATERAL (VALUES (o.tenant_id, o.created_at), (n.tenant_id, n.created_at)) AS r(tenant_id, created_at)
     WHERE r.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id)
       AND (o.status, o.assignee_type, o.resolved_by, o.inbox_id, o.sweep_only, o.created_at, o.labels,
            o.chatwoot_created_at, o.chatwoot_first_reply_at, o.chatwoot_platform_reply_at)
           IS DISTINCT FROM
           (n.status, n.assignee_type, n.resolved_by, n.inbox_id, n.sweep_only, n.created_at, n.labels,
            n.chatwoot_created_at, n.chatwoot_first_reply_at, n.chatwoot_platform_reply_at);
  ELSE
    INSERT INTO conversation_sum_marks (tenant_id, quarter)
    SELECT DISTINCT o.tenant_id, ledger_quarter(o.created_at) FROM old_rows o
     WHERE o.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = o.tenant_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER conversation_sum_mark_insert AFTER INSERT ON "conversations"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_sum_mark();

CREATE TRIGGER conversation_sum_mark_update AFTER UPDATE ON "conversations"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_sum_mark();

CREATE TRIGGER conversation_sum_mark_delete AFTER DELETE ON "conversations"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_sum_mark();

-- Whether a ledger row's node is an agent taking a turn (`agentTurnSql`): `NON_AGENT_TURN_NODES`
-- (src/graph/usage.ts) as SQL, fenced against it by tests/modules/analytics-conversation-sums.test.ts.
CREATE FUNCTION ledger_is_agent_turn(node text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT node IS NULL OR node NOT IN ('choice_check', 'vision', 'observer', 'decision', 'suggestion_review',
    'other_inbox_summary', 'occurrence_reading', 'occurrence_canonical', 'occurrence_assignment',
    'occurrence_consolidation', 'occurrence_transcription', 'occurrence_vision')
$$;

-- The ledger's side. An agent turn of the inbox source (`agentTurnSql`) written, rewritten or deleted
-- on a conversation counted already marks the conversation, whose runs the job recomputes.
CREATE FUNCTION conversation_run_mark() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutoff timestamp := (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes';
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The conversation, not its quarter: the job recomputes its runs from every ledger row before it
    -- recounts the quarter, so a turn whose own ledger quarter is still unsummed is not missed.
    INSERT INTO conversation_sum_marks (tenant_id, conversation_id)
    SELECT DISTINCT c.tenant_id, c.id
      FROM new_rows n JOIN conversations c ON c.id = n.conversation_id
     WHERE n.source = 'inbox' AND ledger_is_agent_turn(n.node)
       -- NOTE: even a turn by an agent whose run is kept. A rebuild may be dropping that run, in a
       -- transaction this one cannot see, and commit before this turn does.
       AND c.created_at < cutoff AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = n.tenant_id);
  ELSIF TG_OP = 'UPDATE' THEN
    -- A re-price rewrites the cost of every row of a month and moves no run: only a row whose
    -- conversation, agent, node or source changed is a run that may have moved.
    INSERT INTO conversation_sum_marks (tenant_id, conversation_id)
    SELECT DISTINCT r.tenant_id, r.conversation_id
      FROM old_rows o JOIN new_rows n ON n.id = o.id
     CROSS JOIN LATERAL (VALUES (o.tenant_id, o.conversation_id, o.source, o.node),
                                (n.tenant_id, n.conversation_id, n.source, n.node)) AS r(tenant_id, conversation_id, source, node)
     WHERE (o.conversation_id, o.agent_id, o.node, o.source) IS DISTINCT FROM (n.conversation_id, n.agent_id, n.node, n.source)
       AND r.conversation_id IS NOT NULL AND r.source = 'inbox' AND ledger_is_agent_turn(r.node)
       AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id);
  ELSE
    INSERT INTO conversation_sum_marks (tenant_id, conversation_id)
    SELECT DISTINCT o.tenant_id, o.conversation_id FROM old_rows o
     WHERE o.conversation_id IS NOT NULL AND o.source = 'inbox' AND ledger_is_agent_turn(o.node)
       AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = o.tenant_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER conversation_run_mark_insert AFTER INSERT ON "llm_usage"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_run_mark();

CREATE TRIGGER conversation_run_mark_update AFTER UPDATE ON "llm_usage"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_run_mark();

CREATE TRIGGER conversation_run_mark_delete AFTER DELETE ON "llm_usage"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_run_mark();

COMMIT;
