import { Elysia, t } from "elysia";
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
import {
  confirmStepUp,
  requireSession,
  STEP_UP_PASSWORD_DESCRIPTION,
  stepUpPrincipalOf,
} from "@/api/lib/step-up";
import config from "@/config";
import { optionalDbId, requireDbId } from "@/lib/db-id";
import { UnauthorizedError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  AlreadySuperAdminError,
  addSuperAdmin,
  CannotDeleteSelfError,
  ConcurrentMoveError,
  deleteUser,
  getAdminStats,
  getUsers,
  LastAdminError,
  listTenantsWithUserCounts,
  previewSuperAdmin,
  TenantNotChangeableError,
  TenantNotFoundError,
  TenantRequiredError,
  UserNotInScopeError,
  updateUserRole,
} from "./admin.service";

// One-time accept link (no mailer); the admin copies/sends it.
function acceptUrl(token: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}/accept-invite?token=${token}`;
}

// The principal these writes act as, built from the SESSION and never from the tenancy plugin.
// `tenantId` is the tenant the caller's session runs under (their selected membership, resolved in
// `getAuthUser`), null for a SUPER_ADMIN, the same scope `resolveScope(user, undefined)` gives the
// reads. Mounting `tenancyPlugin` would hand these routes the `X-Tenant-Id` SELECTOR instead, and a
// fleet admin with a tenant open in one tab would silently lose the ability to re-role anyone outside
// it. `actorType` is supplied as that plugin does elsewhere: without it a Bearer API key's writes
// would all record as a cookie session.
function actorOf(user: AuthUser): TenantContext {
  return {
    tenantId: user.tenantId,
    userId: user.id,
    role: user.role,
    actorType: user.isApiKey ? "api_key" : "user",
  };
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
          memberships: u.memberships.map((m) => ({
            tenantId: m.tenantId.toString(),
            role: m.role,
          })),
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
      // The PARSED id, not the path segment. `parseDbId` accepts leading zeros, so `007`
      // addresses row 7 while failing string equality against `"7"`, and comparing the raw segment
      // would let a caller past the guard that stops them locking themselves out.
      const targetId = requireDbId(params.id);
      // NOTE: ANY self role change, not just the demote to AGENT: a fleet administrator naming a
      // tenant can make themselves that tenant's admin, and the next authentication lookup takes their
      // fleet access away for good. Nobody re-roles themselves here.
      if (user.id === targetId) {
        set.status = 403;
        return {
          error: translate("errors.cannotDemoteSelf", "Cannot demote yourself"),
        };
      }
      try {
        // A SUPER_ADMIN may re-role across tenants (tenant null → any membership); a TENANT_ADMIN
        // is fenced to the tenant their session runs under.
        const updated = await updateUserRole(actorOf(user), targetId, {
          role: body.role,
          tenantId: optionalDbId(body.tenantId),
          demoteFleet: body.demoteFleet === true,
        });
        return {
          user: {
            ...updated,
            id: updated.id.toString(),
            tenantId: updated.tenantId?.toString() ?? null,
          },
        };
      } catch (error) {
        // NOTE: a fleet administrator's demotion is only storable with a tenant named, so an unnamed
        // one is the request being wrong (422), never the server failing. The three below are the
        // same idea: the row the write would produce cannot exist, and each says which half is wrong.
        if (error instanceof ConcurrentMoveError) {
          set.status = 409;
          return {
            error: translate(
              "errors.userMovedConcurrently",
              "This account was being changed by somebody else; try again",
            ),
          };
        }
        if (error instanceof TenantRequiredError) {
          set.status = 422;
          return {
            error: translate(
              "errors.demoteNeedsTenant",
              "Choose the tenant this role change applies to",
            ),
          };
        }
        if (error instanceof TenantNotChangeableError) {
          set.status = 422;
          return {
            error: translate(
              "errors.roleChangeCannotMoveTenant",
              "A tenant administrator's role change cannot name another tenant",
            ),
          };
        }
        if (error instanceof TenantNotFoundError) {
          set.status = 404;
          return {
            error: translate("errors.tenantNotFound", "Tenant not found"),
          };
        }
        // NOTE: the same invariant the delete answers with a 409, on the write that reduces the
        // scope's administrator count without removing anybody.
        if (error instanceof LastAdminError) {
          set.status = 409;
          return {
            error: translate(
              "errors.lastAdminRole",
              "Cannot demote the last admin of this scope",
            ),
          };
        }
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
        tenantId: t.Optional(
          t.String({
            description:
              "Tenant the role applies to (BigInt string). A person holds a role per tenant, so the fleet names which membership to re-role (optional when the person has only one), and demoting a fleet administrator names the tenant they join (required). A tenant administrator may only name their own tenant.",
          }),
        ),
        demoteFleet: t.Optional(
          t.Boolean({
            description:
              "SUPER_ADMIN only: take the fleet role away. A person who already belongs to a tenant keeps every membership as it is and names no tenant; a person with none must name the tenant they join, with `role`. Without it, the write re-roles a membership and never touches the fleet role.",
          }),
        ),
      }),
      detail: doc(
        "Update user role",
        "Change the role a user holds in a tenant. A tenant administrator re-roles members of their own tenant; the fleet names the tenant (or the user's only one). Demoting a fleet administrator is explicit (`demoteFleet`): a person with memberships keeps them and names no tenant, a person with none must name the tenant they join. Refuses (409) to demote the last administrator of a scope.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  // Remove a user: from the caller's tenant for a tenant admin, the whole account for the fleet. Step-up (`confirmStepUp`): the
  // acting admin re-enters their password; a Bearer key answers by itself. Refuses to delete yourself
  // or the last admin of a scope.
  .delete(
    "/users/:id",
    async ({ params, body, set, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) {
        set.status = 401;
        return { error: translate("errors.unauthorized", "Unauthorized") };
      }
      await confirmStepUp(stepUpPrincipalOf(user), body.password);
      try {
        await deleteUser(actorOf(user), requireDbId(params.id));
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
        password: t.Optional(
          t.String({ minLength: 1, description: STEP_UP_PASSWORD_DESCRIPTION }),
        ),
      }),
      detail: doc(
        "Delete user",
        "Remove a user. A tenant administrator removes the user from their own tenant (the account is deleted only when it was the user's last tenant); the fleet deletes the account. Requires the acting admin's password for a session (a Bearer API key needs none); cannot delete yourself or the last admin.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  // What "Add super admin" would do for an email, by exact match, so the confirmation step can say
  // it before asking for the password.
  .get(
    "/super-admins/preview",
    async ({ query, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) throw new UnauthorizedError();
      return { outcome: await previewSuperAdmin(actorOf(user), query.email) };
    },
    {
      requireRole: "SUPER_ADMIN",
      query: t.Object({
        email: t.String({
          format: "email",
          maxLength: 254,
          description: "Email of the person to make a super admin.",
        }),
      }),
      detail: doc(
        "Preview adding a super admin",
        "Say what adding this email as a super admin would do right now: `promote` (an account exists), `invite` (no account; a fleet invitation would be minted) or `already` (the person is already a super admin). Exact, case-insensitive match. A preview only; the write decides again.",
      ),
      response: errors(400, 401, 403, 422),
    },
  )
  // Make another person a SUPER_ADMIN, by email: an existing account is promoted at once, an email
  // with no account gets a one-day fleet invitation link. A person grants it, never a key (a key
  // would leave nobody behind the grant), and confirms with their password.
  .post(
    "/super-admins",
    async ({ body, set, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) throw new UnauthorizedError();
      requireSession(user);
      await confirmStepUp(stepUpPrincipalOf(user), body.password);
      try {
        const result = await addSuperAdmin(actorOf(user), body.email);
        if (result.kind === "promoted") {
          return {
            result: "promoted" as const,
            user: {
              id: result.user.id.toString(),
              email: result.user.email,
              name: result.user.name,
            },
          };
        }
        return {
          result: "invited" as const,
          invite: {
            id: result.invite.id.toString(),
            email: result.invite.email,
            acceptUrl: acceptUrl(result.invite.token),
            expiresAt: result.invite.expiresAt,
          },
        };
      } catch (error) {
        if (error instanceof AlreadySuperAdminError) {
          set.status = 409;
          return {
            error: translate(
              "errors.alreadySuperAdmin",
              "This person is already a super admin",
            ),
            field: "email",
          };
        }
        throw error;
      }
    },
    {
      requireRole: "SUPER_ADMIN",
      body: t.Object({
        email: t.String({
          format: "email",
          maxLength: 254,
          description: "Email of the person to make a super admin.",
        }),
        password: t.Optional(
          t.String({ minLength: 1, description: STEP_UP_PASSWORD_DESCRIPTION }),
        ),
      }),
      detail: doc(
        "Add a super admin",
        "Make a person a fleet super admin. An email that already has an account is promoted immediately and keeps its tenant memberships (`result: promoted`); an email with no account gets a single-use fleet invitation valid for 24 hours (`result: invited`, with the accept link). Requires a signed-in SUPER_ADMIN session and its password; refuses an API key. Returns 409 when the person is already a super admin.",
      ),
      response: errors(400, 401, 403, 409, 422),
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
          ? (optionalDbId(body.tenantId, "tenantId") ?? null)
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
        const invite = await createInvite(actorOf(user), {
          tenantId: targetTenantId,
          email: body.email,
          role: body.role,
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
            field: "email",
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
      if (!user) throw new UnauthorizedError();
      try {
        // SUPER_ADMIN may revoke any invite (own tenant null → unscoped); others are fenced.
        await revokeInvite(actorOf(user), requireDbId(params.id));
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
