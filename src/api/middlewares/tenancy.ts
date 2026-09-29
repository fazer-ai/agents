import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import logger from "@/api/lib/logger";
import { requireDbId } from "@/lib/db-id";
import { resolveRequestTenantContext } from "@/lib/tenancy";

// Elysia boundary that turns the authenticated user + X-Tenant-Id selector into a
// TenantContext. Services/handlers then pass it to runScoped/asSuperAdmin — they never
// read tenant from anywhere else. Depends on authPlugin for getAuthUser.
export const tenancyPlugin = new Elysia({ name: "tenancy" })
  .use(authPlugin)
  .derive({ as: "global" }, async ({ getAuthUser, headers }) => {
    const user = await getAuthUser();
    const { context, anomaly, malformedSelector } = resolveRequestTenantContext(
      user,
      headers["x-tenant-id"],
    );
    // NOTE: refused here, not folded into "no target": it is the same refusal a malformed path id
    // gets, since the value names a row and does not spell one. Folding it in lets a mistyped
    // selector answer 200 on some routes.
    if (malformedSelector !== undefined) {
      requireDbId(malformedSelector, "X-Tenant-Id");
    }
    // NOTE: tag audit attribution when the principal came from a Bearer API key (vs the cookie
    // session), and carry the step-up the key was, or was not, minted under, for `confirmStepUp`.
    if (context && user?.isApiKey) {
      context.actorType = "api_key";
      context.stepUpAt = user.stepUpAt ?? null;
    }
    if (anomaly && user) {
      logger.warn(
        { userId: user.id.toString() },
        "Ignoring X-Tenant-Id header from a non-super-admin principal",
      );
    }
    return { tenantContext: context };
  });
