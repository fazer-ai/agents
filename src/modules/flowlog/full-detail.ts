import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { NotFoundError } from "@/lib/errors";
import { scrubbedClip } from "@/lib/redact";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { readRetentionDays } from "./settings";

// A turn's full detail, kept per agent for `observability.fullDetailRetentionDays` (docs/logs.md
// "Full turn detail"). The log line keeps its `detail` cut at MAX_STRING; the whole text of each tool
// result and of the audited prompt is written here once per distinct text, and read back by the
// conversation page. Only the SIZE axis: a tool result is captured only on a line that already logs
// values, secrets are redacted as on every log line, and nothing here reaches Langfuse.

export type FullDetailKind = "tool_output" | "system_prompt";

export interface FullDetailCapture {
  kind: FullDetailKind;
  text: string;
}

// A ceiling, so one runaway result cannot write megabytes per call: ten times a 50k-character
// catalog page, and past it the text is cut with the log's own marker.
export const FULL_DETAIL_MAX_CHARS = 500_000;

// The key the log line carries when its full text is kept: the instant it expires. It tells "never
// kept" from "kept, and expired" once the text itself is swept, with no second table.
export const KEPT_UNTIL_KEY = "fullDetailKeptUntil";

// What is stored: secrets redacted (the same patterns as every log line), characters Postgres refuses
// repaired, and the length capped.
export function storableFullText(text: string): string {
  return scrubbedClip(text, FULL_DETAIL_MAX_CHARS);
}

// When a line written now stops being kept. Never past the log line's own retention, since past it
// nothing can reach the text. Rounded UP to the hour, so a text fetched by many turns moves its
// content row's expiry at most once an hour instead of on every write.
export function fullDetailExpiry(days: number, now: Date = new Date()): Date {
  const effective = Math.min(days, config.flowlog.retentionDays);
  const at = now.getTime() + effective * 86_400_000;
  return new Date(Math.ceil(at / 3_600_000) * 3_600_000);
}

export function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

// Writes one line's full text. The content row is shared: a text already stored keeps its row, and
// only its expiry moves, forward, to the latest line that points to it. So a content row never
// expires before a pointer to it, and both tables are swept by `expires_at` alone.
export async function storeFullDetail(
  db: ScopedDb,
  args: {
    tenantId: bigint;
    executionLogId: bigint;
    agentId: bigint | null;
    capture: FullDetailCapture;
    expiresAt: Date;
  },
): Promise<void> {
  const body = storableFullText(args.capture.text);
  const hash = contentHash(body);
  await db.$executeRaw`
    INSERT INTO full_detail_contents (tenant_id, hash, body, chars, expires_at)
    VALUES (${args.tenantId}, ${hash}, ${body}, ${body.length}, ${args.expiresAt})
    ON CONFLICT (tenant_id, hash) DO UPDATE SET expires_at = EXCLUDED.expires_at
     WHERE full_detail_contents.expires_at < EXCLUDED.expires_at`;
  await db.fullDetailRef.create({
    data: {
      tenantId: args.tenantId,
      executionLogId: args.executionLogId,
      agentId: args.agentId,
      kind: args.capture.kind,
      contentHash: hash,
      expiresAt: args.expiresAt,
    },
  });
}

// The kept texts of these log lines that have not expired, by line id. A line with no entry kept
// nothing, or kept something that is gone: its own `fullDetailKeptUntil` says which.
export async function readFullDetails(
  db: ScopedDb,
  executionLogIds: bigint[],
  now: Date = new Date(),
): Promise<Map<string, { kind: FullDetailKind; text: string }>> {
  const out = new Map<string, { kind: FullDetailKind; text: string }>();
  if (executionLogIds.length === 0) return out;
  const rows = await db.$queryRaw<
    { execution_log_id: bigint; kind: string; body: string }[]
  >`
    SELECT r.execution_log_id, r.kind, c.body
      FROM full_detail_refs r
      JOIN full_detail_contents c
        ON c.tenant_id = r.tenant_id AND c.hash = r.content_hash
     WHERE r.execution_log_id = ANY(${executionLogIds})
       AND r.expires_at > ${now}`;
  for (const r of rows) {
    out.set(String(r.execution_log_id), {
      kind: r.kind as FullDetailKind,
      text: r.body,
    });
  }
  return out;
}

export type FullOutputStatus = "kept" | "gone" | "not_kept";

// What the reader says about a line's full text, from the line's own marker and whether the text was
// found: `kept` (served whole), `gone` (it was kept until a moment that has passed, or its write did
// not land), `not_kept` (this line never asked for it).
export function fullOutputStatus(
  detail: Record<string, unknown> | null,
  found: boolean,
): FullOutputStatus {
  if (found) return "kept";
  return typeof detail?.[KEPT_UNTIL_KEY] === "string" ? "gone" : "not_kept";
}

export interface FullDetailUsage {
  // Log lines of this agent whose full text is still kept.
  lines: number;
  // The bytes the distinct texts those lines point to take on disk (compressed, as Postgres stores
  // them). A text shared with another agent counts for both.
  bytes: number;
}

// What one agent's kept detail costs right now, for the editor. One index range over the agent's
// pointers, and each distinct text measured once.
export async function fullDetailUsage(
  db: ScopedDb,
  agentId: bigint,
  now: Date = new Date(),
): Promise<FullDetailUsage> {
  const [row] = await db.$queryRaw<{ lines: bigint; bytes: bigint | null }[]>(
    Prisma.sql`
      WITH refs AS (
        SELECT content_hash FROM full_detail_refs
         WHERE agent_id = ${agentId} AND expires_at > ${now}
      )
      SELECT (SELECT count(*) FROM refs) AS lines,
             (SELECT sum(pg_column_size(c.body))::bigint
                FROM full_detail_contents c
               WHERE c.hash IN (SELECT DISTINCT content_hash FROM refs)) AS bytes`,
  );
  return { lines: Number(row?.lines ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export interface AgentFullDetailUsage extends FullDetailUsage {
  // What the agent is configured to keep (null = off), and the days a line written now is actually
  // kept: the same number, capped by FLOWLOG_RETENTION_DAYS.
  retentionDays: number | null;
  effectiveDays: number | null;
  // FLOWLOG_RETENTION_DAYS, the cap, so the editor can name it.
  logRetentionDays: number;
}

// The editor's and the API's reading of one agent: its setting and what it is using. 404 for an id
// that is not an agent of this tenant, rather than a confident zero.
export async function readAgentFullDetailUsage(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<AgentFullDetailUsage> {
  return runScopedOn(base, ctx, async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { settings: true },
    });
    if (!agent) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    // The one key, through its own reader: the block's whole reader belongs to the turn and the
    // settings DTO, and this answers a narrower question about the saved row.
    const bag = agent.settings as {
      observability?: { fullDetailRetentionDays?: unknown };
    } | null;
    const days = readRetentionDays(bag?.observability?.fullDetailRetentionDays);
    return {
      retentionDays: days,
      effectiveDays:
        days === null ? null : Math.min(days, config.flowlog.retentionDays),
      logRetentionDays: config.flowlog.retentionDays,
      ...(await fullDetailUsage(db, agentId)),
    };
  });
}
