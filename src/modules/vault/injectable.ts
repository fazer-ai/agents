import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ensureFreshGoogleAccessToken } from "./google-oauth";
import { ensureFreshMcpAccessToken } from "./mcp-oauth";
import { tryResolveVaultEntry } from "./service";

// Resolves a credential ref into what an outbound request injects. One resolver for every caller
// that sends a vault secret to a third party (HTTP tools, MCP connections, the contact authorization
// check), so they all agree on the two things that are easy to get wrong: a PENDING or missing entry
// resolves to nothing rather than to a placeholder, and the managed-OAuth kinds (`google_oauth`,
// `mcp_oauth`) hand out a FRESH access token instead of the stored JSON blob. The refresh paths do
// their own scoped reads/writes plus a network call OUTSIDE any caller tx, so this must never be
// invoked inside one.

export interface InjectableCredential {
  // The string to send: the stored secret, or the refreshed access token for a managed-OAuth kind.
  value: string;
  // The entry's secret type, which names HOW it is sent (resolveSecretInjection). null = generic.
  kind: string | null;
  // Header/query name for the kinds whose name the operator supplies (VaultEntry.paramName).
  paramName: string | null;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export async function resolveInjectableCredentialEntry(
  base: PrismaClient,
  tenantId: bigint,
  ref: string,
): Promise<InjectableCredential | null> {
  const entry = await runScopedOn(base, sysCtx(tenantId), (db) =>
    tryResolveVaultEntry<unknown>(db, ref),
  );
  if (!entry) return null;
  if (entry.kind === "google_oauth" || entry.kind === "mcp_oauth") {
    const id = ref.startsWith("vault:")
      ? BigInt(ref.slice("vault:".length))
      : null;
    if (id === null) return null;
    const value =
      entry.kind === "mcp_oauth"
        ? await ensureFreshMcpAccessToken(sysCtx(tenantId), id, base)
        : await ensureFreshGoogleAccessToken(sysCtx(tenantId), id, base);
    return { value, kind: entry.kind, paramName: entry.paramName };
  }
  return typeof entry.secret === "string"
    ? { value: entry.secret, kind: entry.kind, paramName: entry.paramName }
    : null;
}

// The injectable string alone, for callers that apply their own injection rule. null when the
// entry is missing, pending, or does not hold a string secret.
export async function resolveInjectableCredential(
  base: PrismaClient,
  tenantId: bigint,
  ref: string,
): Promise<string | null> {
  const entry = await resolveInjectableCredentialEntry(base, tenantId, ref);
  return entry?.value ?? null;
}
