import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  agentRanSql,
  agentTurnSql,
  cohortWhereSql,
  type DashboardFilter,
  localDaySql,
  logWhereSql,
  outcomeSql,
} from "./filter";
import { normalizeTimeZone } from "./service";

// WHAT THE AGENT DOES BESIDES ANSWERING, read from the flow log, the conversation mirror and the
// knowledge queue: why conversations leave it, what they are about, the follow-ups it sends and the
// knowledge it proposes. Each figure names its source in docs/dashboard.md.

// Why a conversation left the agent, one category per writer of that event. The model's own reason
// for `handoff_to_human` is free text and never repeats, so it is not a category; the categories are
// who decided, and for `skip_reply` the closed reason the model picked.
export const HANDOFF_CAUSES = [
  // The agent called handoff_to_human and the transfer happened (`detail.handedOff`; a line written
  // before that mark counts when the call returned cleanly, as it did before).
  "agent",
  // The agent stayed silent with skip_reply and the conversation was opened for a person: the reason
  // the model gave (needs_human, not_for_us) or a turn that ended with nothing said (unanswered).
  "skip_needs_human",
  "skip_not_for_us",
  "skip_unanswered",
  // A guardrail stopped the reply and handed the conversation over.
  "guardrail",
  // A person replied or took the conversation in Chatwoot. Every gate that meets a human owner logs
  // `taken_over` again (each new customer message on a conversation a person holds), so a line counts
  // only when the agent took a turn since the conversation's previous one: the takeover, not each
  // later sighting of it. A takeover after the conversation was handed back still counts.
  "person",
] as const;
export type HandoffCause = (typeof HANDOFF_CAUSES)[number];

export interface HandoffReasons {
  // Conversations per cause per local day. One conversation counts once per cause and day.
  days: { date: string; cause: HandoffCause; conversations: number }[];
  totals: { cause: HandoffCause; conversations: number }[];
  // skip_reply calls per reason, the silences whether or not they handed anything over. "unrecorded"
  // is a line written before the reason was logged.
  silences: { reason: string; turns: number }[];
}

const CAUSE_SQL = Prisma.sql`(CASE
  WHEN l.stage = 'tool' AND l.detail->>'tool' = 'handoff_to_human' AND l.status = 'ok'
       AND COALESCE(l.detail->>'handedOff', 'true') = 'true' THEN 'agent'
  WHEN l.stage = 'handoff' AND l.detail->>'outcome' = 'opened_after_skip'
    THEN 'skip_' || COALESCE(l.detail->>'reason', 'unanswered')
  WHEN l.stage = 'handoff' AND l.detail->>'outcome' = 'guardrail_handoff' THEN 'guardrail'
  WHEN l.stage = 'handoff' AND l.detail->>'outcome' = 'taken_over'
       AND NOT EXISTS (
         SELECT 1 FROM execution_logs p
          WHERE p.conversation_id = l.conversation_id
            AND p.stage = 'handoff' AND p.detail->>'outcome' = 'taken_over'
            AND p.created_at < l.created_at
            AND NOT EXISTS (
              SELECT 1 FROM llm_usage u
               WHERE u.conversation_id = l.conversation_id
                 AND u.source = 'inbox' AND ${agentTurnSql("u")}
                 AND u.created_at > p.created_at AND u.created_at < l.created_at))
    THEN 'person'
  END)`;

export async function getHandoffReasons(
  ctx: TenantContext,
  filter: DashboardFilter,
  base: PrismaClient = basePrisma,
): Promise<HandoffReasons> {
  const tz = normalizeTimeZone(filter.tz);
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.$queryRaw<
      { date: string; cause: string; conversations: number }[]
    >(Prisma.sql`
      SELECT date, cause, COUNT(DISTINCT conversation_id)::int AS conversations
        FROM (SELECT ${localDaySql(Prisma.sql`l.created_at`, tz)} AS date,
                     ${CAUSE_SQL} AS cause,
                     l.conversation_id
                FROM execution_logs l
               WHERE ${logWhereSql("l", filter)}
                 AND l.conversation_id IS NOT NULL
                 AND l.stage IN ('tool', 'handoff')) x
       WHERE cause IS NOT NULL
       GROUP BY 1, 2
       ORDER BY 1, 2`);
    const [totalsRows, silences] = [
      await db.$queryRaw<{ cause: string; conversations: number }[]>(
        Prisma.sql`
        SELECT cause, COUNT(DISTINCT conversation_id)::int AS conversations
          FROM (SELECT ${CAUSE_SQL} AS cause, l.conversation_id
                  FROM execution_logs l
                 WHERE ${logWhereSql("l", filter)}
                   AND l.conversation_id IS NOT NULL
                   AND l.stage IN ('tool', 'handoff')) x
         WHERE cause IS NOT NULL
         GROUP BY 1`,
      ),
      await db.$queryRaw<{ reason: string; turns: number }[]>(Prisma.sql`
        SELECT COALESCE(l.detail->>'skipReason', 'unrecorded') AS reason,
               COUNT(*)::int AS turns
          FROM execution_logs l
         WHERE ${logWhereSql("l", filter)}
           AND l.stage = 'tool'
           AND l.detail->>'tool' = 'skip_reply'
           -- Only a call that ran: a refused one (arguments that failed the schema) is logged as
           -- skipped and silenced nothing.
           AND l.status = 'ok'
         GROUP BY 1
         ORDER BY 2 DESC`),
    ];
    const known = (c: string): c is HandoffCause =>
      (HANDOFF_CAUSES as readonly string[]).includes(c);
    return {
      days: rows
        .filter((r) => known(r.cause))
        .map((r) => ({
          date: r.date,
          cause: r.cause as HandoffCause,
          conversations: Number(r.conversations),
        })),
      totals: totalsRows
        .filter((r) => known(r.cause))
        .map((r) => ({
          cause: r.cause as HandoffCause,
          conversations: Number(r.conversations),
        }))
        .sort((a, b) => b.conversations - a.conversations),
      silences: silences.map((s) => ({
        reason: s.reason,
        turns: Number(s.turns),
      })),
    };
  });
}

export interface LabelOutcome {
  label: string;
  conversations: number;
  involved: number;
  resolvedByBot: number;
  handoff: number;
  // Of the involved: resolved by the agent. Null when the agent ran on none of them.
  resolutionRate: number | null;
}

export interface LabelOutcomes {
  labels: LabelOutcome[];
  // Conversations of the view with no label recorded. They count in no row above.
  unlabeled: number;
}

// Volume and outcome per conversation label, over the view's conversations. A conversation with two
// labels counts in both rows, so the rows do not add up to the total, and the page says so.
export async function getLabelOutcomes(
  ctx: TenantContext,
  filter: DashboardFilter,
  base: PrismaClient = basePrisma,
): Promise<LabelOutcomes> {
  return runScopedOn(base, ctx, async (db) => {
    const ran = agentRanSql("c", filter.agentId);
    const outcome = outcomeSql("c");
    const rows = await db.$queryRaw<
      {
        label: string;
        total: number;
        involved: number;
        resolved: number;
        handoff: number;
      }[]
    >(Prisma.sql`
      SELECT lb.label,
             COUNT(DISTINCT c.id)::int AS total,
             COUNT(DISTINCT c.id) FILTER (WHERE ${ran})::int AS involved,
             COUNT(DISTINCT c.id) FILTER (WHERE ${ran} AND ${outcome} = 'resolved_by_agent')::int AS resolved,
             COUNT(DISTINCT c.id) FILTER (WHERE ${ran} AND ${outcome} = 'handoff')::int AS handoff
        FROM conversations c
        CROSS JOIN LATERAL unnest(c.labels) AS lb(label)
       WHERE ${cohortWhereSql("c", filter)}
       GROUP BY 1
       ORDER BY 2 DESC, 1`);
    const [unlabeled] = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM conversations c
       WHERE ${cohortWhereSql("c", filter)} AND cardinality(c.labels) = 0`);
    return {
      labels: rows.map((r) => {
        const involved = Number(r.involved);
        const resolvedByBot = Number(r.resolved);
        return {
          label: r.label,
          conversations: Number(r.total),
          involved,
          resolvedByBot,
          handoff: Number(r.handoff),
          resolutionRate: involved > 0 ? resolvedByBot / involved : null,
        };
      }),
      unlabeled: Number(unlabeled?.n ?? 0),
    };
  });
}

export interface FollowUpActivity {
  // Follow-up steps that reached the customer (a message or a template) in the window.
  stepsSent: number;
  // Conversations that received at least one of those steps.
  conversations: number;
  // Of those, the ones whose customer wrote again after a step reached them.
  cameBack: number;
  // Of those, the ones the last step closed (resolved by the follow-up's abandonment close).
  closedByLastStep: number;
}

// The follow-up's own outcome line (`markFollowUp`, stage generate, trigger followup) is the source:
// one line per step, with the outcome that says whether the customer received it.
export async function getFollowUpActivity(
  ctx: TenantContext,
  filter: DashboardFilter,
  base: PrismaClient = basePrisma,
): Promise<FollowUpActivity> {
  return runScopedOn(base, ctx, async (db) => {
    const [row] = await db.$queryRaw<
      {
        steps: number;
        conversations: number;
        came_back: number;
        closed: number;
      }[]
    >(Prisma.sql`
      WITH steps AS (
        SELECT l.conversation_id, l.created_at
          FROM execution_logs l
         WHERE ${logWhereSql("l", filter)}
           AND l.stage = 'generate'
           AND l.detail->>'trigger' = 'followup'
           AND l.detail->>'outcome' IN ('messaged', 'templated')
           AND l.conversation_id IS NOT NULL
      ), firsts AS (
        SELECT conversation_id, MIN(created_at) AS first_at FROM steps GROUP BY 1
      )
      SELECT (SELECT COUNT(*) FROM steps)::int AS steps,
             COUNT(*)::int AS conversations,
             COUNT(*) FILTER (WHERE c.last_inbound_at > f.first_at)::int AS came_back,
             COUNT(*) FILTER (WHERE c.status = 'resolved' AND c.resolved_by = 'followup_abandonment')::int AS closed
        FROM firsts f
        JOIN conversations c ON c.id = f.conversation_id`);
    return {
      stepsSent: Number(row?.steps ?? 0),
      conversations: Number(row?.conversations ?? 0),
      cameBack: Number(row?.came_back ?? 0),
      closedByLastStep: Number(row?.closed ?? 0),
    };
  });
}

export interface KnowledgeActivity {
  // Suggestions the agents proposed in the window, and where each stands now.
  proposed: number;
  // Waiting for a person (pending, edited, or still being screened by the reviewer model).
  waiting: number;
  // Set aside by the reviewer model as a duplicate or not worth a person's time.
  discarded: number;
  approved: number;
  rejected: number;
}

export async function getKnowledgeActivity(
  ctx: TenantContext,
  filter: DashboardFilter,
  base: PrismaClient = basePrisma,
): Promise<KnowledgeActivity> {
  return runScopedOn(base, ctx, async (db) => {
    const since = filter.since ?? null;
    const until = filter.until ?? null;
    const agent = filter.agentId ?? null;
    const inbox = filter.inboxId ?? null;
    // A suggestion's inbox is its conversation's, reached through the thread it was proposed in.
    // Under an inbox filter, one with no conversation (proposed outside any inbox) is not that
    // inbox's.
    const rows = await db.$queryRaw<{ status: string; n: number }[]>(Prisma.sql`
      SELECT q.status::text AS status, COUNT(*)::int AS n
        FROM approval_queue_items q
       WHERE (${since}::timestamptz IS NULL OR q.created_at >= ${since})
         AND (${until}::timestamptz IS NULL OR q.created_at < ${until})
         AND (${agent}::bigint IS NULL OR q.agent_id = ${agent})
         AND (${inbox}::bigint IS NULL OR EXISTS (
               SELECT 1 FROM conversations c
                WHERE c.thread_id = q.thread_id AND c.inbox_id = ${inbox}))
       GROUP BY 1`);
    const groups = rows.map((r) => ({
      status: r.status,
      _count: { _all: Number(r.n) },
    }));
    const n = (...statuses: string[]) =>
      groups
        .filter((g) => statuses.includes(g.status))
        .reduce((sum, g) => sum + g._count._all, 0);
    return {
      proposed: groups.reduce((sum, g) => sum + g._count._all, 0),
      waiting: n("PENDING", "EDITED", "SCREENING"),
      discarded: n("DISCARDED"),
      approved: n("APPROVED"),
      rejected: n("REJECTED"),
    };
  });
}
