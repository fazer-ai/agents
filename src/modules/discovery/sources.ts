import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { ingestScannedLead, type LeadDto } from "@/modules/merchant/leads";
import {
  fileImportConfigSchema,
  type ImportFormat,
  scanFileImport,
} from "./file-import";
import { normalizeScannedPosts } from "./posts";
import { scanThreadsApi, threadsConfigSchema } from "./threads";
import { scanTiktokComments, tiktokConfigSchema } from "./tiktok";

// Lead sources: the configured rails that scan social platforms and feed the
// merchant lead pipeline. `kind` selects a scanner from SOURCE_KIND_REGISTRY;
// everything after the scan (normalize -> dedupe -> score -> store) is the
// shared path in runLeadSource, so a new kind only ever owns its fetch.
//
// runLeadSource keeps no state between calls beyond LeadSource.lastRun*/lastError
// bookkeeping; dedupe is the lead table's (tenant, platform, external_id) key.

export const LEAD_SOURCE_KINDS = [
  "file_import",
  "threads_api",
  "tiktok_comments",
] as const;
export type LeadSourceKind = (typeof LEAD_SOURCE_KINDS)[number];

interface SourceRow {
  id: bigint;
  tenantId: bigint;
  name: string;
  kind: string;
  config: Prisma.JsonValue;
}

export interface SourceRunOptions {
  // Per-run file_import override: pasted/uploaded content for this run only.
  content?: string;
  format?: ImportFormat;
}

type Scanner = (
  ctx: TenantContext,
  source: SourceRow,
  opts: SourceRunOptions,
  base: PrismaClient,
) => Promise<unknown[]> | unknown[];

interface SourceKindSpec {
  // The write-time gate AND the run-time re-read: config is a Json column, so
  // both ends validate rather than trusting what the other saw.
  configSchema: z.ZodType;
  scan: Scanner;
}

export const SOURCE_KIND_REGISTRY: Record<LeadSourceKind, SourceKindSpec> = {
  file_import: {
    configSchema: fileImportConfigSchema,
    scan: (_ctx, source, opts) => scanFileImport(source, opts),
  },
  threads_api: {
    configSchema: threadsConfigSchema,
    scan: (ctx, source, _opts, base) => scanThreadsApi(ctx, source, base),
  },
  tiktok_comments: {
    configSchema: tiktokConfigSchema,
    scan: (_ctx, source) => scanTiktokComments(source),
  },
};

export function isLeadSourceKind(kind: string): kind is LeadSourceKind {
  return (LEAD_SOURCE_KINDS as readonly string[]).includes(kind);
}

// The write-time kind refusal: unknown values never reach the column, and the
// message names the supported set so a caller can fix the request blind.
function requireLeadSourceKind(kind: string): LeadSourceKind {
  if (isLeadSourceKind(kind)) return kind;
  throw new AppError(
    `unsupported source kind "${kind}" (supported: ${LEAD_SOURCE_KINDS.join(", ")})`,
    422,
    "errors.merchantSourceKindUnsupported",
    { kind, kinds: LEAD_SOURCE_KINDS.join(", ") },
    "kind",
  );
}

export interface LeadSourceDto {
  id: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  intervalMin: number;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  leadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const SOURCE_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  kind: true,
  config: true,
  intervalMin: true,
  enabled: true,
  lastRunAt: true,
  lastStatus: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { leads: true } },
} as const;

type SourceSelectRow = Omit<SourceRow, "config"> & {
  config: Prisma.JsonValue;
  intervalMin: number;
  enabled: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { leads: number };
};

// The stored config projected for the wire: file_import's `content` can carry a
// pasted export of a megabyte+, so on list/write responses it leaves the row as
// a size hint instead. `getLeadSource` returns it in full (`includeContent`)
// because the edit dialog prefills from it.
function configDto(
  config: Prisma.JsonValue,
  includeContent: boolean,
): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {};
  }
  const out: Record<string, unknown> = {
    ...(config as Record<string, unknown>),
  };
  const content = out.content;
  if (!includeContent && typeof content === "string") {
    delete out.content;
    out.contentChars = content.length;
  }
  return out;
}

function toDto(r: SourceSelectRow, includeContent = false): LeadSourceDto {
  return {
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    config: configDto(r.config, includeContent),
    intervalMin: r.intervalMin,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    leadCount: r._count.leads,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// The audit projection shares the elision: a pasted export in the trail is bulk
// with no audit value.
function auditProjection(dto: LeadSourceDto) {
  return {
    name: dto.name,
    kind: dto.kind,
    config: dto.config,
    intervalMin: dto.intervalMin,
    enabled: dto.enabled,
  };
}

export const leadSourceCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.string().min(1).max(60),
    config: z.record(z.string(), z.unknown()).optional(),
    intervalMin: z.number().int().min(1).max(10080).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type LeadSourceCreate = z.infer<typeof leadSourceCreateSchema>;

export const leadSourceUpdateSchema = leadSourceCreateSchema.partial().strict();
export type LeadSourceUpdate = z.infer<typeof leadSourceUpdateSchema>;

export async function listLeadSources(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<LeadSourceDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.leadSource.findMany({
      select: SOURCE_SELECT,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  );
  return rows.map((r) => toDto(r));
}

async function getSourceRowOn(
  db: ScopedDb,
  id: bigint,
): Promise<SourceSelectRow> {
  const row = await db.leadSource.findUnique({
    where: { id },
    select: SOURCE_SELECT,
  });
  if (!row) {
    throw new NotFoundError(
      "source not found",
      "errors.merchantSourceNotFound",
    );
  }
  return row;
}

export async function getLeadSource(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<LeadSourceDto> {
  const row = await runScopedOn(base, ctx, (db) => getSourceRowOn(db, id));
  return toDto(row, true);
}

export async function createLeadSource(
  ctx: TenantContext,
  input: LeadSourceCreate,
  base: PrismaClient = basePrisma,
): Promise<LeadSourceDto> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(leadSourceCreateSchema, input);
  const kind = requireLeadSourceKind(data.kind);
  const spec = SOURCE_KIND_REGISTRY[kind];
  // Config is validated AT the boundary, per kind, so a stored row is always
  // runnable-shaped (what runLeadSource later re-parses).
  const config = parseInput(spec.configSchema, data.config ?? {}, "config");
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.leadSource.create({
      data: {
        tenantId,
        name: data.name,
        kind,
        config: config as Prisma.InputJsonValue,
        intervalMin: data.intervalMin ?? 60,
        enabled: data.enabled ?? true,
      },
      select: SOURCE_SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_source.create",
      target: `lead_source:${dto.id}`,
      after: auditProjection(dto),
    });
    return dto;
  });
}

export async function updateLeadSource(
  ctx: TenantContext,
  id: bigint,
  patch: LeadSourceUpdate,
  base: PrismaClient = basePrisma,
): Promise<LeadSourceDto> {
  const data = parseInput(leadSourceUpdateSchema, patch);
  return runScopedOn(base, ctx, async (db) => {
    const current = await getSourceRowOn(db, id);
    // A kind change re-validates the config against the NEW kind: a config that
    // fit the old kind is not silently kept working under a different scanner.
    const nextKind = data.kind ?? current.kind;
    const kind = requireLeadSourceKind(nextKind);
    const spec = SOURCE_KIND_REGISTRY[kind];
    const config =
      data.config !== undefined || data.kind !== undefined
        ? parseInput(spec.configSchema, data.config ?? {}, "config")
        : undefined;
    const row = await db.leadSource.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.kind !== undefined ? { kind } : {}),
        ...(config !== undefined
          ? { config: config as Prisma.InputJsonValue }
          : {}),
        ...(data.intervalMin !== undefined
          ? { intervalMin: data.intervalMin }
          : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
      select: SOURCE_SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_source.update",
      target: `lead_source:${dto.id}`,
      before: auditProjection(toDto(current)),
      after: auditProjection(dto),
    });
    return dto;
  });
}

export async function deleteLeadSource(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const current = await getSourceRowOn(db, id);
    // Leads keep their rows: Lead.sourceId is SetNull on delete, and the trail
    // records what the source was.
    const res = await db.leadSource.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "source not found",
        "errors.merchantSourceNotFound",
      );
    }
    await auditMutation(db, ctx, {
      action: "merchant_source.delete",
      target: `lead_source:${id}`,
      before: auditProjection(toDto(current)),
    });
  });
}

export interface LeadSourceRunResult {
  scanned: number;
  new: number;
  deduped: number;
  skipped: number;
  leads: string[];
  source: LeadSourceDto;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function errMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The column is a String; cap it so a multi-line stack or a leaked body
  // excerpt does not sit in a UI field.
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}

// One scan of one source, run to completion: scan -> normalize -> dedupe ->
// ingest (score + match). Every outcome writes lastRunAt/lastStatus/lastError,
// failure included - a source whose run failed must not look "never run".
export async function runLeadSource(
  ctx: TenantContext,
  id: bigint,
  opts: SourceRunOptions = {},
  base: PrismaClient = basePrisma,
): Promise<LeadSourceRunResult> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const source = await runScopedOn(base, ctx, async (db) => {
    const row = await db.leadSource.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        name: true,
        kind: true,
        config: true,
        enabled: true,
      },
    });
    if (!row) {
      throw new NotFoundError(
        "source not found",
        "errors.merchantSourceNotFound",
      );
    }
    return row;
  });
  // A disabled source still runs on demand: `enabled` governs the scheduler,
  // and Run-now is exactly how an operator tries a source before enabling it.
  const kind = requireLeadSourceKind(source.kind);
  const spec = SOURCE_KIND_REGISTRY[kind];
  try {
    const raws = await spec.scan(ctx, source, opts, base);
    const { posts, skipped, deduped: batchDupes } = normalizeScannedPosts(raws);
    let created = 0;
    let deduped = batchDupes;
    const leadIds: string[] = [];
    for (const post of posts) {
      try {
        const lead: LeadDto | null = await ingestScannedLead(
          ctx,
          {
            platform: post.platform,
            authorName: post.authorName,
            authorHandle: post.authorHandle,
            text: post.text,
            sourceUrl: post.sourceUrl,
            groupName: post.groupName,
            externalId: post.externalId,
            sourceId: source.id,
          },
          base,
        );
        if (lead === null) {
          deduped++;
        } else {
          created++;
          leadIds.push(lead.id);
        }
      } catch (err) {
        // A post that lost a findUnique race hit the dedupe unique key on
        // insert: it IS deduped, not a failure.
        if (isUniqueViolation(err)) deduped++;
        else throw err;
      }
    }
    const result: LeadSourceRunResult = {
      scanned: raws.length,
      new: created,
      deduped,
      skipped,
      leads: leadIds,
      source: await recordRun(base, ctx, source.id, "ok", null, {
        scanned: raws.length,
        new: created,
        deduped,
        skipped,
      }),
    };
    return result;
  } catch (err) {
    // Bookkeeping is best-effort here: if the failure was the database itself,
    // its write fails too and the caller still gets the scan's error, not the
    // bookkeeping's.
    await recordRun(base, ctx, source.id, "error", errMessage(err), null).catch(
      () => undefined,
    );
    throw err;
  }
}

// The run's bookkeeping row + audit entry, in one transaction. `stats` is null
// when the run failed before producing them (scan threw): the audit record then
// carries just the error.
async function recordRun(
  base: PrismaClient,
  ctx: TenantContext,
  sourceId: bigint,
  status: "ok" | "error",
  error: string | null,
  stats: {
    scanned: number;
    new: number;
    deduped: number;
    skipped: number;
  } | null,
): Promise<LeadSourceDto> {
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.leadSource.update({
      where: { id: sourceId },
      data: {
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: error,
      },
      select: SOURCE_SELECT,
    });
    await auditMutation(db, ctx, {
      action: "merchant_source.run",
      target: `lead_source:${sourceId}`,
      after: { status, error, ...stats },
    });
    return toDto(row);
  });
}
