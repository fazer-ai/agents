// Single source of truth for the role hierarchy: SUPER_ADMIN > TENANT_ADMIN > AGENT.
// Pure (only a type-only import, erased in the browser bundle) so server code, the React
// client, and CLI scripts can all share it. Adding a new role here is the only place its
// rank is defined; every gate compares by rank, never by an ad-hoc `!== "AGENT"`.

import type { UserRole } from "@/../generated/prisma/client";

export const ROLE_RANK: Record<UserRole, number> = {
  AGENT: 1,
  TENANT_ADMIN: 2,
  SUPER_ADMIN: 3,
};

// Accepts a loose string (JWT/treaty values arrive as strings); an unknown role
// ranks 0 (below everything) so it is fail-closed.
export function roleAtLeast(
  role: string | null | undefined,
  min: UserRole,
): boolean {
  return (ROLE_RANK[(role ?? "") as UserRole] ?? 0) >= ROLE_RANK[min];
}

// "admin" means any elevated role (tenant admin or fleet super admin).
export function isAdminRole(role: string | null | undefined): boolean {
  return roleAtLeast(role, "TENANT_ADMIN");
}
