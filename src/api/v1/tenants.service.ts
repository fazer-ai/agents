import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";

// Read-side tenant service + the mutation type surface. BigInt ids are stringified (JSON-safe). A
// SUPER_ADMIN sees the whole fleet (asSuperAdmin); everyone else sees only their own tenant (RLS via
// runScoped — the tenants policy keys on id = app.tenant_id). The tenant mutation logic
// (create/update/delete) lives in tenants.admin.service; the schemas/types stay here so callers keep
// a stable surface.

// NOTE: these AppError translationKeys are localized centrally in `onError` (not via a literal
// translate() call), so they are declared here for the i18n extractor (keepRemoved: false).
// t/translate magic comments — keep defaults in sync with src/api/locales/*.json:
// translate('errors.tenantSlugInUse', 'This slug is already in use')
// translate('errors.tenantNotFound', 'Tenant not found')
// translate('errors.noUpdatableFields', 'No updatable fields provided')
// translate('errors.agentNotFound', 'Agent not found')
// translate('errors.proEdition', 'This feature requires the Pro edition')

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  demoMode: boolean;
  createdAt: Date;
}

export const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  demoMode: true,
  createdAt: true,
} as const;

export function toDto(t: {
  id: bigint;
  name: string;
  slug: string;
  demoMode: boolean;
  createdAt: Date;
}): TenantDto {
  return {
    id: t.id.toString(),
    name: t.name,
    slug: t.slug,
    demoMode: t.demoMode,
    createdAt: t.createdAt,
  };
}

export async function listTenants(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<TenantDto[]> {
  const rows =
    ctx.role === "SUPER_ADMIN"
      ? await asSuperAdminOn(base, (db) =>
          db.tenant.findMany({ select: TENANT_SELECT, orderBy: { id: "asc" } }),
        )
      : await runScopedOn(base, ctx, (db) =>
          db.tenant.findMany({ select: TENANT_SELECT, orderBy: { id: "asc" } }),
        );
  return rows.map(toDto);
}

// Resolve a tenant SELECTOR (a numeric id or a unique slug) to its tenant, for the MCP tenant-target
// model: a fleet-level SUPER_ADMIN picks which tenant a per-call operation hits. Runs asSuperAdmin
// because selection happens BEFORE any tenant scope exists (RLS would otherwise hide every row), so
// callers MUST already be SUPER_ADMIN (the MCP wrapper only calls this for a SUPER_ADMIN principal).
// An all-digits selector is tried as an id first (canonical), then as a slug; a non-match throws.
export async function resolveTenantSelector(
  selector: string,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  const sel = selector.trim();
  if (sel) {
    const row = await asSuperAdminOn(base, async (db) => {
      // NOTE: `parseDbId`, not a digits test. A run of digits past 2^63-1 passes `/^\d+$/`,
      // converts, and is refused by POSTGRES when the query binds it — a 500 on a lookup whose
      // other outcome is a 404. A selector that is not an id is simply tried as a slug. Issue #407.
      const asId = parseDbId(sel);
      if (asId !== null) {
        const byId = await db.tenant.findUnique({
          where: { id: asId },
          select: TENANT_SELECT,
        });
        if (byId) return byId;
      }
      return db.tenant.findUnique({
        where: { slug: sel },
        select: TENANT_SELECT,
      });
    });
    if (row) return toDto(row);
  }
  throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
}

export async function getTenant(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  const row =
    ctx.role === "SUPER_ADMIN"
      ? await asSuperAdminOn(base, (db) =>
          db.tenant.findFirst({ where: { id }, select: TENANT_SELECT }),
        )
      : await runScopedOn(base, ctx, (db) =>
          db.tenant.findFirst({ where: { id }, select: TENANT_SELECT }),
        );
  if (!row)
    throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
  return toDto(row);
}

// Mutation schemas + inferred types. The schemas live here (present in every edition) so the type
// surface callers import is stable; the mutation LOGIC that consumes them is Pro-only
// (tenants.admin.service).
export const tenantUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export type TenantUpdate = z.infer<typeof tenantUpdateSchema>;

export const tenantCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    // slug is the stable identifier (unique); restrict to a URL/DNS-safe shape.
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "invalid slug"),
  })
  .strict();

export type TenantCreate = z.infer<typeof tenantCreateSchema>;

// What `createTenant`/`updateTenant` decide about their INPUT, before any database is involved.
// They live HERE rather than beside the mutations because the Free derivation swaps
// tenants.admin.service for a stub, and the MCP preview has to ask the same question the apply asks
// in both editions (#490).
export function assertTenantCreatable(input: TenantCreate): TenantCreate {
  return parseInput(tenantCreateSchema, input);
}

// The other half of what `createTenant` refuses, and it is a DIFFERENT KIND of answer. The one
// above judges the input, so its verdict cannot change between preview and apply. This one reads
// the fleet, from outside the write's transaction: it is ADVISORY. Someone can take the slug in
// the gap, and then the preview said "will create" and the apply answers 409 — which is the exact
// divergence #490 is about, one race narrower.
//
// It is still worth asking, because the case that actually happens is a slug the operator already
// used, not a slug someone takes in the millisecond after the preview. What keeps the GUARANTEE is
// the unique index the create runs into; this only moves the common refusal to where the operator
// asked for it. Nothing below may be read as "the slug is reserved".
//
// asSuperAdminOn for the same reason `resolveTenantSelector` uses it: slugs are unique fleet-wide,
// and a scoped read would hide the very row that will cause the 409.
export async function assertTenantSlugAvailable(
  slug: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const taken = await asSuperAdminOn(base, (db) =>
    db.tenant.findUnique({ where: { slug }, select: { id: true } }),
  );
  if (taken) {
    throw new ConflictError(
      "tenant slug already in use",
      "errors.tenantSlugInUse",
      "slug",
    );
  }
}

export function assertTenantUpdatable(patch: TenantUpdate): TenantUpdate {
  const parsed = parseInput(tenantUpdateSchema, patch);
  if (parsed.name === undefined) {
    throw new AppError(
      "no updatable fields provided",
      400,
      "errors.noUpdatableFields",
    );
  }
  return parsed;
}
