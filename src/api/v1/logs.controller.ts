import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  exportExecutionLogs,
  type LogExportFormat,
} from "@/modules/flowlog/export";
import { listExecutionLogs } from "@/modules/flowlog/read";

// Execution-flow log read surface (the Logs page). TENANT_ADMIN; RLS-scoped. Keyset pagination by
// id desc (pass `cursor` back for the next page). `source` defaults to "inbox" (real traffic);
// pass source=all|playground to widen. SUPER_ADMIN picks the tenant via the X-Tenant-Id header
// (resolved by tenancyPlugin → ctxOrThrow demands a concrete tenant).

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

function parseDate(s?: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseBigInt(s?: string): bigint | undefined {
  if (!s) return undefined;
  try {
    return BigInt(s);
  } catch {
    return undefined;
  }
}

function parseFormat(s?: string): LogExportFormat {
  return s === "json" ? "json" : "csv";
}

export const logsController = new Elysia({
  prefix: "/v1/logs",
  tags: ["Logs"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      ...(await listExecutionLogs(ctxOrThrow(tenantContext), {
        since: parseDate(query.since),
        until: parseDate(query.until),
        level: query.level,
        stage: query.stage,
        agentId: parseBigInt(query.agentId),
        conversationId: parseBigInt(query.conversationId),
        turnId: query.turnId,
        source: query.source,
        search: query.search,
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: parseBigInt(query.cursor),
      })),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        since: t.Optional(
          t.String({ description: "Lower bound on log time (ISO date)." }),
        ),
        until: t.Optional(
          t.String({ description: "Upper bound on log time (ISO date)." }),
        ),
        level: t.Optional(t.String({ description: "Filter by log level." })),
        stage: t.Optional(
          t.String({ description: "Filter by execution stage." }),
        ),
        agentId: t.Optional(
          t.String({ description: "Filter by agent id (BigInt string)." }),
        ),
        conversationId: t.Optional(
          t.String({
            description: "Filter by conversation id (BigInt string).",
          }),
        ),
        turnId: t.Optional(
          t.String({ description: "Filter by turn id (one id per turn)." }),
        ),
        source: t.Optional(
          t.String({
            description:
              'Traffic segment: "inbox" (default), "all", or "playground".',
          }),
        ),
        search: t.Optional(
          t.String({ description: "Free-text search over log detail." }),
        ),
        limit: t.Optional(
          t.String({
            description: "Max rows to return (positive integer string).",
          }),
        ),
        cursor: t.Optional(
          t.String({
            description:
              "Keyset cursor (id of the last row from the previous page).",
          }),
        ),
      }),
      detail: doc(
        "List execution logs",
        "Lists tenant-scoped execution-flow logs with keyset pagination.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  // Bulk export of the (filtered) execution-flow log as a downloadable file. Same filter surface as
  // the list endpoint (minus pagination); `format` picks CSV or JSON, `maxRows` bounds the dump. The
  // serialized file rides back in `content` (the client turns it into a Blob) alongside `filename` /
  // `contentType` and a `truncated` flag when more rows matched than the cap returned.
  .get(
    "/export",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      ...(await exportExecutionLogs(ctxOrThrow(tenantContext), {
        since: parseDate(query.since),
        until: parseDate(query.until),
        level: query.level,
        stage: query.stage,
        agentId: parseBigInt(query.agentId),
        conversationId: parseBigInt(query.conversationId),
        turnId: query.turnId,
        source: query.source,
        search: query.search,
        format: parseFormat(query.format),
        maxRows: query.maxRows ? Number(query.maxRows) : undefined,
      })),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        since: t.Optional(
          t.String({ description: "Lower bound on log time (ISO date)." }),
        ),
        until: t.Optional(
          t.String({ description: "Upper bound on log time (ISO date)." }),
        ),
        level: t.Optional(t.String({ description: "Filter by log level." })),
        stage: t.Optional(
          t.String({ description: "Filter by execution stage." }),
        ),
        agentId: t.Optional(
          t.String({ description: "Filter by agent id (BigInt string)." }),
        ),
        conversationId: t.Optional(
          t.String({
            description: "Filter by conversation id (BigInt string).",
          }),
        ),
        turnId: t.Optional(
          t.String({ description: "Filter by turn id (one id per turn)." }),
        ),
        source: t.Optional(
          t.String({
            description:
              'Traffic segment: "inbox" (default), "all", or "playground".',
          }),
        ),
        search: t.Optional(
          t.String({ description: "Free-text search over log detail." }),
        ),
        format: t.Optional(
          t.String({
            description: 'Export format: "csv" (default) or "json".',
          }),
        ),
        maxRows: t.Optional(
          t.String({
            description:
              "Max rows to export (positive integer string, clamped to the hard cap).",
          }),
        ),
      }),
      detail: doc(
        "Export execution logs",
        "Exports the tenant-scoped execution-flow logs (matching the given filters) as a CSV or JSON file, newest first, up to a bounded row cap.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
