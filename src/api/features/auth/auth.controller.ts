import { Elysia, t } from "elysia";
import * as jose from "jose";
import {
  changeUserPassword,
  createInitialAdmin,
  createUser,
  getTenantName,
  getUserByEmail,
  getUserHasPassword,
  hashPassword,
  IncorrectPasswordError,
  isEmailDomainAllowed,
  NoPasswordSetError,
  resolveDefaultTenantId,
  SetupAlreadyCompleteError,
  updateLastLogin,
  verifyPassword,
} from "@/api/features/auth/auth.service";
import {
  GoogleAdminLinkBlockedError,
  GoogleEmailDomainNotAllowedError,
  GoogleEmailNotVerifiedError,
  GoogleIdMismatchError,
  GoogleRegistrationDisabledError,
  upsertGoogleUser,
  verifyGoogleIdToken,
} from "@/api/features/auth/google.service";
import {
  completeSetup,
  isSetupRequired,
  isSetupTokenRequired,
  refreshSetupState,
  verifySetupToken,
} from "@/api/features/auth/setup.service";
import {
  acceptInvite,
  findValidInviteByToken,
  InviteEmailInUseError,
  InviteInvalidError,
} from "@/api/features/invitations/invitation.service";
import { authPlugin } from "@/api/lib/auth";
import { translate } from "@/api/lib/i18n";
import logger from "@/api/lib/logger";
import { doc, errors, jsonResponse } from "@/api/lib/openapi";
import config from "@/config";

const baseAuthController = new Elysia({
  prefix: "/auth",
  tags: ["Auth"],
})
  .use(authPlugin)
  .post(
    "/setup",
    async ({ body, set, setAuthCookie }) => {
      // NOTE: Self-heal a stale `setupComplete=false` on this replica before
      // gating, so an operator routed to a stale instance gets a clean 409
      // (and a path off /setup on the frontend) instead of a permanent 401
      // from the local-token mismatch.
      await refreshSetupState();

      if (!isSetupRequired()) {
        set.status = 409;
        return {
          error: translate(
            "errors.setupAlreadyComplete",
            "Initial setup has already been completed",
          ),
        };
      }

      if (!verifySetupToken(body.token)) {
        set.status = 401;
        return {
          error: translate(
            "errors.invalidSetupToken",
            "Invalid or missing setup token",
          ),
        };
      }

      const passwordHash = await hashPassword(body.password);

      let user: Awaited<ReturnType<typeof createInitialAdmin>>["user"];
      let tenantId: bigint;
      try {
        ({ user, tenantId } = await createInitialAdmin({
          email: body.email,
          passwordHash,
          name: body.name?.trim() || null,
          companyName: body.companyName?.trim() || null,
        }));
      } catch (error) {
        if (error instanceof SetupAlreadyCompleteError) {
          completeSetup();
          set.status = 409;
          return {
            error: translate(
              "errors.setupAlreadyComplete",
              "Initial setup has already been completed",
            ),
          };
        }
        throw error;
      }

      completeSetup();
      await setAuthCookie(user);
      // NOTE: Log non-PII identifiers only. `userId` is stable and audit-
      // useful, `role` confirms this was the bootstrap-ADMIN path. The email
      // is recoverable from the DB by joining on userId if needed.
      logger.info(
        { userId: user.id.toString(), role: user.role },
        "Initial admin account created via first-run setup",
      );

      return {
        user: {
          id: user.id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId === null ? null : user.tenantId.toString(),
        },
        // NOTE: The SUPER_ADMIN's tenantId is null (fleet-level). Hand back the freshly created
        // tenant so the client can seed the active-tenant selector synchronously and avoid the
        // empty-dashboard first paint.
        defaultTenantId: tenantId.toString(),
      };
    },
    {
      body: t.Object({
        // NOTE: maxLength caps the unauthenticated body surface so a single
        // request can't pin an arbitrary amount of memory before validation
        // kicks in. Email cap matches RFC 5321; password cap is generous
        // (bcrypt truncates at 72 bytes regardless); name/token/company are bounded.
        email: t.String({
          format: "email",
          maxLength: 254,
          description: "Initial admin email address.",
        }),
        password: t.String({
          minLength: 8,
          maxLength: 256,
          description: "Initial admin password (minimum 8 characters).",
        }),
        name: t.Optional(
          t.String({
            maxLength: 200,
            description: "Optional admin display name.",
          }),
        ),
        companyName: t.Optional(
          t.String({
            maxLength: 200,
            description: "Optional company name used to seed the first tenant.",
          }),
        ),
        token: t.Optional(
          t.String({
            maxLength: 256,
            description:
              "Opaque setup token, required when SETUP_TOKEN_REQUIRED is enabled.",
          }),
        ),
      }),
      detail: {
        ...doc(
          "First-run setup",
          "Creates the initial admin account during first-run setup and logs it in. Bypasses signup gates; only works while no users exist.",
        ),
        security: [],
      },
      response: errors(400, 401, 409, 422),
    },
  )
  .post(
    "/signup",
    async ({ body, set, setAuthCookie }) => {
      // NOTE: The first account can only be created via /setup (always ADMIN),
      // and public registration is opt-in via SIGNUP_ENABLED. Both gates return
      // the same generic 403 so this endpoint stays closed by default.
      if (isSetupRequired() || !config.signupEnabled) {
        set.status = 403;
        return {
          error: translate("errors.signupDisabled", "Sign-ups are disabled"),
        };
      }

      const { email, password } = body;

      // NOTE: Look up the existing user first so users on a domain that was
      // later removed from ALLOWED_SIGNUP_DOMAINS still get the accurate
      // "email already in use" response instead of a misleading domain error.
      const existingUser = await getUserByEmail(email);
      if (existingUser) {
        set.status = 400;
        return {
          error: translate("errors.emailInUse", "Email already in use"),
        };
      }

      if (!isEmailDomainAllowed(email)) {
        set.status = 400;
        return {
          error: translate(
            "errors.emailDomainNotAllowed",
            "Email domain is not allowed",
          ),
        };
      }

      // NOTE: a self-signup user must join a tenant; with none provisioned, keep the
      // endpoint closed rather than create a tenant-less account.
      const tenantId = await resolveDefaultTenantId();
      if (tenantId === null) {
        set.status = 403;
        return {
          error: translate("errors.signupDisabled", "Sign-ups are disabled"),
        };
      }

      const passwordHash = await hashPassword(password);
      const user = await createUser(email, passwordHash, tenantId);

      await setAuthCookie(user);

      return {
        user: {
          id: user.id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId === null ? null : user.tenantId.toString(),
        },
      };
    },
    {
      body: t.Object({
        email: t.String({
          format: "email",
          description: "New account email address.",
        }),
        password: t.String({
          minLength: 8,
          description: "New account password (minimum 8 characters).",
        }),
      }),
      detail: {
        ...doc(
          "Public sign-up",
          "Creates a new user account and logs it in. Disabled by default; requires SIGNUP_ENABLED and a domain allowed by ALLOWED_SIGNUP_DOMAINS.",
        ),
        security: [],
      },
      response: errors(400, 403, 422),
    },
  )
  .post(
    "/login",
    async ({ body, set, setAuthCookie }) => {
      const { email, password } = body;

      const user = await getUserByEmail(email);
      if (!user?.passwordHash) {
        set.status = 401;
        return {
          error: translate(
            "errors.invalidCredentials",
            "Invalid email or password",
          ),
        };
      }

      const isValidPassword = await verifyPassword(password, user.passwordHash);
      if (!isValidPassword) {
        set.status = 401;
        return {
          error: translate(
            "errors.invalidCredentials",
            "Invalid email or password",
          ),
        };
      }

      await setAuthCookie(user);
      void updateLastLogin(user.id).catch((error) => {
        logger.warn(
          { error, userId: user.id.toString() },
          "Failed to update last login",
        );
      });

      return {
        user: {
          id: user.id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId === null ? null : user.tenantId.toString(),
        },
      };
    },
    {
      body: t.Object({
        email: t.String({
          format: "email",
          description: "Account email address.",
        }),
        password: t.String({
          minLength: 8,
          description: "Account password (minimum 8 characters).",
        }),
      }),
      detail: {
        ...doc(
          "Password login",
          "Verifies email and password, sets the auth cookie, and returns the user. Returns 401 on invalid credentials.",
        ),
        security: [],
      },
      response: errors(400, 401, 422),
    },
  )
  .get(
    "/me",
    async ({ getAuthUser }) => {
      const user = await getAuthUser();
      const providers = config.googleOAuthEnabled
        ? { google: { clientId: config.googleClientId } }
        : {};
      // The non-super user's tenant name (for the header chip). SUPER_ADMIN shows the selected
      // tenant instead (resolved client-side from the tenant list), so it stays null here.
      const tenantName =
        user && user.tenantId !== null
          ? await getTenantName(user.tenantId)
          : null;

      // NOTE: Only the SUPER_ADMIN (tenantId null) drives a client-side active-tenant selector; for
      // everyone else the tenant is fixed on the row. Hand back the first accessible tenant so the
      // client can seed the selector on first login/reload instead of dead-ending on an empty state.
      const defaultTenantId =
        user && user.role === "SUPER_ADMIN" && user.tenantId === null
          ? await resolveDefaultTenantId()
          : null;

      // Whether the account can change its password locally (false for Google-only users) — drives the
      // settings form vs the "you sign in with Google" note.
      const hasPassword = user ? await getUserHasPassword(user.id) : false;

      return {
        user: user
          ? {
              id: user.id.toString(),
              email: user.email,
              name: user.name,
              role: user.role,
              tenantId:
                user.tenantId === null ? null : user.tenantId.toString(),
              tenantName,
              hasPassword,
            }
          : null,
        providers,
        setupRequired: isSetupRequired(),
        setupTokenRequired: isSetupTokenRequired(),
        signupEnabled: config.signupEnabled,
        // Whether stdio MCP transport is enabled server-side (config.mcpStdioEnabled). Surfaced so the
        // MCP connection form can clearly flag a stdio server as inert when the operator has it off.
        mcpStdioEnabled: config.mcpStdioEnabled,
        defaultTenantId:
          defaultTenantId === null ? null : defaultTenantId.toString(),
      };
    },
    {
      detail: {
        ...doc(
          "Current session and auth state",
          "Returns the authenticated user (or null when anonymous) plus auth state flags: setupRequired, setupTokenRequired, signupEnabled, providers, and the default tenant id. Safe to call without a session.",
        ),
        security: [],
        responses: {
          200: jsonResponse(
            "Session and auth state. `user` is null when anonymous; the flags describe setup, signup and provider availability.",
          ),
        },
      },
    },
  )
  // Change the authenticated user's own password (verify current, store new). Google-only accounts
  // get a 400 (no local password); a wrong current password is a 400 (not 401) so it doesn't trip
  // the client's session-expired handling.
  .patch(
    "/password",
    async ({ body, set, getAuthUser }) => {
      const user = await getAuthUser();
      if (!user) {
        set.status = 401;
        return { error: translate("errors.unauthorized", "Unauthorized") };
      }
      try {
        await changeUserPassword(
          user.id,
          body.currentPassword,
          body.newPassword,
        );
      } catch (error) {
        if (error instanceof NoPasswordSetError) {
          set.status = 400;
          return {
            error: translate(
              "errors.passwordChangeUnavailable",
              "Password change is not available for this account",
            ),
          };
        }
        if (error instanceof IncorrectPasswordError) {
          set.status = 400;
          return {
            error: translate(
              "errors.currentPasswordIncorrect",
              "Current password is incorrect",
            ),
          };
        }
        throw error;
      }
      return { success: true };
    },
    {
      body: t.Object({
        currentPassword: t.String({
          minLength: 1,
          maxLength: 256,
          description:
            "The account's current password, verified before the change.",
        }),
        newPassword: t.String({
          minLength: 8,
          maxLength: 256,
          description: "The new password (minimum 8 characters).",
        }),
      }),
      detail: doc(
        "Change own password",
        "Verifies the current password and stores a new one for the authenticated user. Returns 400 for Google-only accounts (no local password) or an incorrect current password.",
      ),
      response: errors(400, 401, 422),
    },
  )
  // ── invitation acceptance (public: the invitee has no account yet) ──
  // Validate a token to pre-fill the accept form. Returns a generic 404 for any
  // missing/expired/used token so live tokens can't be distinguished.
  .get(
    "/invite",
    async ({ query, set }) => {
      const invite = await findValidInviteByToken(query.token);
      if (!invite) {
        set.status = 404;
        return {
          error: translate(
            "errors.inviteInvalid",
            "Invitation is invalid or has expired",
          ),
        };
      }
      return { invite: { email: invite.email, role: invite.role } };
    },
    {
      query: t.Object({
        token: t.String({
          minLength: 1,
          maxLength: 256,
          description: "Opaque invitation token from the invite link.",
        }),
      }),
      detail: {
        ...doc(
          "Validate invitation token",
          "Validates an invitation token and returns the invited email and role to pre-fill the accept form. Returns a generic 404 for any missing, expired, or used token.",
        ),
        security: [],
      },
      response: errors(400, 404, 422),
    },
  )
  // Consume the invite: create the user (tenant + role bound to the invite row, never the
  // request) and auto-login. Bypasses SIGNUP_ENABLED / ALLOWED_SIGNUP_DOMAINS BY DESIGN — an
  // invite is explicit authorization by an admin, like the /setup operator bypass.
  .post(
    "/accept-invite",
    async ({ body, set, setAuthCookie }) => {
      let user: Awaited<ReturnType<typeof acceptInvite>>;
      try {
        user = await acceptInvite({
          token: body.token,
          password: body.password,
          name: body.name?.trim() || null,
        });
      } catch (error) {
        if (error instanceof InviteInvalidError) {
          set.status = 410;
          return {
            error: translate(
              "errors.inviteInvalid",
              "Invitation is invalid or has expired",
            ),
          };
        }
        if (error instanceof InviteEmailInUseError) {
          set.status = 409;
          return {
            error: translate("errors.emailInUse", "Email already in use"),
          };
        }
        throw error;
      }
      await setAuthCookie(user);
      logger.info(
        { userId: user.id.toString(), role: user.role },
        "User account created via invitation",
      );
      return {
        user: {
          id: user.id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId === null ? null : user.tenantId.toString(),
        },
      };
    },
    {
      body: t.Object({
        token: t.String({
          minLength: 1,
          maxLength: 256,
          description: "Opaque invitation token from the invite link.",
        }),
        password: t.String({
          minLength: 8,
          maxLength: 256,
          description: "Password for the new account (minimum 8 characters).",
        }),
        name: t.Optional(
          t.String({
            maxLength: 200,
            description: "Optional display name for the new account.",
          }),
        ),
      }),
      detail: {
        ...doc(
          "Accept invitation",
          "Consumes an invitation token to create the user (tenant and role bound to the invite row) and logs it in. Bypasses signup gates by design. Returns 410 for an invalid or expired invite and 409 if the email is already in use.",
        ),
        security: [],
      },
      response: errors(400, 409, 410, 422),
    },
  )
  .post(
    "/logout",
    ({ clearAuthCookie }) => {
      clearAuthCookie();
      return { success: true };
    },
    {
      detail: {
        ...doc(
          "Log out",
          "Clears the authentication cookie for the current session.",
        ),
        security: [],
        responses: {
          200: jsonResponse(
            "The auth cookie was cleared.",
            t.Object({ success: t.Literal(true) }),
          ),
        },
      },
    },
  );

const googleAuthController = baseAuthController.post(
  "/google",
  async ({ body, set, setAuthCookie }) => {
    try {
      const profile = await verifyGoogleIdToken(body.credential);
      const user = await upsertGoogleUser(profile);
      await setAuthCookie(user);
      void updateLastLogin(user.id).catch((error) => {
        logger.warn(
          { error, userId: user.id.toString() },
          "Failed to update last login",
        );
      });

      return {
        user: {
          id: user.id.toString(),
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId === null ? null : user.tenantId.toString(),
        },
      };
    } catch (error) {
      if (error instanceof GoogleEmailDomainNotAllowedError) {
        logger.warn({ error }, "Google sign-in rejected: domain blocked");
        set.status = 400;
        return {
          error: translate(
            "errors.emailDomainNotAllowed",
            "Email domain is not allowed",
          ),
        };
      }
      // NOTE: Distinct 403 (vs the generic 401 below) is safe here: this error
      // only fires on the new-account path, so it cannot leak whether an
      // existing account is present or how it is linked.
      if (error instanceof GoogleRegistrationDisabledError) {
        logger.warn({ error }, "Google sign-in rejected: registration closed");
        set.status = 403;
        return {
          error: translate("errors.signupDisabled", "Sign-ups are disabled"),
        };
      }
      // NOTE: GoogleEmailNotVerifiedError, GoogleIdMismatchError,
      // GoogleAdminLinkBlockedError, and jose's JWT/JWS verification failures
      // all map to a generic 401 so we don't leak whether an account exists,
      // how it is linked, or that it has elevated privileges.
      if (
        error instanceof GoogleEmailNotVerifiedError ||
        error instanceof GoogleIdMismatchError ||
        error instanceof GoogleAdminLinkBlockedError ||
        error instanceof jose.errors.JOSEError
      ) {
        logger.warn({ error }, "Google sign-in rejected");
        set.status = 401;
        return {
          error: translate(
            "errors.googleSignInFailed",
            "Google sign-in failed",
          ),
        };
      }
      // NOTE: Unexpected operational failures (Prisma, JWKS network, cookie
      // signing, etc.) bubble up so they surface as 5xx instead of getting
      // misreported as bad credentials.
      logger.error({ error }, "Unexpected error during Google sign-in");
      throw error;
    }
  },
  {
    body: t.Object({
      credential: t.String({
        minLength: 1,
        description:
          "Google Identity Services ID token (JWT credential) from the client.",
      }),
    }),
    detail: {
      ...doc(
        "Google sign-in",
        "Verifies a Google ID token and signs the user in, creating the account on first sign-in (subject to signup and domain gates). Returns 400 for a blocked domain, 403 when registration is closed, and a generic 401 for any other verification failure.",
      ),
      security: [],
    },
    response: errors(400, 401, 403, 422),
  },
);

// NOTE: When Google OAuth is disabled, the `/google` route is not registered at
// all so schema validation never runs and Elysia returns its standard 404.
// The exported type is always the enabled-mode controller so that the
// generated treaty client keeps `auth.google.post(...)` available; the
// frontend already gates calls behind `providers.google`.
export const authController: typeof googleAuthController =
  config.googleOAuthEnabled
    ? googleAuthController
    : (baseAuthController as unknown as typeof googleAuthController);
