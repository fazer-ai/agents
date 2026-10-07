import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { assertUsableCount } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Read surface for the execution-flow log (the Logs page). RLS-scoped to the active tenant. KEYSET
// pagination by id desc (the table is high-write; offset pagination degrades): pass the last id
// back as `cursor` for the next page. `source` defaults to "inbox" so the page shows real traffic
// unless the operator asks for playground / all. The rows were already PII-scrubbed at write.

export interface ExecutionLogItem {
  id: string;
  turnId: string;
  conversationId: string | null;
  agentId: string | null;
  inboxId: string | null;
  threadId: string | null;
  stage: string;
  level: string;
  status: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
  source: string;
  detail: unknown;
  errorMessage: string | null;
  createdAt: string;
}

export interface ListLogsOpts {
  since?: Date;
  until?: Date;
  level?: string;
  stage?: string;
  agentId?: bigint;
  inboxId?: bigint;
  conversationId?: bigint;
  turnId?: string;
  // A tool line's `detail.tool`, which is how the dashboard's health block opens one tool's failures.
  tool?: string;
  // Only lines that name no tool (`detail.tool` absent): the health block's group of tool warnings
  // written before any tool was known (an MCP server that could not be listed).
  noTool?: boolean;
  // undefined → "inbox" (real traffic); "all" → no source filter; else exact match.
  source?: string;
  // Case-insensitive substring match on errorMessage.
  search?: string;
  limit?: number;
  // Keyset: return rows with id < cursor.
  cursor?: bigint;
}

export interface ListLogsResult {
  items: ExecutionLogItem[];
  // Pass back as `cursor` to fetch the next (older) page; null when no more rows.
  nextCursor: string | null;
}

// Shared column projection + row shaping, reused by the paginated list (this file) and the bulk
// export (`./export.ts`) so both surfaces select and map the exact same fields.
export const LOG_SELECT = {
  id: true,
  turnId: true,
  conversationId: true,
  agentId: true,
  inboxId: true,
  threadId: true,
  stage: true,
  level: true,
  status: true,
  provider: true,
  model: true,
  durationMs: true,
  source: true,
  detail: true,
  errorMessage: true,
  createdAt: true,
} as const;

export type ExecutionLogRow = Prisma.ExecutionLogGetPayload<{
  select: typeof LOG_SELECT;
}>;

// Builds the RLS-independent filter for a log query. Shared by `listExecutionLogs` (which adds
// keyset pagination via `cursor`) and the export (which ignores `cursor`/`limit`).
export function buildLogWhere(
  opts: ListLogsOpts,
  // Under an inbox filter: the conversations of that inbox that have lines naming no inbox
  // (`inboxLogConversations`), whose lines are that inbox's too.
  inboxConversations: bigint[] = [],
): Prisma.ExecutionLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (opts.since) createdAt.gte = opts.since;
  if (opts.until) createdAt.lte = opts.until;
  return {
    ...(opts.since || opts.until ? { createdAt } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.stage ? { stage: opts.stage } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    ...(opts.inboxId !== undefined
      ? {
          OR: [
            { inboxId: opts.inboxId },
            ...(inboxConversations.length > 0
              ? [
                  {
                    inboxId: null,
                    conversationId: { in: inboxConversations },
                  },
                ]
              : []),
          ],
        }
      : {}),
    ...(opts.tool ? { detail: { path: ["tool"], equals: opts.tool } } : {}),
    ...(opts.noTool && !opts.tool
      ? { detail: { path: ["tool"], equals: Prisma.AnyNull } }
      : {}),
    ...(opts.conversationId !== undefined
      ? { conversationId: opts.conversationId }
      : {}),
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    // source: default to real traffic; "all" lifts the filter entirely.
    ...(opts.source === "all" ? {} : { source: opts.source ?? "inbox" }),
    ...(opts.search
      ? { errorMessage: { contains: opts.search, mode: "insensitive" } }
      : {}),
    ...(opts.cursor !== undefined ? { id: { lt: opts.cursor } } : {}),
  };
}

export function mapExecutionLogRow(r: ExecutionLogRow): ExecutionLogItem {
  return {
    id: String(r.id),
    turnId: r.turnId,
    conversationId: r.conversationId === null ? null : String(r.conversationId),
    agentId: r.agentId === null ? null : String(r.agentId),
    inboxId: r.inboxId === null ? null : String(r.inboxId),
    threadId: r.threadId,
    stage: r.stage,
    level: r.level,
    status: r.status,
    provider: r.provider,
    model: r.model,
    durationMs: r.durationMs,
    source: r.source,
    detail: r.detail,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
  };
}

// A line written before its inbox was known (a person taking over is logged from the webhook) names
// only its conversation. Under an inbox filter it is still that inbox's line, so the reader resolves,
// within the window, which of the inbox's conversations carry such lines. The dashboard counts them
// by the same rule (`logWhereSql`), so its figure and the page it links to agree.
export async function inboxLogConversations(
  db: Prisma.TransactionClient,
  opts: ListLogsOpts,
): Promise<bigint[]> {
  if (opts.inboxId === undefined) return [];
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const rows = await db.$queryRaw<{ id: bigint }[]>(Prisma.sql`
    SELECT DISTINCT l.conversation_id AS id
      FROM execution_logs l
      JOIN conversations c ON c.id = l.conversation_id
     WHERE l.inbox_id IS NULL
       AND c.inbox_id = ${opts.inboxId}
       AND (${since}::timestamptz IS NULL OR l.created_at >= ${since})
       AND (${until}::timestamptz IS NULL OR l.created_at <= ${until})`);
  return rows.map((r) => r.id);
}

export async function listExecutionLogs(
  ctx: TenantContext,
  opts: ListLogsOpts = {},
  base: PrismaClient = basePrisma,
): Promise<ListLogsResult> {
  assertUsableCount(opts.limit, "limit");
  const take = Math.min(opts.limit ?? 50, 200);
  const rows = await runScopedOn(base, ctx, async (db) =>
    db.executionLog.findMany({
      where: buildLogWhere(opts, await inboxLogConversations(db, opts)),
      orderBy: { id: "desc" },
      take: take + 1, // one extra row tells us whether a next page exists
      select: LOG_SELECT,
    }),
  );
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(mapExecutionLogRow),
    nextCursor: hasMore ? String(page[page.length - 1]?.id) : null,
  };
}
