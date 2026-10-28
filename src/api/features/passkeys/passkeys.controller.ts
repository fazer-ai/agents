import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { Elysia, NotFoundError, t } from "elysia";
import {
  sessionUserOf,
  updateLastLogin,
} from "@/api/features/auth/auth.service";
import { type AuthUser, authPlugin } from "@/api/lib/auth";
import { translate } from "@/api/lib/i18n";
import logger from "@/api/lib/logger";
import { doc, errors } from "@/api/lib/openapi";
import { requireSession } from "@/api/lib/step-up";
import config from "@/config";
import {
  dismissPasskeyOffer,
  passkeyOfferWindow,
  recentSignInProves,
} from "./offer";
import {
  deviceFromUserAgent,
  listPasskeys,
  loginOptions,
  loginWithPasskey,
  PASSKEY_NAME_MAX_LENGTH,
  PasskeyError,
  type PasskeyErrorCode,
  proveAccountOwner,
  registerPasskey,
  registrationOptions,
  removePasskey,
  renamePasskey,
} from "./passkeys.service";

// WebAuthn allows credential ids up to 1023 bytes, and they travel as unpadded base64url:
// ceil(1023 * 4 / 3) characters.
const CREDENTIAL_ID_MAX_LENGTH = 1364;

// The browser's answer (`startRegistration`/`startAuthentication`) has WebAuthn's own shape; the
// schema only checks the envelope and caps its size, the library validates the rest.
const Credential = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: CREDENTIAL_ID_MAX_LENGTH }),
    rawId: t.String({ minLength: 1, maxLength: CREDENTIAL_ID_MAX_LENGTH }),
    type: t.Literal("public-key"),
    response: t.Object({}, { additionalProperties: true }),
    clientExtensionResults: t.Object({}, { additionalProperties: true }),
    authenticatorAttachment: t.Optional(t.String({ maxLength: 32 })),
  },
  { additionalProperties: true },
);

// A registration challenge is a row id (uuid) and a sign-in one a signed token; one shape for both,
// so a challenge presented on the wrong path is a 400 "challenge" like any other bad one, not a 422.
const ChallengeId = t.String({ minLength: 1, maxLength: 1024 });
// The credential id the authenticator chose (base64url), not a row id.
const PasskeyIdParams = t.Object({
  passkeyId: t.String({ minLength: 1, maxLength: CREDENTIAL_ID_MAX_LENGTH }),
});

function passkeyErrorMessage(code: PasskeyErrorCode): string {
  switch (code) {
    case "challenge":
      return translate(
        "errors.passkeyChallenge",
        "The time to confirm ran out. Try again.",
      );
    // NOTE: a passkey removed from the account, one from another app on the same domain, a signature
    // that does not check out, and an account with no tenant to enter read the same: the way forward
    // is the same, and a distinct answer for the last would say the passkey itself was good.
    case "unknownPasskey":
    case "noMembership":
      return translate(
        "errors.passkeyUnknown",
        "This passkey is not linked to any account here. It may have been removed; sign in another way.",
      );
    case "registrationRejected":
      return translate(
        "errors.passkeyRegistrationRejected",
        "The device did not confirm the passkey. Try again.",
      );
    case "notFound":
      return translate("errors.passkeyNotFound", "Passkey not found");
    case "sessionChanged":
      return translate("errors.unauthorized", "Unauthorized");
    // NOTE: the counter moved past this assertion while it was checked: two devices answered for the
    // same passkey, or one is a copy.
    case "counterRegressed":
      return translate(
        "errors.passkeyCounterRegressed",
        "This passkey could not be verified. Try again, or sign in another way.",
      );
    case "lastSignInMethod":
      return translate(
        "errors.passkeyLastSignInMethod",
        "This passkey is the only way into your account right now. Add another passkey before removing it.",
      );
  }
}

const serialize = (p: Awaited<ReturnType<typeof listPasskeys>>[number]) => ({
  id: p.id,
  name: p.name,
  provider: p.provider,
  createdAt: p.createdAt.toISOString(),
  lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
});

const unauthorized = () => ({
  error: translate("errors.unauthorized", "Unauthorized"),
});

// The session behind a passkey route. An API key's principal names its creator for audit and does not
// act as them on their own account, so it is refused (403) like on the other own-account routes.
async function sessionOf(
  requestAuthUser: () => Promise<AuthUser | null>,
): Promise<AuthUser | null> {
  const user = await requestAuthUser();
  if (user) requireSession(user);
  return user;
}

const PASSKEYS_PATH = "/api/auth/passkeys";

export const passkeysController = new Elysia({
  prefix: "/auth/passkeys",
  tags: ["Auth"],
})
  .use(authPlugin)
  // NOTE: with PASSKEYS_ENABLED off every route answers what a route that does not exist answers,
  // before the body is parsed or the schema runs. Asked per request rather than at mount, so tests and
  // the app read the same switch. `onRequest` sees every request, hence the path check.
  .onRequest(({ request }) => {
    if (config.passkeysEnabled) return;
    const path = new URL(request.url).pathname;
    if (path === PASSKEYS_PATH || path.startsWith(`${PASSKEYS_PATH}/`)) {
      throw new NotFoundError();
    }
  })
  .post("/login/options", () => loginOptions(), {
    detail: {
      ...doc(
        "Start a passkey sign-in",
        "Returns a single-use challenge (5 minutes) for `navigator.credentials.get`, as a signed token in `challengeId`. No email: the browser offers this domain's passkeys. Stores nothing, since /login asks for one on every view to start the autofill request, so it is on the global rate limit only; the challenge is spent when `/login` uses it.",
      ),
      security: [],
    },
    response: errors(503),
  })
  .post(
    "/login",
    async ({ body, setAuthCookie, status }) => {
      let row: Awaited<ReturnType<typeof loginWithPasskey>>;
      try {
        row = await loginWithPasskey(
          body.challengeId,
          body.response as unknown as AuthenticationResponseJSON,
        );
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error;
        if (error.code === "challenge") {
          return status(400, { error: passkeyErrorMessage(error.code) });
        }
        return status(401, {
          error: passkeyErrorMessage(
            error.code === "counterRegressed" ? error.code : "unknownPasskey",
          ),
        });
      }
      const user = sessionUserOf(row);
      if (!user) {
        return status(401, { error: passkeyErrorMessage("noMembership") });
      }
      // NOTE: bound to the password the row holds now, as Google sign-in is: the proof is the
      // passkey, and a later password change still revokes the session.
      await setAuthCookie(user, row.passwordHash, { method: "passkey" });
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
      body: t.Object({ challengeId: ChallengeId, response: Credential }),
      detail: {
        ...doc(
          "Sign in with a passkey",
          "Spends the challenge whether or not the passkey is accepted, then sets the auth cookie. 400 when the challenge is unknown, spent or expired; 401 for a passkey that is not registered here or does not verify. On the strict credential rate limit.",
        ),
        security: [],
      },
      response: errors(400, 401, 422, 503),
    },
  )
  .get(
    "",
    async ({ requestAuthUser, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      const passkeys = await listPasskeys(user.id);
      return { passkeys: passkeys.map(serialize) };
    },
    {
      requireAuth: true,
      detail: doc(
        "List my passkeys",
        "Name, provider (from the authenticator's AAGUID, or the browser and OS it was created from), created and last used. Refused (403) with an API key.",
      ),
      response: errors(401, 403, 503),
    },
  )
  .post(
    "/register/options",
    async ({ requestAuthUser, body, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      const { conditional, ...proof } = body;
      // Right after a password or Google sign-in the person has just proven the credential, so a
      // request carrying no proof is let through. A proof that is sent is always checked.
      const noProof =
        proof.password === undefined && proof.googleCredential === undefined;
      const proven =
        (noProof && recentSignInProves(user.signIn)) ||
        (await proveAccountOwner(user, proof));
      // NOTE: 400, not 401: a wrong password here is not a dead session, and a 401 would sign the
      // client out.
      if (!proven) {
        return status(400, {
          error: translate(
            "errors.passkeyReauthFailed",
            "Could not confirm it is you. Check your password, or sign in with the Google account linked to this one.",
          ),
        });
      }
      return registrationOptions(user, { conditional });
    },
    {
      requireAuth: true,
      body: t.Object({
        // NOTE: the current password, so no minimum, as on /auth/password.
        password: t.Optional(t.String({ maxLength: 256 })),
        googleCredential: t.Optional(t.String({ maxLength: 8192 })),
        conditional: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Start registering a passkey",
        "Asks for the credential the account already has: the current password, or a Google ID token for the account's own Google identity (a session alone would let a stolen cookie plant a passkey that outlives a password change). Within 5 minutes of a password or Google sign-in the session itself is that proof and the body may carry none; a proof that is sent is still checked. 400 when the proof does not check out. Returns a single-use challenge (5 minutes) for `navigator.credentials.create`: discoverable credential, user verification required, the caller's existing passkeys excluded. `conditional: true` asks for options for the browser's silent upgrade (`mediation: \"conditional\"`): user verification preferred, and the response may report neither presence nor verification. On the strict credential rate limit, since it takes a password. Refused (403) with an API key.",
      ),
      response: errors(400, 401, 403, 422, 503),
    },
  )
  .post(
    "/register",
    async ({ requestAuthUser, body, request, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      try {
        const passkey = await registerPasskey(
          user.id,
          user.sessionPwd ?? null,
          body.challengeId,
          body.response as unknown as RegistrationResponseJSON,
          body.name,
          deviceFromUserAgent(request.headers.get("user-agent")),
        );
        return { passkey: serialize(passkey) };
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error;
        // NOTE: the password changed while the ceremony ran, which revoked this session: a 401 signs
        // the client out, as it should.
        if (error.code === "sessionChanged") {
          return status(401, { error: passkeyErrorMessage(error.code) });
        }
        // NOTE: 400 otherwise, never 401: the session was accepted, and a 401 would read to the client
        // as an expired session and sign it out.
        return status(400, { error: passkeyErrorMessage(error.code) });
      }
    },
    {
      requireAuth: true,
      body: t.Object({
        challengeId: ChallengeId,
        response: Credential,
        name: t.Optional(t.String({ maxLength: PASSKEY_NAME_MAX_LENGTH })),
      }),
      detail: doc(
        "Register a passkey",
        "Spends the challenge whether or not the passkey is accepted. 400 when the challenge is unknown, spent, expired or someone else's, or the device's answer does not verify. Refused (403) with an API key.",
      ),
      response: errors(400, 401, 403, 422, 503),
    },
  )
  .get(
    "/offer",
    async ({ requestAuthUser, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      const until = await passkeyOfferWindow(user.id, user.signIn);
      return { offer: until !== null, expiresAt: until?.toISOString() ?? null };
    },
    {
      requireAuth: true,
      detail: doc(
        "Should the console offer a passkey now",
        "True within 5 minutes of a password sign-in, for an account with no passkey that has not declined the offer in the last 30 days nor 3 times in all. `expiresAt` is when that window closes, after which registering asks for the password again.",
      ),
      response: errors(401, 403, 503),
    },
  )
  .post(
    "/offer/dismiss",
    async ({ requestAuthUser, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      await dismissPasskeyOffer(user.id);
      return { success: true as const };
    },
    {
      requireAuth: true,
      detail: doc(
        "Decline the passkey offer",
        'Records "not now" on the account: the offer stays away for 30 days, and after the third time for good. Settings → Security still adds a passkey.',
      ),
      response: errors(401, 403, 503),
    },
  )
  .patch(
    "/:passkeyId",
    async ({ requestAuthUser, params, body, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      try {
        await renamePasskey(user.id, params.passkeyId, body.name);
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error;
        return status(404, { error: passkeyErrorMessage(error.code) });
      }
      return { success: true as const };
    },
    {
      requireAuth: true,
      params: PasskeyIdParams,
      body: t.Object({
        name: t.Union([
          t.String({ maxLength: PASSKEY_NAME_MAX_LENGTH }),
          t.Null(),
        ]),
      }),
      detail: doc(
        "Rename one of my passkeys",
        "An empty or null name clears it, and the list falls back to the provider and date. 404 for a passkey that is not the caller's.",
      ),
      response: errors(401, 403, 404, 422, 503),
    },
  )
  .delete(
    "/:passkeyId",
    async ({ requestAuthUser, params, status }) => {
      const user = await sessionOf(requestAuthUser);
      if (!user) return status(401, unauthorized());
      try {
        await removePasskey(user.id, params.passkeyId);
      } catch (error) {
        if (!(error instanceof PasskeyError)) throw error;
        if (error.code === "lastSignInMethod") {
          return status(409, { error: passkeyErrorMessage(error.code) });
        }
        return status(404, { error: passkeyErrorMessage(error.code) });
      }
      return { success: true as const };
    },
    {
      requireAuth: true,
      params: PasskeyIdParams,
      detail: doc(
        "Remove one of my passkeys",
        "404 for a passkey that is not the caller's. 409 when it is the last passkey of an account with no password and no usable Google sign-in (no Google identity, or Google sign-in turned off on this install). Sessions the passkey opened are not ended: changing the password does that.",
      ),
      response: errors(401, 403, 404, 409, 422, 503),
    },
  );
