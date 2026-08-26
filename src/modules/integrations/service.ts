import type {
  InboundAuthStrategy,
  Prisma,
  PrismaClient,
} from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { requireVaultRef } from "@/modules/vault/service";
import { isUsableHeaderName } from "@/modules/webhooks/inbound/auth";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import { CATALOG, getCatalogEntry } from "./catalog";
import type { CatalogEntry } from "./types";

// Integration instances: the per-tenant activation of a catalog entry. Creation mints the opaque
// inbound route token; resolution maps an incoming token to the owning tenant + instance via a
// constant-time hash lookup (cross-tenant, so asSuperAdmin).
//
// NOTE: The token is persisted TWICE — `routeTokenHash` (SHA-256) is what the hot inbound path
// probes, and `routeToken` is an encryptJson() copy that exists purely so the operator can re-read
// the webhook URL in the editor. It is an ADDRESS, not the authenticator (inbound calls are
// authenticated by inboundAuthStrategy + the vault secret), and it is returned only by the
// single-instance read, never by the list. Rows created before that column exists decrypt to null,
// and the editor offers rotateIntegrationRouteToken instead.

export interface ResolvedInboundRoute {
  id: bigint;
  tenantId: bigint;
  catalogType: string;
  enabled: boolean;
  inboundAuthStrategy: InboundAuthStrategy;
  inboundSecretRef: string | null;
  config: Record<string, unknown>;
}

export async function resolveInboundRouteByToken(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<ResolvedInboundRoute | null> {
  const routeTokenHash = hashRouteToken(token);
  const row = await asSuperAdminOn(base, (db) =>
    db.integrationInstance.findUnique({
      where: { routeTokenHash },
      select: {
        id: true,
        tenantId: true,
        catalogType: true,
        enabled: true,
        inboundAuthStrategy: true,
        inboundSecretRef: true,
        config: true,
      },
    }),
  );
  if (!row) return null;
  return { ...row, config: (row.config ?? {}) as Record<string, unknown> };
}

// `config` is a free-form bag on both writers (`z.record(z.string(), z.unknown())`, no allowlist),
// and two of its keys are read back as HEADER NAMES by the inbound gate. `request.headers.get`
// throws on a name outside RFC 7230's token, so before issue #362 a trailing space typed into that
// JSON answered every delivery 500 — where every other refusal is a uniform 401, making the status
// itself the oracle that uniformity exists to deny, and making the provider retry a request that
// can never succeed.
//
// This REFUSES rather than trimming, the same call issue #340 made for vault values: the operator
// typing a header name into raw JSON gets no feedback either way, and a refusal that names the key
// is the only feedback there is. Trimming would also only cover the padded spelling — `x tok` has
// to be refused regardless — so normalising would buy a second code path and still refuse.
//
// Only a STRING is judged. A key holding a number or null is already ignored by
// `resolveInboundAuthConfig`'s `override`, which falls back to the catalog's name and then ours;
// that is documented behaviour, and rows already carry it. Refusing it here would turn an existing
// instance's next unrelated save into a 400.
//
// The read refuses too, and neither makes the other redundant: this one cannot reach a row already
// written, and that one cannot tell the operator anything.
const HEADER_NAME_KEYS = ["authHeader", "signatureHeader"] as const;

export function assertUsableHeaderNames(config: Record<string, unknown>): void {
  for (const key of HEADER_NAME_KEYS) {
    const value = config[key];
    if (typeof value !== "string") continue;
    if (isUsableHeaderName(value)) continue;
    // The sentence names the key because `AppError.field` does not survive every caller: the MCP
    // writer sends `e.message` alone (issue #340 measured the same loss on the vault path).
    throw new AppError(
      `config.${key} is not a usable header name`,
      400,
      "errors.integrationHeaderNameUnusable",
      { field: `config.${key}` },
      `config.${key}`,
    );
  }
}

export interface CreateIntegrationParams {
  catalogType: string;
  name: string;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
  inboundAuthStrategy?: InboundAuthStrategy;
  inboundSecretRef?: string | null;
  enabled?: boolean;
}

// Returns the plaintext route token for inbound-capable integrations; outbound-only ones
// (Calendar/Drive) carry no token (routeTokenHash null, no inbound auth). Callers surface it to the
// operator who pastes it into the provider; it stays re-readable via getIntegrationInstance.
export async function createIntegrationInstance(
  ctx: TenantContext,
  params: CreateIntegrationParams,
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; routeToken: string | null }> {
  const entry = getCatalogEntry(params.catalogType);
  if (!entry) {
    throw new AppError(`unknown catalogType: ${params.catalogType}`, 400);
  }
  if (params.config) assertUsableHeaderNames(params.config);
  // Only inbound-capable catalog entries mint a route token; the rest get no inbound surface.
  const minted = entry.supportsInbound ? generateRouteToken() : null;
  const tenantId = ctx.tenantId as bigint;
  const created = await runScopedOn(base, ctx, async (db) => {
    const credentialRef = params.credentialRef
      ? await requireVaultRef(db, params.credentialRef)
      : null;
    const inboundSecretRef =
      minted && params.inboundSecretRef
        ? await requireVaultRef(db, params.inboundSecretRef)
        : null;
    return db.integrationInstance.create({
      data: {
        tenantId,
        catalogType: params.catalogType,
        name: params.name,
        enabled: params.enabled ?? true,
        config: (params.config ?? {}) as Prisma.InputJsonValue,
        credentialRef,
        inboundAuthStrategy: minted
          ? (params.inboundAuthStrategy ?? "NONE")
          : "NONE",
        inboundSecretRef,
        routeTokenHash: minted?.hash ?? null,
        routeToken: minted ? encryptJson(minted.token) : null,
      },
      select: { id: true },
    });
  });
  return { id: created.id, routeToken: minted?.token ?? null };
}

// ── management (per-tenant CRUD over the REST surface) ──

export function listCatalog(): ReadonlyArray<CatalogEntry> {
  return CATALOG;
}

export interface IntegrationInstanceDto {
  id: string;
  catalogType: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  credentialRef: string | null;
  inboundAuthStrategy: InboundAuthStrategy;
  inboundSecretRef: string | null;
  // NOTE: The inbound webhook token, decrypted. Populated ONLY by getIntegrationInstance (the
  // editor needs it to show the URL); the list leaves it null so N tokens are not sprayed to a
  // screen that shows none of them. `routeTokenStatus` says WHY it is null when it is — see
  // readRouteToken; the list always reports "absent" because it never reads the column.
  routeToken: string | null;
  routeTokenStatus: RouteTokenStatus;
  createdAt: Date;
  updatedAt: Date;
}

const INSTANCE_SELECT = {
  id: true,
  catalogType: true,
  name: true,
  enabled: true,
  config: true,
  credentialRef: true,
  inboundAuthStrategy: true,
  inboundSecretRef: true,
  createdAt: true,
  updatedAt: true,
} as const;

// NOTE: Why the three states are distinct. A blob that fails to decrypt does NOT throw here —
// nothing downstream makes a security decision on this value (it is an address for the operator to
// copy), and throwing would 500 the edit modal of every integration on the instance. But it must
// not collapse into `absent` either: that would tell the operator "this predates the feature" when
// the truth is "the key can no longer read it", which sends them looking in the wrong place. So the
// failure keeps its own status, and the logger.warn stays as the ops signal. Both non-present
// states resolve the same way — rotate — but the editor says which one it is.
export type RouteTokenStatus = "present" | "absent" | "unreadable";

function readRouteToken(blob: string | null | undefined): {
  token: string | null;
  status: RouteTokenStatus;
} {
  if (!blob) return { token: null, status: "absent" };
  try {
    return { token: decryptJson<string>(blob), status: "present" };
  } catch {
    logger.warn("integration route token failed to decrypt (rotation needed)");
    return { token: null, status: "unreadable" };
  }
}

function toInstanceDto(r: {
  id: bigint;
  catalogType: string;
  name: string;
  enabled: boolean;
  config: unknown;
  credentialRef: string | null;
  inboundAuthStrategy: InboundAuthStrategy;
  inboundSecretRef: string | null;
  routeToken?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): IntegrationInstanceDto {
  return {
    id: String(r.id),
    catalogType: r.catalogType,
    name: r.name,
    enabled: r.enabled,
    config: (r.config ?? {}) as Record<string, unknown>,
    credentialRef: r.credentialRef,
    inboundAuthStrategy: r.inboundAuthStrategy,
    inboundSecretRef: r.inboundSecretRef,
    ...(() => {
      const { token, status } = readRouteToken(r.routeToken);
      return { routeToken: token, routeTokenStatus: status };
    })(),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listIntegrationInstances(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<IntegrationInstanceDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.integrationInstance.findMany({
      select: INSTANCE_SELECT,
      orderBy: { name: "asc" },
    }),
  );
  return rows.map(toInstanceDto);
}

// NOTE: The only read that returns the decrypted routeToken — this is what backs the webhook URL
// field in the editor. Keep it out of the list (see IntegrationInstanceDto.routeToken).
export async function getIntegrationInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<IntegrationInstanceDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.integrationInstance.findUnique({
      where: { id },
      select: { ...INSTANCE_SELECT, routeToken: true },
    }),
  );
  if (!row) {
    throw new NotFoundError(
      "integration instance not found",
      "errors.integrationInstanceNotFound",
    );
  }
  return toInstanceDto(row);
}

export interface UpdateIntegrationParams {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  credentialRef?: string | null;
  inboundAuthStrategy?: InboundAuthStrategy;
  inboundSecretRef?: string | null;
}

export async function updateIntegrationInstance(
  ctx: TenantContext,
  id: bigint,
  params: UpdateIntegrationParams,
  base: PrismaClient = basePrisma,
): Promise<IntegrationInstanceDto> {
  if (params.config) assertUsableHeaderNames(params.config);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.integrationInstance.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current) {
      throw new NotFoundError(
        "integration instance not found",
        "errors.integrationInstanceNotFound",
      );
    }
    const credentialRef = params.credentialRef
      ? await requireVaultRef(db, params.credentialRef)
      : null;
    const inboundSecretRef = params.inboundSecretRef
      ? await requireVaultRef(db, params.inboundSecretRef)
      : null;
    await db.integrationInstance.update({
      where: { id },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.config !== undefined
          ? { config: params.config as Prisma.InputJsonValue }
          : {}),
        ...(params.credentialRef !== undefined ? { credentialRef } : {}),
        ...(params.inboundAuthStrategy !== undefined
          ? { inboundAuthStrategy: params.inboundAuthStrategy }
          : {}),
        ...(params.inboundSecretRef !== undefined ? { inboundSecretRef } : {}),
      },
    });
    const row = await db.integrationInstance.findUniqueOrThrow({
      where: { id },
      select: INSTANCE_SELECT,
    });
    return toInstanceDto(row);
  });
}

// NOTE: Mints a NEW inbound route token, invalidating the old URL the instant it commits. Two
// reasons it exists: an instance created before `routeToken` was stored has no readable URL (only
// the hash survives), and a leaked URL needs a way out. The caller must warn the operator that the
// provider's dashboard has to be updated — nothing else can reach the old address afterwards.
export async function rotateIntegrationRouteToken(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<{ routeToken: string }> {
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.integrationInstance.findUnique({
      where: { id },
      select: { catalogType: true },
    });
    if (!current) {
      throw new NotFoundError(
        "integration instance not found",
        "errors.integrationInstanceNotFound",
      );
    }
    // Outbound-only entries (Calendar/Drive) have no inbound surface, so there is no URL to rotate.
    if (!getCatalogEntry(current.catalogType)?.supportsInbound) {
      throw new AppError(
        `integration ${current.catalogType} has no inbound webhook`,
        400,
        "errors.integrationNoInboundWebhook",
        { integration: current.catalogType },
      );
    }
    const minted = generateRouteToken();
    await db.integrationInstance.update({
      where: { id },
      data: {
        routeTokenHash: minted.hash,
        routeToken: encryptJson(minted.token),
      },
    });
    return { routeToken: minted.token };
  });
}

export async function deleteIntegrationInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.integrationInstance.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "integration instance not found",
        "errors.integrationInstanceNotFound",
      );
    }
  });
}
