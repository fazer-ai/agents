import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, type TenantContext } from "@/lib/tenancy";
import { redactEndpoint } from "@/modules/audit/projection";
import { auditMutationOn, projectionMoved } from "@/modules/audit/service";
import {
  type AlertSendDeps,
  INSTANCE_CAUSE_PREFIX,
  sendAlert,
} from "@/modules/flowlog/alert-send";
import { invalidateThresholds } from "./evaluator";
import { isSignalKey, SIGNALS, signalDef } from "./signals";

// The instance's alert channels and thresholds (docs/logs.md, instance alerts). Same shape as a
// tenant's channel (Discord or webhook, URL encrypted and only ever shown masked), with no tenant:
// every read and write runs as the fleet role, the only role the tables' policy admits, and the
// audit row goes to the fleet's trail. Callers are SUPER_ADMIN by the transport's own check.
//
// NOTE: the AppError translationKeys thrown here are registered for the i18n extractor via
// translate() magic comments in src/api/features/admin/instance-health.controller.ts.

const CHANNEL_TYPES = ["discord", "webhook"] as const;

export interface InstanceAlertChannelDto {
  id: string;
  name: string;
  type: string;
  // Null while the channel waits for its URL (created over MCP, filled in the console): it cannot be
  // enabled, tested or delivered to until then.
  urlMasked: string | null;
  enabled: boolean;
  // Signals this channel alerts on; empty means all.
  signals: string[];
  // Whether an HMAC signing secret is stored. The value is write-only.
  hasSecret: boolean;
  // Set when this channel's newest finished delivery was given up on: the alert that never arrived,
  // and why. The bus cannot page about its own failure, so the console is where it shows.
  failing: { at: Date; error: string | null; signal: string } | null;
  // Set when the newest finished delivery went out unsigned although a secret is stored: why. The
  // list says this instead of "Signed", since a verifying receiver drops those deliveries.
  unsignedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  type: true,
  url: true,
  enabled: true,
  signals: true,
  secret: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = {
  id: bigint;
  name: string;
  type: string;
  url: string | null;
  enabled: boolean;
  signals: string[];
  secret: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function maskUrl(encrypted: string): string;
function maskUrl(encrypted: string | null): string | null;
function maskUrl(encrypted: string | null): string | null {
  if (encrypted === null) return null;
  try {
    return redactEndpoint(decryptJson<string>(encrypted));
  } catch {
    return "…";
  }
}

type Outcome = {
  failing: InstanceAlertChannelDto["failing"];
  unsignedReason: string | null;
};

function toDto(
  row: Row,
  outcome: Outcome = { failing: null, unsignedReason: null },
): InstanceAlertChannelDto {
  return {
    id: row.id.toString(),
    name: row.name,
    type: row.type,
    urlMasked: maskUrl(row.url),
    enabled: row.enabled,
    signals: row.signals,
    hasSecret: row.secret !== null,
    failing: outcome.failing,
    unsignedReason: row.secret === null ? null : outcome.unsignedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function auditProjection(row: Row) {
  return {
    name: row.name,
    type: row.type,
    urlMasked: maskUrl(row.url),
    enabled: row.enabled,
    signals: row.signals,
    hasSecret: row.secret !== null,
  };
}

function urlMoved(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return before !== after;
  try {
    return decryptJson<string>(before) !== decryptJson<string>(after);
  } catch {
    return true;
  }
}

function assertSignals(signals: string[]): string[] {
  const out: string[] = [];
  for (const s of signals) {
    if (!isSignalKey(s)) {
      throw new AppError(
        `unknown signal: ${s}`,
        400,
        "errors.unknownInstanceSignal",
        { signal: s },
      );
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function needsUrl(): AppError {
  return new AppError(
    "this channel has no URL yet: set it in the console before enabling or testing it",
    400,
    "errors.instanceChannelNeedsUrl",
  );
}

// A channel with no URL yet (created over MCP, waiting for the console) cannot be on. Shared by the
// update and the MCP preview of it, so a preview never approves what the apply refuses.
export function assertEnableHasUrl(enabled: boolean, hasUrl: boolean): void {
  if (enabled && !hasUrl) throw needsUrl();
}

function notFound(): NotFoundError {
  return new NotFoundError(
    "alert channel not found",
    "errors.alertChannelNotFound",
  );
}

export async function listInstanceAlertChannels(
  base: PrismaClient = basePrisma,
): Promise<InstanceAlertChannelDto[]> {
  return asSuperAdminOn(base, async (db) => {
    const rows = await db.instanceAlertChannel.findMany({
      select: SELECT,
      orderBy: { id: "asc" },
    });
    const last = await db.$queryRaw<
      {
        channel_id: bigint;
        status: string;
        at: Date;
        error: string | null;
        signal: string;
        unsigned_reason: string | null;
      }[]
    >`
      SELECT DISTINCT ON (channel_id) channel_id, status::text AS status, updated_at AS at,
             last_error AS error, signal, unsigned_reason
        FROM instance_alert_deliveries
       WHERE status IN ('DELIVERED', 'DEAD')
       ORDER BY channel_id, updated_at DESC, id DESC`;
    const outcomes = new Map(
      last.map((l) => [
        String(l.channel_id),
        {
          failing:
            l.status === "DEAD"
              ? { at: l.at, error: l.error, signal: l.signal }
              : null,
          unsignedReason: l.unsigned_reason,
        },
      ]),
    );
    return rows.map((r) => toDto(r, outcomes.get(String(r.id))));
  });
}

export const instanceAlertChannelCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(CHANNEL_TYPES),
    url: z.string().min(1).max(2048),
    signals: z.array(z.string()).max(SIGNALS.length).optional(),
    secret: z.string().min(1).max(256).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type InstanceAlertChannelCreate = z.infer<
  typeof instanceAlertChannelCreateSchema
>;

export async function createInstanceAlertChannel(
  ctx: TenantContext,
  input: InstanceAlertChannelCreate,
  base: PrismaClient = basePrisma,
): Promise<InstanceAlertChannelDto> {
  const parsed = parseInput(instanceAlertChannelCreateSchema, input);
  await assertSafeOutboundUrl(parsed.url);
  const signals = assertSignals(parsed.signals ?? []);
  const row = await asSuperAdminOn(base, async (db) => {
    const created = await db.instanceAlertChannel.create({
      data: {
        name: parsed.name,
        type: parsed.type,
        url: encryptJson(parsed.url),
        signals,
        secret: parsed.secret ? encryptJson(parsed.secret) : null,
        enabled: parsed.enabled ?? true,
      },
      select: SELECT,
    });
    await auditMutationOn(db, ctx, null, {
      action: "instance_alert_channel.create",
      target: `instance_alert_channel:${created.id}`,
      after: auditProjection(created),
    });
    return created;
  });
  return toDto(row);
}

export const instanceAlertChannelPendingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(CHANNEL_TYPES),
    signals: z.array(z.string()).max(SIGNALS.length).optional(),
  })
  .strict();

export type InstanceAlertChannelPending = z.infer<
  typeof instanceAlertChannelPendingSchema
>;

// The checks a pending create makes, shared with the MCP preview.
export function checkInstanceAlertChannelPending(
  input: InstanceAlertChannelPending,
): InstanceAlertChannelPending {
  const parsed = parseInput(instanceAlertChannelPendingSchema, input);
  return { ...parsed, signals: assertSignals(parsed.signals ?? []) };
}

// A channel with no URL yet, disabled, for a caller that must not carry the URL or the signing
// secret (an MCP argument travels through the model's transcript): the operator fills both in the
// console from the link the tool hands back, the vault's fill pattern.
export async function createPendingInstanceAlertChannel(
  ctx: TenantContext,
  input: InstanceAlertChannelPending,
  base: PrismaClient = basePrisma,
): Promise<InstanceAlertChannelDto> {
  const parsed = checkInstanceAlertChannelPending(input);
  const row = await asSuperAdminOn(base, async (db) => {
    const created = await db.instanceAlertChannel.create({
      data: {
        name: parsed.name,
        type: parsed.type,
        url: null,
        signals: parsed.signals ?? [],
        secret: null,
        enabled: false,
      },
      select: SELECT,
    });
    await auditMutationOn(db, ctx, null, {
      action: "instance_alert_channel.create",
      target: `instance_alert_channel:${created.id}`,
      after: auditProjection(created),
    });
    return created;
  });
  return toDto(row);
}

export const instanceAlertChannelUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    type: z.enum(CHANNEL_TYPES).optional(),
    url: z.string().min(1).max(2048).optional(),
    signals: z.array(z.string()).max(SIGNALS.length).optional(),
    // undefined = leave; null = clear; string = replace.
    secret: z.string().min(1).max(256).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type InstanceAlertChannelUpdate = z.infer<
  typeof instanceAlertChannelUpdateSchema
>;

// The checks an update makes before it touches the row, in one place so the MCP preview asks the same
// ones: the shape, the signal names (normalized), and that something is being changed.
export function checkInstanceAlertChannelUpdate(
  patch: InstanceAlertChannelUpdate,
): InstanceAlertChannelUpdate {
  const parsed = parseInput(instanceAlertChannelUpdateSchema, patch);
  if (parsed.signals !== undefined) {
    parsed.signals = assertSignals(parsed.signals);
  }
  if (Object.values(parsed).every((v) => v === undefined)) {
    throw new AppError(
      "no updatable fields provided",
      400,
      "errors.noUpdatableFields",
    );
  }
  return parsed;
}

export async function updateInstanceAlertChannel(
  ctx: TenantContext,
  id: bigint,
  patch: InstanceAlertChannelUpdate,
  base: PrismaClient = basePrisma,
): Promise<InstanceAlertChannelDto> {
  const parsed = checkInstanceAlertChannelUpdate(patch);
  const data: Record<string, unknown> = {};
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.type !== undefined) data.type = parsed.type;
  if (parsed.url !== undefined) {
    await assertSafeOutboundUrl(parsed.url);
    data.url = encryptJson(parsed.url);
  }
  if (parsed.signals !== undefined) data.signals = parsed.signals;
  if (parsed.secret !== undefined) {
    data.secret = parsed.secret === null ? null : encryptJson(parsed.secret);
  }
  if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
  const row = await asSuperAdminOn(base, async (db) => {
    const before = await db.instanceAlertChannel.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!before) throw notFound();
    assertEnableHasUrl(
      parsed.enabled ?? before.enabled,
      (data.url ?? before.url) !== null,
    );
    const after = await db.instanceAlertChannel.update({
      where: { id },
      data,
      select: SELECT,
    });
    const moved = urlMoved(before.url, after.url);
    const secretMoved = parsed.secret !== undefined;
    // Why an earlier delivery went out unsigned was about the secret it read: a new one (or none)
    // makes that reason stale, and the channel stops saying so until a delivery reports again. Raw,
    // so `updated_at` stays: it orders the outcomes the console reads, and Prisma's @updatedAt would
    // make the cleared row look newest.
    if (secretMoved) {
      await db.$executeRaw`
        UPDATE instance_alert_deliveries SET unsigned_reason = NULL
         WHERE channel_id = ${id} AND unsigned_reason IS NOT NULL`;
    }
    if (
      moved ||
      secretMoved ||
      projectionMoved(auditProjection(before), auditProjection(after))
    ) {
      await auditMutationOn(db, ctx, null, {
        action: "instance_alert_channel.update",
        target: `instance_alert_channel:${id}`,
        before: auditProjection(before),
        after: {
          ...auditProjection(after),
          urlChanged: moved,
          secretChanged: secretMoved,
        },
      });
    }
    return after;
  });
  return toDto(row);
}

export async function deleteInstanceAlertChannel(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await asSuperAdminOn(base, async (db) => {
    const before = await db.instanceAlertChannel.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!before) throw notFound();
    await db.instanceAlertChannel.delete({ where: { id } });
    await auditMutationOn(db, ctx, null, {
      action: "instance_alert_channel.delete",
      target: `instance_alert_channel:${id}`,
      before: auditProjection(before),
    });
  });
}

// The stored secret, decrypted only here and only for the send. A blob that will not decrypt sends
// unsigned with the reason, like a tenant channel whose vault entry is gone.
export function instanceSecretResolver(
  type: string,
  secret: string | null,
): AlertSendDeps["resolveSecret"] {
  return async () => {
    if (type !== "webhook" || secret === null) {
      return { secret: null, unsignedReason: null };
    }
    try {
      return { secret: decryptJson<string>(secret), unsignedReason: null };
    } catch {
      return {
        secret: null,
        unsignedReason:
          "The signing secret stored on this channel cannot be read; set it again.",
      };
    }
  };
}

export interface InstanceAlertChannelTestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  signed: boolean;
  enabled: boolean;
  durationMs: number | null;
  warning: string | null;
}

const TEST_SUMMARY =
  "Test alert from fazer.ai agents (instance health). If you can read this, the channel is wired correctly.";

// A probe through the same `sendAlert` the worker uses, leaving no delivery row behind.
export async function sendInstanceAlertChannelTest(
  id: bigint,
  base: PrismaClient = basePrisma,
  deps: AlertSendDeps = {},
): Promise<InstanceAlertChannelTestResult> {
  const channel = await asSuperAdminOn(base, (db) =>
    db.instanceAlertChannel.findUnique({
      where: { id },
      select: { type: true, url: true, secret: true, enabled: true },
    }),
  );
  if (!channel) throw notFound();
  if (channel.url === null) throw needsUrl();
  const res = await sendAlert(
    base,
    null,
    {
      deliveryId: "test",
      type: channel.type,
      url: channel.url,
      secretRef: null,
      stage: "test",
      level: "info",
      summary: TEST_SUMMARY,
      count: 1,
      tenantId: null,
      turnId: null,
      conversationId: null,
      causeKey: `${INSTANCE_CAUSE_PREFIX}test`,
    },
    {
      ...deps,
      resolveSecret: instanceSecretResolver(channel.type, channel.secret),
    },
  );
  return {
    ok: res.ok,
    status: res.status,
    error: res.error,
    signed: res.signed,
    enabled: channel.enabled,
    durationMs: res.durationMs,
    warning: res.unsignedReason,
  };
}

// ── thresholds ──

export interface InstanceThresholdDto {
  signal: string;
  unit: string;
  threshold: number;
  durationSeconds: number;
  enabled: boolean;
  // Whether the values above are the shipped defaults (no override stored).
  isDefault: boolean;
  defaultThreshold: number;
  defaultDurationSeconds: number;
  defaultEnabled: boolean;
}

export async function listInstanceThresholds(
  base: PrismaClient = basePrisma,
): Promise<InstanceThresholdDto[]> {
  const rows = await asSuperAdminOn(base, (db) =>
    db.instanceAlertThreshold.findMany(),
  );
  const byKey = new Map(rows.map((r) => [r.signal, r]));
  return SIGNALS.map((s) => {
    const r = byKey.get(s.name);
    return {
      signal: s.name,
      unit: s.unit,
      threshold: r?.threshold ?? s.defaultThreshold,
      durationSeconds: r?.durationSeconds ?? s.defaultDurationSeconds,
      enabled: r?.enabled ?? s.defaultEnabled ?? true,
      isDefault: r === undefined,
      defaultThreshold: s.defaultThreshold,
      defaultDurationSeconds: s.defaultDurationSeconds,
      defaultEnabled: s.defaultEnabled ?? true,
    };
  });
}

export const instanceThresholdSetSchema = z
  .object({
    threshold: z.number().finite().min(0).max(86_400_000),
    durationSeconds: z.number().int().min(0).max(3600),
    enabled: z.boolean().optional(),
  })
  .strict();

export type InstanceThresholdSet = z.infer<typeof instanceThresholdSetSchema>;

// The threshold write's checks, shared with the MCP preview.
export function checkInstanceThreshold(
  signal: string,
  input: InstanceThresholdSet,
): InstanceThresholdSet {
  assertSignals([signal]);
  return parseInput(instanceThresholdSetSchema, input);
}

export async function setInstanceThreshold(
  ctx: TenantContext,
  signal: string,
  input: InstanceThresholdSet,
  base: PrismaClient = basePrisma,
): Promise<InstanceThresholdDto> {
  const parsed = checkInstanceThreshold(signal, input);
  await asSuperAdminOn(base, async (db) => {
    const before = await db.instanceAlertThreshold.findUnique({
      where: { signal },
    });
    const data = {
      threshold: parsed.threshold,
      durationSeconds: parsed.durationSeconds,
      enabled:
        parsed.enabled ??
        before?.enabled ??
        signalDef(signal)?.defaultEnabled ??
        true,
    };
    await db.instanceAlertThreshold.upsert({
      where: { signal },
      create: { signal, ...data },
      update: data,
    });
    await auditMutationOn(db, ctx, null, {
      action: "instance_alert_threshold.set",
      target: `instance_alert_threshold:${signal}`,
      before: before
        ? {
            threshold: before.threshold,
            durationSeconds: before.durationSeconds,
            enabled: before.enabled,
          }
        : undefined,
      after: data,
    });
  });
  invalidateThresholds();
  const all = await listInstanceThresholds(base);
  return all.find((t) => t.signal === signal) as InstanceThresholdDto;
}

// Back to the shipped default: the override row goes away.
export async function resetInstanceThreshold(
  ctx: TenantContext,
  signal: string,
  base: PrismaClient = basePrisma,
): Promise<InstanceThresholdDto> {
  assertSignals([signal]);
  await asSuperAdminOn(base, async (db) => {
    const { count } = await db.instanceAlertThreshold.deleteMany({
      where: { signal },
    });
    if (count > 0) {
      await auditMutationOn(db, ctx, null, {
        action: "instance_alert_threshold.reset",
        target: `instance_alert_threshold:${signal}`,
      });
    }
  });
  invalidateThresholds();
  const all = await listInstanceThresholds(base);
  return all.find((t) => t.signal === signal) as InstanceThresholdDto;
}
