import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import type { NumberRange } from "@/lib/number-range";
import { parseInput } from "@/lib/parse-input";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import { ensureClientAnonSweep } from "@/modules/client-apps/expiry";
import { CLIENT_APP_RANGES } from "@/modules/client-apps/ranges";
import { syncTenantSpendPoll } from "@/modules/spend-ceiling/arm";
import { monthStart } from "@/modules/spend-ceiling/decide";
import { centsOf } from "@/modules/spend-ceiling/settings";

// The web applications that embed an agent through the client channel's SDK (docs/client-channel.md,
// "Embedding with the SDK"), and the keys their servers sign their users' JWTs with. The AppError
// translation keys thrown here are registered by `translate()` comments in
// src/api/v1/client-apps.controller.ts, since the extractor only scans src/api.

// How long a rotated-out key keeps verifying. Long enough for every token signed with it (they live
// an hour at most, `exp` is checked) to run out, and for the application's own deploy of the new
// secret to land.
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_ORIGINS = 20;

export type ClientAppSecretState = "current" | "expiring";

export interface ClientAppDto {
  id: string;
  agentId: string;
  name: string;
  publicId: string;
  allowedOrigins: string[];
  anonymousEnabled: boolean;
  anonSessionsPerHour: number;
  anonMessagesPerMin: number;
  anonExpiryDays: number;
  // The app's own monthly spend ceiling in USD, null for none; and this month's spend as the last
  // poll read it, null when no poll has read it (no ceiling, or not polled yet).
  monthlyCeilingUsd: number | null;
  monthSpendUsd: number | null;
  // The Turnstile challenge before a new anonymous session: whether it is on, the public site key,
  // and whether a secret is stored (never the secret).
  turnstileEnabled: boolean;
  turnstileSiteKey: string | null;
  turnstileSecretSet: boolean;
  // The keys that still verify, newest first. Never the key itself: it is shown once, by the call
  // that minted it.
  secrets: { kid: string; createdAt: Date; expiresAt: Date | null }[];
  createdAt: Date;
  updatedAt: Date;
}

// A key as the operator copies it, once.
export interface MintedSecret {
  kid: string;
  secret: string;
}

// An origin as the browser sends it in `Origin`: scheme, host and a port only when it is not the
// default, nothing else. Plain http only on loopback, where a developer runs the application; a real
// deployment that serves its page over http would hand the user's token to anyone on the path.
function normalizeOrigin(raw: string, ctx: z.RefinementCtx): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    ctx.addIssue({ code: "custom", message: `not an origin: ${raw}` });
    return z.NEVER;
  }
  // NOTE: `URL` takes `*` as a hostname character, and the browser never sends one: a wildcard here
  // would be stored as an origin no request can match, read by the operator as "every subdomain".
  if (url.hostname.includes("*")) {
    ctx.addIssue({ code: "custom", message: `no wildcard origins: ${raw}` });
    return z.NEVER;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    ctx.addIssue({
      code: "custom",
      message: `an origin must be https (http only for localhost): ${raw}`,
    });
    return z.NEVER;
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    ctx.addIssue({
      code: "custom",
      message: `an origin has no path, query or fragment: ${raw}`,
    });
    return z.NEVER;
  }
  return url.origin;
}

const ranged = (r: NumberRange) => z.number().int().min(r.min).max(r.max);
const anonExpiryDays = ranged(CLIENT_APP_RANGES.anonExpiryDays);
const anonSessionsPerHour = ranged(CLIENT_APP_RANGES.anonSessionsPerHour);
export const MONTHLY_CEILING_USD_MAX = CLIENT_APP_RANGES.monthlyCeilingUsd.max;
// Dollars as typed, kept to the cent; null takes the ceiling off.
const monthlyCeilingUsd = z
  .number()
  .min(CLIENT_APP_RANGES.monthlyCeilingUsd.min)
  .max(MONTHLY_CEILING_USD_MAX)
  .nullable()
  .transform((v) => (v === null ? null : centsOf(v, "round") / 100));
const toCents = (usd: number | null) =>
  usd === null ? null : centsOf(usd, "round");
const turnstileFields = {
  turnstileEnabled: z.boolean().optional(),
  turnstileSiteKey: z.string().trim().min(1).max(200).nullable().optional(),
  turnstileSecret: z.string().trim().min(1).max(200).nullable().optional(),
};
const anonMessagesPerMin = ranged(CLIENT_APP_RANGES.anonMessagesPerMin);

const originsSchema = z
  .array(z.string().transform(normalizeOrigin))
  .max(MAX_ORIGINS)
  .transform((list) => [...new Set(list)]);

export const clientAppCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    allowedOrigins: originsSchema,
    anonymousEnabled: z.boolean().optional(),
    anonSessionsPerHour: anonSessionsPerHour.optional(),
    anonMessagesPerMin: anonMessagesPerMin.optional(),
    anonExpiryDays: anonExpiryDays.optional(),
    monthlyCeilingUsd: monthlyCeilingUsd.optional(),
    ...turnstileFields,
  })
  .strict();

export const clientAppUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    allowedOrigins: originsSchema.optional(),
    anonymousEnabled: z.boolean().optional(),
    anonSessionsPerHour: anonSessionsPerHour.optional(),
    anonMessagesPerMin: anonMessagesPerMin.optional(),
    anonExpiryDays: anonExpiryDays.optional(),
    monthlyCeilingUsd: monthlyCeilingUsd.optional(),
    ...turnstileFields,
  })
  .strict();

export type ClientAppCreate = z.input<typeof clientAppCreateSchema>;
export type ClientAppUpdate = z.input<typeof clientAppUpdateSchema>;

const token = (prefix: string, bytes: number) =>
  `${prefix}_${randomBytes(bytes).toString("base64url")}`;

function mintSecret() {
  return {
    kid: token("key", 12),
    // NOTE: 256 bits, the size of the HS256 output: a shorter key is the weak link.
    secret: randomBytes(32).toString("base64url"),
  };
}

const SELECT = {
  id: true,
  agentId: true,
  name: true,
  publicId: true,
  allowedOrigins: true,
  anonymousEnabled: true,
  anonSessionsPerHour: true,
  anonMessagesPerMin: true,
  anonExpiryDays: true,
  monthlyCeilingCents: true,
  turnstileEnabled: true,
  turnstileSiteKey: true,
  turnstileSecret: true,
  createdAt: true,
  updatedAt: true,
  secrets: {
    select: { kid: true, createdAt: true, expiresAt: true },
    orderBy: { id: "desc" },
  },
} as const;

type Row = {
  id: bigint;
  agentId: bigint;
  name: string;
  publicId: string;
  allowedOrigins: string[];
  anonymousEnabled: boolean;
  anonSessionsPerHour: number;
  anonMessagesPerMin: number;
  anonExpiryDays: number;
  monthlyCeilingCents: number | null;
  turnstileEnabled: boolean;
  turnstileSiteKey: string | null;
  turnstileSecret: string | null;
  createdAt: Date;
  updatedAt: Date;
  secrets: { kid: string; createdAt: Date; expiresAt: Date | null }[];
};

// The keys that still verify at `now`: the current one, and a previous one inside its grace.
const validAt = (now: Date) => ({
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

// The snapshot source an app's share of the client spend is polled under.
export function appSpendSource(appId: bigint): string {
  return `app:${appId}`;
}

function toDto(
  row: Row,
  now = new Date(),
  monthSpendUsd: number | null = null,
): ClientAppDto {
  return {
    id: row.id.toString(),
    agentId: row.agentId.toString(),
    name: row.name,
    publicId: row.publicId,
    allowedOrigins: row.allowedOrigins,
    anonymousEnabled: row.anonymousEnabled,
    anonSessionsPerHour: row.anonSessionsPerHour,
    anonMessagesPerMin: row.anonMessagesPerMin,
    anonExpiryDays: row.anonExpiryDays,
    monthlyCeilingUsd:
      row.monthlyCeilingCents === null ? null : row.monthlyCeilingCents / 100,
    monthSpendUsd,
    turnstileEnabled: row.turnstileEnabled,
    turnstileSiteKey: row.turnstileSiteKey,
    turnstileSecretSet: row.turnstileSecret !== null,
    secrets: row.secrets.filter((s) => !s.expiresAt || s.expiresAt > now),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// What the trail records: the shape of the app, never a key.
function auditView(row: Row) {
  return {
    agentId: row.agentId.toString(),
    name: row.name,
    publicId: row.publicId,
    allowedOrigins: row.allowedOrigins,
    anonymousEnabled: row.anonymousEnabled,
    anonSessionsPerHour: row.anonSessionsPerHour,
    anonMessagesPerMin: row.anonMessagesPerMin,
    anonExpiryDays: row.anonExpiryDays,
    monthlyCeilingCents: row.monthlyCeilingCents,
    turnstileEnabled: row.turnstileEnabled,
    turnstileSiteKey: row.turnstileSiteKey,
    // NOTE: never the secret: a fingerprint of the stored ciphertext, which a new encryption changes
    // even for the same secret, so replacing the secret is an audited change and not "nothing changed".
    turnstileSecret:
      row.turnstileSecret === null
        ? null
        : createHash("sha256")
            .update(row.turnstileSecret)
            .digest("hex")
            .slice(0, 12),
  };
}

// A challenge with no site key or no secret could never be passed: refused rather than stored.
export function assertTurnstileComplete(row: {
  turnstileEnabled: boolean;
  turnstileSiteKey: string | null;
  turnstileSecret: string | null;
}): void {
  if (row.turnstileEnabled && (!row.turnstileSiteKey || !row.turnstileSecret))
    throw new AppError(
      "the Turnstile challenge needs its site key and secret",
      422,
      "errors.clientAppTurnstileIncomplete",
    );
}

// The secret as stored: encrypted, or null to clear it.
const sealed = (secret: string | null) =>
  secret === null ? null : encryptJson(secret);

// This month's polled spend of each app, by app id.
async function monthSpend(
  db: Parameters<Parameters<typeof runScopedOn>[2]>[0],
  appIds: bigint[],
  now = new Date(),
): Promise<Map<string, number>> {
  if (appIds.length === 0) return new Map();
  const rows = await db.spendCostSnapshot.findMany({
    where: {
      source: { in: appIds.map(appSpendSource) },
      monthStart: monthStart(now),
      polledAt: { not: null },
    },
    select: { source: true, costUsd: true },
  });
  return new Map(rows.map((r) => [r.source, Number(r.costUsd)]));
}

function tenantOf(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  return ctx.tenantId;
}

const appNotFound = () =>
  new NotFoundError("client app not found", "errors.clientAppNotFound");

export async function listClientApps(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ClientAppDto[]> {
  const { rows, spend } = await runScopedOn(base, ctx, async (db) => {
    const rows = await db.clientApp.findMany({
      where: { agentId },
      select: SELECT,
      orderBy: { id: "asc" },
    });
    return {
      rows,
      spend: await monthSpend(
        db,
        rows.map((r) => r.id),
      ),
    };
  });
  return rows.map((r) =>
    toDto(r, new Date(), spend.get(appSpendSource(r.id)) ?? null),
  );
}

export async function getClientApp(
  ctx: TenantContext,
  appId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ClientAppDto> {
  const found = await runScopedOn(base, ctx, async (db) => {
    const row = await db.clientApp.findUnique({
      where: { id: appId },
      select: SELECT,
    });
    return row ? { row, spend: await monthSpend(db, [row.id]) } : null;
  });
  if (!found) throw appNotFound();
  return toDto(
    found.row,
    new Date(),
    found.spend.get(appSpendSource(found.row.id)) ?? null,
  );
}

// Creating the app mints its first key: an app with no key cannot sign anyone in, and a second step
// to get one is a step every integration would take.
export async function createClientApp(
  ctx: TenantContext,
  agentId: bigint,
  input: ClientAppCreate,
  base: PrismaClient = basePrisma,
): Promise<{ app: ClientAppDto; secret: MintedSecret }> {
  const tenantId = tenantOf(ctx);
  const parsed = parseInput(clientAppCreateSchema, input);
  assertTurnstileComplete({
    turnstileEnabled: parsed.turnstileEnabled ?? false,
    turnstileSiteKey: parsed.turnstileSiteKey ?? null,
    turnstileSecret: parsed.turnstileSecret ?? null,
  });
  const minted = mintSecret();
  const row = await runScopedOn(base, ctx, async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent)
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    const created = await db.clientApp.create({
      data: {
        tenantId,
        agentId,
        name: parsed.name,
        publicId: token("app", 12),
        allowedOrigins: parsed.allowedOrigins,
        anonymousEnabled: parsed.anonymousEnabled ?? false,
        ...(parsed.anonSessionsPerHour !== undefined
          ? { anonSessionsPerHour: parsed.anonSessionsPerHour }
          : {}),
        ...(parsed.anonMessagesPerMin !== undefined
          ? { anonMessagesPerMin: parsed.anonMessagesPerMin }
          : {}),
        ...(parsed.anonExpiryDays !== undefined
          ? { anonExpiryDays: parsed.anonExpiryDays }
          : {}),
        monthlyCeilingCents: toCents(parsed.monthlyCeilingUsd ?? null),
        turnstileEnabled: parsed.turnstileEnabled ?? false,
        turnstileSiteKey: parsed.turnstileSiteKey ?? null,
        turnstileSecret: sealed(parsed.turnstileSecret ?? null),
        secrets: {
          create: {
            tenantId,
            kid: minted.kid,
            secret: encryptJson(minted.secret),
          },
        },
      },
      select: SELECT,
    });
    await auditMutation(db, ctx, {
      action: "client_app.create",
      target: created.id.toString(),
      after: auditView(created),
    });
    return created;
  });
  if (row.monthlyCeilingCents !== null)
    await syncTenantSpendPoll(tenantId, base);
  // NOTE: best effort: the app exists either way, and the boot arms every tenant with an app again.
  await ensureClientAnonSweep(tenantId, base).catch((err) =>
    logger.warn(
      { tenantId: String(tenantId), err },
      "client anonymous sweep could not be armed",
    ),
  );
  return { app: toDto(row), secret: minted };
}

export async function updateClientApp(
  ctx: TenantContext,
  appId: bigint,
  input: ClientAppUpdate,
  base: PrismaClient = basePrisma,
): Promise<ClientAppDto> {
  const parsed = parseInput(clientAppUpdateSchema, input);
  const row = await runScopedOn(base, ctx, async (db) => {
    const before = await db.clientApp.findUnique({
      where: { id: appId },
      select: SELECT,
    });
    if (!before) throw appNotFound();
    const { monthlyCeilingUsd, turnstileSecret, ...fields } = parsed;
    assertTurnstileComplete({
      turnstileEnabled: fields.turnstileEnabled ?? before.turnstileEnabled,
      turnstileSiteKey:
        fields.turnstileSiteKey !== undefined
          ? fields.turnstileSiteKey
          : before.turnstileSiteKey,
      turnstileSecret:
        turnstileSecret !== undefined
          ? turnstileSecret
          : before.turnstileSecret,
    });
    const after = await db.clientApp.update({
      where: { id: appId },
      data: {
        ...fields,
        ...(monthlyCeilingUsd !== undefined
          ? { monthlyCeilingCents: toCents(monthlyCeilingUsd) }
          : {}),
        ...(turnstileSecret !== undefined
          ? { turnstileSecret: sealed(turnstileSecret) }
          : {}),
      },
      select: SELECT,
    });
    // NOTE: the row as written, under its lock: a concurrent update (one clearing the secret while
    // this one turns the check on) passes the check above on its own snapshot, and together they
    // would leave the check on with no secret, which the session route reads as off.
    assertTurnstileComplete(after);
    if (projectionMoved(auditView(before), auditView(after)))
      await auditMutation(db, ctx, {
        action: "client_app.update",
        target: appId.toString(),
        before: auditView(before),
        after: auditView(after),
      });
    return after;
  });
  if (parsed.monthlyCeilingUsd !== undefined && ctx.tenantId !== null)
    await syncTenantSpendPoll(ctx.tenantId, base);
  return toDto(row);
}

export async function deleteClientApp(
  ctx: TenantContext,
  appId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const before = await db.clientApp.findUnique({
      where: { id: appId },
      select: SELECT,
    });
    if (!before) throw appNotFound();
    await db.clientApp.delete({ where: { id: appId } });
    await auditMutation(db, ctx, {
      action: "client_app.delete",
      target: appId.toString(),
      before: auditView(before),
    });
  });
  // NOTE: the deleted app's anonymous conversations are the sweep's to remove, even when it was the
  // tenant's last app.
  if (ctx.tenantId !== null)
    await ensureClientAnonSweep(ctx.tenantId, base).catch((err) =>
      logger.warn(
        { tenantId: String(ctx.tenantId), err },
        "client anonymous sweep could not be armed",
      ),
    );
}

// A new key becomes the current one and the previous current key keeps verifying for the grace
// window, so users signed in before the application deploys the new secret stay signed in. Any key
// still in an older grace window ends now: at most two keys verify at any moment, and a third
// rotation in a day is the operator replacing a key they believe leaked. The app's row is locked
// first, so two rotations of one app run one after the other and the second sees the first's key.
export async function rotateClientAppSecret(
  ctx: TenantContext,
  appId: bigint,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<{ app: ClientAppDto; secret: MintedSecret }> {
  const tenantId = tenantOf(ctx);
  const minted = mintSecret();
  const row = await runScopedOn(base, ctx, async (db) => {
    const locked = await db.$queryRaw<
      { id: bigint }[]
    >`SELECT id FROM client_apps WHERE id = ${appId} FOR UPDATE`;
    if (locked.length === 0) throw appNotFound();
    await db.clientAppSecret.updateMany({
      where: { appId, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    await db.clientAppSecret.updateMany({
      where: { appId, expiresAt: null },
      data: { expiresAt: new Date(now.getTime() + ROTATION_GRACE_MS) },
    });
    await db.clientAppSecret.deleteMany({
      where: { appId, expiresAt: { lte: now } },
    });
    await db.clientAppSecret.create({
      data: {
        tenantId,
        appId,
        kid: minted.kid,
        secret: encryptJson(minted.secret),
      },
    });
    await auditMutation(db, ctx, {
      action: "client_app.secret_rotate",
      target: appId.toString(),
      after: { kid: minted.kid },
    });
    return db.clientApp.findUniqueOrThrow({
      where: { id: appId },
      select: SELECT,
    });
  });
  return { app: toDto(row, now), secret: minted };
}

// Ends a key now, for a key the operator believes leaked. The current key can be revoked too: the app
// then signs nobody in until the next rotation, which is what a leak calls for. A key past its grace
// no longer verifies, so it is "not found" here exactly as it is absent from the app's listing.
export async function revokeClientAppSecret(
  ctx: TenantContext,
  appId: bigint,
  kid: string,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<ClientAppDto> {
  const row = await runScopedOn(base, ctx, async (db) => {
    const removed = await db.clientAppSecret.deleteMany({
      where: { appId, kid, ...validAt(now) },
    });
    if (removed.count === 0)
      throw new NotFoundError(
        "client app key not found",
        "errors.clientAppSecretNotFound",
      );
    await auditMutation(db, ctx, {
      action: "client_app.secret_revoke",
      target: appId.toString(),
      before: { kid },
    });
    return db.clientApp.findUniqueOrThrow({
      where: { id: appId },
      select: SELECT,
    });
  });
  return toDto(row);
}

// The app a browser names, read before there is any tenant context: the public id and the token's
// key id are all the request carries. Returns the keys that still verify, decrypted, for the caller
// to check the token against.
export interface ResolvedClientApp {
  id: bigint;
  tenantId: bigint;
  agentId: bigint;
  publicId: string;
  allowedOrigins: string[];
  anonymousEnabled: boolean;
  anonSessionsPerHour: number;
  anonMessagesPerMin: number;
  monthlyCeilingCents: number | null;
  // The Turnstile secret, decrypted, while the challenge is on; null otherwise.
  turnstileSecret: string | null;
  keys: Map<string, string>;
}

export async function resolveClientApp(
  publicId: string,
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<ResolvedClientApp | null> {
  const row = await asSuperAdminOn(base, (db) =>
    db.clientApp.findUnique({
      where: { publicId },
      select: {
        id: true,
        tenantId: true,
        agentId: true,
        publicId: true,
        allowedOrigins: true,
        anonymousEnabled: true,
        anonSessionsPerHour: true,
        anonMessagesPerMin: true,
        monthlyCeilingCents: true,
        turnstileEnabled: true,
        turnstileSecret: true,
        secrets: {
          where: validAt(now),
          select: { kid: true, secret: true },
        },
      },
    }),
  );
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    publicId: row.publicId,
    allowedOrigins: row.allowedOrigins,
    anonymousEnabled: row.anonymousEnabled,
    anonSessionsPerHour: row.anonSessionsPerHour,
    anonMessagesPerMin: row.anonMessagesPerMin,
    monthlyCeilingCents: row.monthlyCeilingCents,
    turnstileSecret:
      row.turnstileEnabled && row.turnstileSecret
        ? decryptJson<string>(row.turnstileSecret)
        : null,
    keys: new Map(
      row.secrets.map((s) => [s.kid, decryptJson<string>(s.secret)]),
    ),
  };
}
