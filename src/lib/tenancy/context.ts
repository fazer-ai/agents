import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, UserRole } from "@/../generated/prisma/client";

export type ActorType = "user" | "api_key" | "mcp" | "system";

export interface TenantContext {
  // NOTE: null only for SUPER_ADMIN operating fleet-wide. A tenant-scoped op with a
  // null tenantId fails closed (TenantTargetRequiredError).
  tenantId: bigint | null;
  userId: bigint | null;
  role: UserRole;
  // How the request authenticated. Absent (treated as "user") for the cookie session; "api_key"
  // when a Bearer API key resolved the principal; "mcp" behind an MCP access token; "system" for a
  // mutation no request asked for. Used only for audit attribution.
  //
  // NOTE: this is what lets the ACTION name what changed instead of naming the door it came
  // through. `mcp.agent_update` and a console PATCH are the same change, and they are the same
  // action, told apart here.
  actorType?: ActorType;
}

// NOTE: branded transaction client. Only the TenancyProvider (runScoped/asSuperAdmin)
// produces a value of this type, so passing the base `prisma` into a service that
// expects a ScopedDb does not type-check. The brand symbol is intentionally unexported.
declare const scopedDbBrand: unique symbol;
export type ScopedDb = Prisma.TransactionClient & {
  readonly [scopedDbBrand]: "ScopedDb";
};

const storage = new AsyncLocalStorage<TenantContext>();

// NOTE: always via run() (never enterWith), so the context cannot leak between sibling
// async continuations sharing the event loop.
export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("No tenant context in scope");
  }
  return ctx;
}
