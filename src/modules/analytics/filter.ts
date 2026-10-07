import { Prisma } from "@/../generated/prisma/client";
import { NON_AGENT_TURN_NODES, type UsageSource } from "@/graph/usage";

// THE DASHBOARD'S ONE FILTER. Every block of the page reads the same window, agent, inbox and source,
// so a number in one block can be checked against another, and the drill-down to the conversation
// list asks for exactly the rows a figure counted. The SQL fragments below are the only definition of
// "the conversations of this view" and "the ledger rows of this view": the KPIs, the trends, the
// dimension table and the conversation list all build on them (docs/dashboard.md).

export interface DashboardFilter {
  // Half-open window [since, until). Either side may be open.
  since?: Date;
  until?: Date;
  // Usage segment for ledger figures. Conversation figures are real traffic by construction (a
  // playground turn has no conversation), so they ignore it.
  source?: UsageSource;
  agentId?: bigint;
  inboxId?: bigint;
  // IANA zone the daily buckets are cut in; validated by the caller (normalizeTimeZone).
  tz?: string;
}

const NON_TURN = Prisma.join(NON_AGENT_TURN_NODES.map((n) => Prisma.sql`${n}`));

// A ledger row that is the agent taking a turn, as `getKpis` has always counted it: a row with no
// node is an agent turn (legacy rows), and vision, observer and suggestion review are not.
export function agentTurnSql(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}.node IS NULL OR ${a}.node NOT IN (${NON_TURN}))`;
}

function windowSql(column: Prisma.Sql, f: DashboardFilter): Prisma.Sql {
  const since = f.since ?? null;
  const until = f.until ?? null;
  return Prisma.sql`(${since}::timestamptz IS NULL OR ${column} >= ${since})
    AND (${until}::timestamptz IS NULL OR ${column} < ${until})`;
}

// "The agent ran on this conversation": a real-traffic agent turn on it, by the filtered agent when
// there is one. Involvement, and the agent filter on conversations, are both this predicate.
export function agentRanSql(
  convAlias: string,
  agentId: bigint | null | undefined,
): Prisma.Sql {
  const c = Prisma.raw(convAlias);
  const agent = agentId ?? null;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM llm_usage ar
     WHERE ar.conversation_id = ${c}.id
       AND ar.source = 'inbox'
       AND ${agentTurnSql("ar")}
       AND (${agent}::bigint IS NULL OR ar.agent_id = ${agent}))`;
}

// The conversations a view counts: created in the window (our row's `created_at`, the moment the
// conversation reached us), in the inbox when one is filtered, and, under an agent filter, the ones
// whose inbox is bound to that agent or that the agent ran on. The second arm keeps a conversation
// the agent answered before its inbox was re-bound; the first keeps the ones it never got to, so
// involvement under an agent filter can still be below 100%.
export function cohortWhereSql(
  convAlias: string,
  f: DashboardFilter,
): Prisma.Sql {
  const c = Prisma.raw(convAlias);
  const inbox = f.inboxId ?? null;
  const agent = f.agentId ?? null;
  return Prisma.sql`${windowSql(Prisma.sql`${c}.created_at`, f)}
    AND (${inbox}::bigint IS NULL OR ${c}.inbox_id = ${inbox})
    AND (${agent}::bigint IS NULL
         OR EXISTS (SELECT 1 FROM inboxes bi WHERE bi.id = ${c}.inbox_id AND bi.agent_id = ${agent})
         OR ${agentRanSql(convAlias, agent)})`;
}

// The ledger rows a view sums: billed in the window, in the segment, by the agent and in the inbox
// filtered. Every money and request figure on the page is a sum over these rows.
export function usageWhereSql(alias: string, f: DashboardFilter): Prisma.Sql {
  const u = Prisma.raw(alias);
  const source = f.source ?? null;
  const agent = f.agentId ?? null;
  const inbox = f.inboxId ?? null;
  return Prisma.sql`${windowSql(Prisma.sql`${u}.created_at`, f)}
    AND (${source}::text IS NULL OR ${u}.source = ${source})
    AND (${agent}::bigint IS NULL OR ${u}.agent_id = ${agent})
    AND (${inbox}::bigint IS NULL OR ${u}.inbox_id = ${inbox})`;
}

// Same for the flow log, which carries the same agent, inbox and source columns, with one
// difference: some lines name the conversation and not the inbox (a person taking over is written
// from the webhook, before any inbox is resolved), so under an inbox filter a line with no inbox is
// the inbox of its conversation. The Logs page reads the same rule (`buildLogWhere`).
export function logWhereSql(alias: string, f: DashboardFilter): Prisma.Sql {
  const l = Prisma.raw(alias);
  const source = f.source ?? null;
  const agent = f.agentId ?? null;
  const inbox = f.inboxId ?? null;
  return Prisma.sql`${windowSql(Prisma.sql`${l}.created_at`, f)}
    AND (${source}::text IS NULL OR ${l}.source = ${source})
    AND (${agent}::bigint IS NULL OR ${l}.agent_id = ${agent})
    AND (${inbox}::bigint IS NULL OR ${l}.inbox_id = ${inbox}
         OR (${l}.inbox_id IS NULL AND EXISTS (
               SELECT 1 FROM conversations lc
                WHERE lc.id = ${l}.conversation_id AND lc.inbox_id = ${inbox})))`;
}

// The local day of a `timestamp without time zone` column holding UTC wall-clock: shifted to an
// instant first, then rendered in the zone (a single shift would read it as already local).
export function localDaySql(column: Prisma.Sql, tz: string): Prisma.Sql {
  return Prisma.sql`to_char(date_trunc('day', ${column} AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text), 'YYYY-MM-DD')`;
}

// classifyOutcome (src/modules/conversations/resolution-origin.ts) in SQL, so a figure can group by it.
// The order is that function's: a human owner wins over any origin. Fenced against the TS rule by
// tests/modules/analytics-outcome-sql.test.ts.
export function outcomeSql(convAlias: string): Prisma.Sql {
  const c = Prisma.raw(convAlias);
  return Prisma.sql`(CASE
    WHEN ${c}.assignee_type = 'User' THEN 'handoff'
    WHEN ${c}.status <> 'resolved' THEN 'unresolved'
    WHEN ${c}.resolved_by = 'agent' THEN 'resolved_by_agent'
    WHEN ${c}.resolved_by = 'legacy_unknown' THEN 'resolved_before_tracking'
    ELSE 'resolved_by_other' END)`;
}
