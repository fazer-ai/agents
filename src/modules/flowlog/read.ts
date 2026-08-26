import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
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
  conversationId?: bigint;
  turnId?: string;
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
): Prisma.ExecutionLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (opts.since) createdAt.gte = opts.since;
  if (opts.until) createdAt.lte = opts.until;
  return {
    ...(opts.since || opts.until ? { createdAt } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.stage ? { stage: opts.stage } : {}),
    ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
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

export async function listExecutionLogs(
  ctx: TenantContext,
  opts: ListLogsOpts = {},
  base: PrismaClient = basePrisma,
): Promise<ListLogsResult> {
  assertUsableCount(opts.limit, "limit");
  const take = Math.min(opts.limit ?? 50, 200);
  const where = buildLogWhere(opts);
  const rows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where,
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
