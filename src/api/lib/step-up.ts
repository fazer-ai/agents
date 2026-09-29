import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import { AppError } from "@/lib/errors";
import type { ActorType } from "@/lib/tenancy/context";

// The password step-up an irreversible route asks for, answered once for every principal kind
// (docs/api-and-fleet.md, "Step-up is a property of the session"). A session re-types its password.
// A Bearer key minted under a step-up (`stepUpAt`, stamped at the mint) answers by itself and a
// password it sends is not read: its creator's password would tie an automation to a person and
// prove nothing the key has not. A key that predates the rule answers with its creator's password;
// absent `stepUpAt` reads as null. `actorType` "api_key" marks a key, absent is a session. A session
// that omits the password gets 400 naming what is missing, not 403 "incorrect".

// translate('errors.passwordRequired', 'Your password is required to confirm this action')
// translate('errors.invalidPassword', 'Incorrect password')
// translate('errors.apiKeyRequiresSession', 'This is done from a signed-in session, not with an API key')

export interface StepUpPrincipal {
  userId: bigint | null;
  actorType?: ActorType;
  stepUpAt?: Date | null;
}

// The one spelling of the field on the wire, so the six routes cannot describe it six ways.
export const STEP_UP_PASSWORD_DESCRIPTION =
  "The acting user's password (step-up confirmation). Required for a session. A Bearer API key minted under this rule answers the step-up by itself and omits it; a key minted before the rule (no step-up on record) sends its creator's password, as it always did.";

export async function confirmStepUp(
  principal: StepUpPrincipal,
  password: string | undefined,
): Promise<void> {
  if (principal.actorType === "api_key" && principal.stepUpAt) return;
  if (!password) {
    throw new AppError("password required", 400, "errors.passwordRequired");
  }
  const user = principal.userId ? await getUserById(principal.userId) : null;
  if (
    !user?.passwordHash ||
    !(await verifyPassword(password, user.passwordHash))
  ) {
    throw new AppError("Incorrect password", 403, "errors.invalidPassword");
  }
}

// The step-up principal an AuthUser is, spelled once. The tenancy boundary stamps the same three
// fields on a TenantContext, so a route that holds a context passes it whole; a route that holds
// the AuthUser (the admin scope, which has no tenant context) goes through here, so the step-up on
// record travels with the key instead of being dropped by a hand-built `{ userId, actorType }`.
export function stepUpPrincipalOf(user: {
  id: bigint;
  isApiKey?: boolean;
  stepUpAt?: Date | null;
}): StepUpPrincipal {
  return {
    userId: user.id,
    actorType: user.isApiKey ? "api_key" : "user",
    stepUpAt: user.stepUpAt ?? null,
  };
}

// A key never mints a credential that outlives it. A key passes the step-up, so what it MINTS would
// have no person in the loop and survive the key's revocation (a tenant key minted by a fleet key
// under `X-Tenant-Id`, an MCP grant from driving `/authorize` and `/consent` with the key as the app
// session). So the routes that mint a credential (an API key in either scope, an OAuth code and its
// consent) refuse an API-key principal outright; a credential comes from the console, where a person is.
// Both spellings of "this is a key" are accepted, because the two boundaries stamp it differently:
// `actorType: "api_key"` on a TenantContext, `isApiKey` on an AuthUser.
export function requireSession(principal: {
  actorType?: ActorType;
  isApiKey?: boolean;
}): void {
  if (principal.actorType === "api_key" || principal.isApiKey) {
    throw new AppError(
      "this is done from a session, not with an API key",
      403,
      "errors.apiKeyRequiresSession",
    );
  }
}
