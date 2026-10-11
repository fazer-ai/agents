import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { resolveTenantSelector } from "@/api/v1/tenants.service";
import type { VerifiedToken } from "./oauth/tokens";

// MCP tenant targeting. A fleet-level SUPER_ADMIN token is tenant-AGNOSTIC (tenantId null): it picks
// the target tenant EXPLICITLY, per call, via a `tenant` selector — so one session can drive many
// tenants. A tenant-scoped token (TENANT_ADMIN / API key) keeps its tenant IMPLICIT/transparent: the
// `tenant` field is never even shown to it, and any value it might send is ignored. Either way the
// per-tenant tool runs against an "effective principal" whose tenantId is set, identical in shape to
// an ordinary tenant token — so every gate/service below sees one tenant and the anti-IDOR fence
// (RLS + foreign ids → "not found") is unchanged.

// The selector field added to a per-tenant tool's input schema, for SUPER_ADMIN tokens only.
export const tenantSelectorField = z
  .string()
  .describe(
    "Target tenant for THIS call: a slug or numeric id from tenant_list. Required because this is a " +
      "fleet-level (SUPER_ADMIN) token; tenant-scoped tokens omit it (their tenant is implicit).",
  );

export type EffectivePrincipal =
  | { ok: true; eff: VerifiedToken }
  | { ok: false; error: string };

// Resolve the effective principal for a per-tenant MCP tool call:
//   - tenant-scoped token → the principal itself (the `tenant` arg, if any, is ignored);
//   - SUPER_ADMIN token → require `tenant`, resolve it to an id, and return {...principal, tenantId}.
// A missing or unknown `tenant` is a graceful error (the wrapper turns it into an isError result),
// never a throw.
export async function resolveEffectivePrincipal(
  principal: VerifiedToken,
  args: { tenant?: unknown },
  base?: PrismaClient,
): Promise<EffectivePrincipal> {
  if (principal.role !== "SUPER_ADMIN") return { ok: true, eff: principal };

  const selector = typeof args.tenant === "string" ? args.tenant.trim() : "";
  if (!selector) {
    return {
      ok: false,
      error:
        "This is a fleet-level SUPER_ADMIN token: pass `tenant` (a slug or id from tenant_list) to choose which tenant this call targets.",
    };
  }
  try {
    const tenant = await resolveTenantSelector(selector, base);
    // biome-ignore lint/plugin/no-bigint-cast: the id of a row already loaded, re-read off its DTO.
    return { ok: true, eff: { ...principal, tenantId: BigInt(tenant.id) } };
  } catch {
    return {
      ok: false,
      error: `No tenant matches "${selector}". Run tenant_list to see the valid slugs/ids.`,
    };
  }
}
