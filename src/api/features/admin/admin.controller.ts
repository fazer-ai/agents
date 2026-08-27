import { Elysia, t } from "elysia";
import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import {
  createInvite,
  InviteEmailInUseError,
  InviteNotFoundError,
  listInvites,
  revokeInvite,
} from "@/api/features/invitations/invitation.service";
import { type AuthUser, authPlugin } from "@/api/lib/auth";
import { translate } from "@/api/lib/i18n";
import { doc, errors } from "@/api/lib/openapi";
import { parseQueryCount, parseQueryId } from "@/api/lib/query-filters";
import config from "@/config";
import { requireDbId } from "@/lib/db-id";
import { UnauthorizedError } from "@/lib/errors";
import {
  CannotDeleteSelfError,
  deleteUser,
  getAdminStats,
  getUsers,
  LastAdminError,
  listTenantsWithUserCounts,
  UserNotInScopeError,
  updateUserRole,
} from "./admin.service";

// One-time accept link (no mailer); the admin copies/sends it.
function acceptUrl(token: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}/accept-invite?token=${token}`;
}

// Resolves the tenant scope for a read/filter. A SUPER_ADMIN chooses explicitly via the
// `tenantId` param (the Users-tab filter); omitting it means fleet-wide (all tenants). Everyone
// else is forced to their own tenant — the param is ignored (never a cross-tenant read).
function resolveScope(
  user: AuthUser,
  paramTenantId: string | undefined,
): bigint | null {
  if (user.role === "SUPER_ADMIN") {
    // NOTE: `=== undefined`, not truthiness. `?tenantId=` is what the Users-tab filter submits when
    // its select is cleared, and reading it as "no filter" answers a request narrowed to one tenant
    // with the WHOLE FLEET. And `parseQueryId`, never `BigInt`: that spelling accepts an id past
    // 2^63-1 and lets Postgres answer the malformed value with a 500.
    if (paramTenantId === undefined) return null;
    return parseQueryId(paramTenantId, "tenantId") ?? null;
  }
  return user.tenantId;
}

export const adminController = new Elysia({
  prefix: "/admin",
  tags: ["Admin"],
})
  .use(authPlugin)
  .guard({ requireAdmin: true })
  // Full tenant list (Tenants tab) — SUPER_ADMIN only.
  .get(
    "/tenants",
    async () => {
      const tenants = await listTenantsWithUserCounts();
      return { tenants };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List all tenants",
        "Return every tenant with its user count.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/stats",
    async ({ query, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) return { stats: { totalUsers: 0, adminCount: 0 } };
      const stats = await getAdminStats(resolveScope(user, query.tenantId));
      return { stats };
    },
    {
      query: t.Object({
        tenantId: t.Optional(
          t.String({
            description:
              "Tenant id (BigInt string) to scope the stats to; SUPER_ADMIN only, omit for fleet-wide.",
          }),
        ),
      }),
      detail: doc(
        "Admin stats",
        "Return user and admin counts for the resolved tenant scope.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .get(
    "/users",
    async ({ query, getAuthUser }) => {
      // The requireAdmin guard guarantees a user; throw (not a `{ error }` return) so the success
      // response stays a single shape and the treaty type for `data.users` is non-optional.
      const user = await getAuthUser();
      if (!user) throw new UnauthorizedError();
      const page = parseQueryCount(query.page, "page") ?? 1;
      const search = query.search?.trim() || undefined;
      const result = await getUsers(
        resolveScope(user, query.tenantId),
        page,
        search,
      );

      return {
        users: result.users.map((u) => ({
          ...u,
          id: u.id.toString(),
          tenantId: u.tenantId?.toString() ?? null,
        })),
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    },
    {
      query: t.Object({
        page: t.Optional(
          t.String({
            description: "Page number (1-based, as a string); defaults to 1.",
          }),
        ),
        search: t.Optional(
          t.String({
            description: "Case-insensitive filter on user name or email.",
          }),
        ),
        tenantId: t.Optional(
          t.String({
            description:
              "Tenant id (BigInt string) to scope the listing to; SUPER_ADMIN only, omit for fleet-wide.",
          }),
        ),
      }),
      detail: doc(
        "List users",
        "Return a paginated, optionally filtered list of users.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .patch(
    "/users/:id/role",
    async ({ params, body, set, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) {
        set.status = 401;
        return { error: translate("errors.unauthorized", "Unauthorized") };
      }
      // NOTE: the PARSED id, not the path segment. `parseDbId` accepts leading zeros, so `007`
      // addresses row 7 while failing string equality against `"7"`, and comparing the raw segment
      // let a caller past the guard that exists to stop them locking themselves out. Issue #371.
      const targetId = requireDbId(params.id);
      if (user.id === targetId && body.role === "AGENT") {
        set.status = 403;
        return {
          error: translate("errors.cannotDemoteSelf", "Cannot demote yourself"),
        };
      }
      try {
        // A SUPER_ADMIN may re-role across tenants (own tenant is null → unscoped updateMany);
        // a TENANT_ADMIN is fenced to its own tenant.
        const updated = await updateUserRole(
          user.tenantId,
          targetId,
          body.role,
        );
        return {
          user: {
            ...updated,
            id: updated.id.toString(),
            tenantId: updated.tenantId?.toString() ?? null,
          },
        };
      } catch (error) {
        if (error instanceof UserNotInScopeError) {
          set.status = 404;
          return {
            error: translate("errors.userNotFound", "User not found"),
          };
        }
        throw error;
      }
    },
    {
      params: t.Object({
        id: t.String({ description: "Target user id (BigInt string)." }),
      }),
      body: t.Object({
        role: t.Union([t.Literal("AGENT"), t.Literal("TENANT_ADMIN")], {
          description: "New role to assign to the user.",
        }),
      }),
      detail: doc(
        "Update user role",
        "Change a user's role within the caller's tenant scope.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // Permanently delete a user (within the caller's tenant scope). Step-up: the acting admin re-enters
  // their password. Refuses to delete yourself or the last admin of a scope.
  .delete(
    "/users/:id",
    async ({ params, body, set, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) {
        set.status = 401;
        return { error: translate("errors.unauthorized", "Unauthorized") };
      }
      const acting = await getUserById(user.id);
      if (
        !acting?.passwordHash ||
        !(await verifyPassword(body.password, acting.passwordHash))
      ) {
        set.status = 403;
        return {
          error: translate("errors.invalidPassword", "Incorrect password"),
        };
      }
      try {
        await deleteUser(
          resolveScope(user, undefined),
          requireDbId(params.id),
          user.id,
        );
        return { success: true };
      } catch (error) {
        if (error instanceof CannotDeleteSelfError) {
          set.status = 403;
          return {
            error: translate(
              "errors.cannotDeleteSelf",
              "You cannot delete yourself",
            ),
          };
        }
        if (error instanceof LastAdminError) {
          set.status = 409;
          return {
            error: translate(
              "errors.lastAdmin",
              "Cannot delete the last admin of this scope",
            ),
          };
        }
        if (error instanceof UserNotInScopeError) {
          set.status = 404;
          return { error: translate("errors.userNotFound", "User not found") };
        }
        throw error;
      }
    },
    {
      params: t.Object({
        id: t.String({ description: "Target user id (BigInt string)." }),
      }),
      body: t.Object({
        password: t.String({
          minLength: 1,
          description: "The acting admin's password (step-up confirmation).",
        }),
      }),
      detail: doc(
        "Delete user",
        "Permanently delete a user within the caller's tenant scope. Requires the acting admin's password; cannot delete yourself or the last admin.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  // Invite a user into a tenant. A SUPER_ADMIN targets one explicitly via body.tenantId (400 if
  // missing); a TENANT_ADMIN is FORCED to its own tenant (body.tenantId ignored). Role is
  // AGENT|TENANT_ADMIN only.
  .post(
    "/invitations",
    async ({ body, set, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) {
        set.status = 401;
        return { error: translate("errors.unauthorized", "Unauthorized") };
      }
      const targetTenantId =
        user.role === "SUPER_ADMIN"
          ? body.tenantId
            ? BigInt(body.tenantId)
            : null
          : user.tenantId;
      if (targetTenantId === null) {
        set.status = 400;
        return {
          error: translate(
            "errors.tenantTargetRequired",
            "A target tenant is required",
          ),
        };
      }
      try {
        const invite = await createInvite({
          tenantId: targetTenantId,
          email: body.email,
          role: body.role,
          invitedById: user.id,
        });
        return {
          invite: {
            id: invite.id.toString(),
            email: invite.email,
            role: invite.role,
            acceptUrl: acceptUrl(invite.token),
            expiresAt: invite.expiresAt,
          },
        };
      } catch (error) {
        if (error instanceof InviteEmailInUseError) {
          set.status = 409;
          return {
            error: translate("errors.emailInUse", "Email already in use"),
          };
        }
        throw error;
      }
    },
    {
      body: t.Object({
        email: t.String({
          format: "email",
          maxLength: 254,
          description: "Email address to invite.",
        }),
        role: t.Union([t.Literal("AGENT"), t.Literal("TENANT_ADMIN")], {
          description: "Role granted to the invitee.",
        }),
        tenantId: t.Optional(
          t.String({
            description:
              "Target tenant id (BigInt string); required for SUPER_ADMIN, ignored for tenant admins.",
          }),
        ),
      }),
      detail: doc(
        "Create invitation",
        "Invite a user into a tenant and return an accept link.",
      ),
      response: errors(400, 401, 403, 409, 422),
    },
  )
  .get(
    "/invitations",
    async ({ query, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) return { invitations: [] };
      const invitations = await listInvites(resolveScope(user, query.tenantId));
      return { invitations };
    },
    {
      query: t.Object({
        tenantId: t.Optional(
          t.String({
            description:
              "Tenant id (BigInt string) to scope the listing to; SUPER_ADMIN only, omit for fleet-wide.",
          }),
        ),
      }),
      detail: doc(
        "List invitations",
        "Return pending invitations for the resolved tenant scope.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .delete(
    "/invitations/:id",
    async ({ params, set, getAuthUser }) => {
      const user = await getAuthUser();
      try {
        // SUPER_ADMIN may revoke any invite (own tenant null → unscoped); others are fenced.
        await revokeInvite(user?.tenantId ?? null, requireDbId(params.id));
        return { success: true };
      } catch (error) {
        if (error instanceof InviteNotFoundError) {
          set.status = 404;
          return {
            error: translate("errors.inviteNotFound", "Invitation not found"),
          };
        }
        throw error;
      }
    },
    {
      params: t.Object({
        id: t.String({ description: "Invitation id (BigInt string)." }),
      }),
      detail: doc(
        "Revoke invitation",
        "Delete a pending invitation within the caller's scope.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
