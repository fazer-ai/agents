import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import { AppError } from "@/lib/errors";
import type { ActorType } from "@/lib/tenancy/context";

// The password step-up an irreversible route asks for, answered once for every principal kind.
//
// Step-up is a property of the SESSION. A cookie lives seven days in a browser somebody may have
// walked away from, so before a tenant, an agent or a Chatwoot account is destroyed the person
// behind it re-types their password. A Bearer API key has none of that: it is presented on every
// request, it is held by a machine, and it was itself minted under a step-up — minting a key is one
// of the routes below, so a session cannot reach a key without answering the password first, and a
// key minting a key inherits the step-up its own minting answered (review round 1 on #308: without
// that, a stolen session would mint a key and carry it past this rule). Each route used to spell
// the check itself, against the row `ctx.userId` names — which for a key is the key's CREATOR,
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
