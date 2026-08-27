import basePrisma from "@/api/lib/prisma";
import { createTenant } from "@/api/v1/tenants.admin.service";
import { getTenant, listTenants } from "@/api/v1/tenants.service";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { parseMcpId } from "@/modules/mcp/write";
import { hasScope, type VerifiedToken } from "./oauth/tokens";
import { ctxOf, err, ok, type WriteDeps, type WriteResult } from "./write";

// MCP fleet/admin write tools: provision and read tenants ACROSS the fleet. Unlike the
// per-tenant tools these are NOT tenant-fenced — they require mcp:admin (only SUPER_ADMIN tokens
// hold it; the role check below is defense-in-depth) and run as the audited asSuperAdmin path.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// Fleet gate: mcp:admin scope + a SUPER_ADMIN token. No tenant target required (cross-tenant ops).
function adminGate(principal: VerifiedToken): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:admin")) {
    return err("insufficient_scope: this tool requires the mcp:admin scope");
  }
  if (principal.role !== "SUPER_ADMIN") {
    return err("forbidden: fleet operations require a SUPER_ADMIN token");
  }
  return ctxOf(principal);
}

export async function tenantList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ tenants: await listTenants(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function tenantGet(
  principal: VerifiedToken,
  args: { tenant_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  // NOTE: the same parser every other MCP surface uses. A `try`/`catch` around `BigInt` catches
  // the spelling half and misses the range half, which is the half that reaches the database.
  const id = parseMcpId(args.tenant_id, "tenant_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ tenant: await getTenant(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

export async function tenantCreate(
  principal: VerifiedToken,
  args: { name: string; slug: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = adminGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "tenant",
        preview: { name: args.name, slug: args.slug },
      });
    }
    const created = await createTenant(
      ctx,
      { name: args.name, slug: args.slug },
      base,
    );
    // `createTenant` records its own fleet-level row (tenant_id NULL), inside the asSuperAdmin
    // transaction that provisions the tenant.
    return ok({ dryRun: false, applied: true, tenant: created });
  } catch (e) {
    return failOf(e);
  }
}
