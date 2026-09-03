import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import { AppError } from "@/lib/errors";
import type { ActorType } from "@/lib/tenancy/context";

// The password step-up an irreversible route asks for, answered once for every principal kind.
//
// Step-up is a property of the SESSION. A cookie lives seven days in a browser somebody may have
// walked away from, so before a tenant, an agent or a Chatwoot account is destroyed the person
// behind it re-types their password. A Bearer API key has none of that: it is presented on every
// request, it is held by a machine, and it was itself minted under a step-up — minting a key is one
// of the routes below, so a session cannot reach a key without answering the password first (review
// round 1 on #308: without that, a stolen session would mint a key and carry it past this rule).
// Each route used to spell the check itself, against the row `ctx.userId` names — which for a key
// is the key's CREATOR,
// so an automation could only pass by also holding a person's password. That coupling is the
// fragility issue #308 reports (the password rotates, the person leaves, the run breaks), and it
// proved nothing a key had not already proved. So the key answers by itself, and a password it
// sends is not read: the creator's password is not what a key is.
//
// `actorType` is what the tenancy boundary stamps on the context ("api_key" for a Bearer key,
// absent for the cookie session); absent is a session. Missing is not incorrect: a session that
// omits the password gets a sentence naming what is missing (400), not the 422 the schema used to
// answer with, and not "incorrect" (403).
//
// translate('errors.passwordRequired', 'Your password is required to confirm this action')
// translate('errors.invalidPassword', 'Incorrect password')
// translate('errors.apiKeyRequiresSession', 'This is done from a signed-in session, not with an API key')

export interface StepUpPrincipal {
  userId: bigint | null;
  actorType?: ActorType;
}

// The one spelling of the field on the wire, so the six routes cannot describe it six ways.
export const STEP_UP_PASSWORD_DESCRIPTION =
  "The acting user's password (step-up confirmation). Required for a session; a Bearer API key answers the step-up by itself and omits it.";

export async function confirmStepUp(
  principal: StepUpPrincipal,
  password: string | undefined,
): Promise<void> {
  if (principal.actorType === "api_key") return;
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

// A key never mints a credential that outlives it.
//
// The step-up above lets a key through, so whatever a key can MINT would be minted with no person
// in the loop, and would keep working after the key that minted it is revoked: a tenant key minted
// by a fleet key under `X-Tenant-Id`, or an MCP grant obtained by driving `/authorize` and
// `/consent` with the key as the app session (the pending record is bound to the key's creator id,
// which the key carries). Revoking a key has to end everything the key could do, so the routes that
// mint a credential — an API key in either scope, an OAuth code and the consent behind it — refuse
// an API-key principal outright, and the one place a person always is (the console) is where a
// credential comes from. Review round 2 on #308.
//
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
