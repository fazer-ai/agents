import { createHash } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { WebauthnChallengeType } from "@/../generated/prisma/client";
import { AUTH_USER_SELECT } from "@/api/features/auth/auth.service";
import { verifyGoogleIdToken } from "@/api/features/auth/google.service";
import { signActionToken, verifyActionToken } from "@/api/lib/action-token";
import { type AuthUser, passwordFingerprint } from "@/api/lib/auth";
import prisma from "@/api/lib/prisma";
import { confirmStepUp, stepUpPrincipalOf } from "@/api/lib/step-up";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/pg-error";

// The RP ID is the hostname of PUBLIC_URL and a passkey only works on the domain it was created for,
// so a wrong PUBLIC_URL breaks passkeys outright, and moving the console to another domain strands
// the existing ones. Read per call so a test can point it elsewhere. The hostname is also the name the
// authenticator shows, which says nothing a white-labelled install would not want said.
function relyingParty() {
  const url = new URL(config.publicUrl);
  return { rpID: url.hostname, rpName: url.hostname, origin: url.origin };
}
// Stored as text; the browser only ever hands back values from this set.
type Transport = NonNullable<
  RegistrationResponseJSON["response"]["transports"]
>[number];

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_NAME_MAX_LENGTH = 100;

export type PasskeyErrorCode =
  | "challenge"
  | "unknownPasskey"
  | "noMembership"
  | "registrationRejected"
  | "notFound"
  | "sessionChanged"
  | "lastSignInMethod"
  | "counterRegressed";

export class PasskeyError extends Error {
  constructor(readonly code: PasskeyErrorCode) {
    super(code);
    this.name = "PasskeyError";
  }
}

// The AAGUID says who keeps the passkey; the common ones, with the name the person sees on the
// device (passkey-authenticator-aaguids community list). Apple sends zeros, so for those the browser
// and OS stand in.
const PROVIDERS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": "Edge on Mac",
};

// Only what tells two passkeys apart in a list, not a user-agent parser: the first browser and OS
// family the header names.
export function deviceFromUserAgent(userAgent: string | null) {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return { browser, os };
}

/** Who keeps the passkey, or the device it was created from. */
export function passkeyProvider(
  aaguid: string | undefined,
  device: { browser: string | null; os: string | null },
) {
  const known = aaguid ? PROVIDERS[aaguid.toLowerCase()] : undefined;
  if (known) return known;
  const { browser, os } = device;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? null;
}

async function storeChallenge(
  type: WebauthnChallengeType,
  challenge: string,
  userId: bigint,
) {
  const now = new Date();
  // NOTE: opportunistic sweep; the index on `expires_at` keeps it cheap.
  await prisma.webauthnChallenge.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  const row = await prisma.webauthnChallenge.create({
    data: {
      type,
      challenge,
      userId,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    },
  });
  return row.id;
}

// Single use: the row is deleted before anything is verified, so a replayed response has no
// challenge left to match, and the owner is checked after the delete, so a challenge presented by
// another account is spent too. Anything that is not a row id (a sign-in token) is a bad challenge.
async function consumeChallenge(id: string, userId: bigint) {
  const row = await prisma.webauthnChallenge
    .delete({ where: { id } })
    .catch((error) => {
      // Only a missing row (unknown, already spent, or not a uuid at all) is a bad challenge; a
      // database failure is a 5xx, not "the time ran out".
      const code = (error as { code?: string }).code;
      if (code === "P2025" || code === "P2023") return null;
      throw error;
    });
  if (!row || row.userId !== userId || row.expiresAt.getTime() < Date.now()) {
    throw new PasskeyError("challenge");
  }
  return { challenge: row.challenge, type: row.type };
}

// The account's WebAuthn user handle (base64url of 32 random bytes), created on its first
// registration and the same for every passkey after, which is what lets an authenticator keep one
// passkey per account. Set with a conditional write, so two concurrent first registrations agree.
async function userHandleOf(userId: bigint): Promise<string> {
  await prisma.user.updateMany({
    where: { id: userId, webauthnUserHandle: null },
    data: {
      webauthnUserHandle: isoBase64URL.fromBuffer(
        crypto.getRandomValues(new Uint8Array(32)),
      ),
    },
  });
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { webauthnUserHandle: true },
  });
  return row.webauthnUserHandle as string;
}

export type OwnerProof = { password?: string; googleCredential?: string };

// A session alone does not register a passkey. A stolen cookie is revoked by a password change, but a
// passkey its holder registered would survive that change, so registering asks for the credential the
// account already has: the current password, or a fresh Google sign-in for the account's own Google
// identity. `users_auth_method_check` guarantees one of the two. The password goes through the
// session step-up, so a wrong one reads as "not proven". `verifyGoogle` is injectable so a test can
// stand in for Google's JWKS.
export async function proveAccountOwner(
  user: AuthUser,
  proof: OwnerProof,
  verifyGoogle: (credential: string) => Promise<{ sub: string }> = (c) =>
    verifyGoogleIdToken(c),
): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, googleId: true },
  });
  if (!row) return false;
  if (proof.password !== undefined && row.passwordHash) {
    try {
      await confirmStepUp(stepUpPrincipalOf(user), proof.password);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) return false;
      throw error;
    }
  }
  if (
    proof.googleCredential !== undefined &&
    row.googleId &&
    config.googleOAuthEnabled
  ) {
    try {
      const profile = await verifyGoogle(proof.googleCredential);
      return profile.sub === row.googleId;
    } catch {
      return false;
    }
  }
  return false;
}

// `conditional` asks for the browser's silent upgrade after a password sign-in (`mediation:
// "conditional"`), which creates the passkey without a prompt, so user verification is only preferred
// and the challenge is typed to let the response skip presence and verification. Every sign-in with
// that passkey still requires verification.
export async function registrationOptions(
  user: { id: bigint; email: string; name: string | null },
  { conditional = false }: { conditional?: boolean } = {},
) {
  const existing = await prisma.passkey.findMany({
    where: { userId: user.id },
    select: { id: true, transports: true },
  });
  const { rpID, rpName } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: isoBase64URL.toBuffer(await userHandleOf(user.id)),
    // NOTE: the browser refuses to create a second passkey for this account on an authenticator that
    // already holds one (InvalidStateError).
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: p.transports as Transport[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: conditional ? "preferred" : "required",
    },
  });
  const challengeId = await storeChallenge(
    conditional ? "CONDITIONAL_REGISTRATION" : "REGISTRATION",
    options.challenge,
    user.id,
  );
  return { challengeId, options };
}

// `sessionPwd` is the password fingerprint of the session asking, re-checked against the row under a
// lock before the insert: a password changed while the ceremony ran revoked that session, and the
// passkey it was adding must not land.
export async function registerPasskey(
  userId: bigint,
  sessionPwd: string | null,
  challengeId: string,
  response: RegistrationResponseJSON,
  name: string | undefined,
  device: { browser: string | null; os: string | null },
) {
  const { challenge: expectedChallenge, type } = await consumeChallenge(
    challengeId,
    userId,
  );
  const silent = type === "CONDITIONAL_REGISTRATION";
  const { rpID, origin } = relyingParty();
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserPresence: !silent,
      requireUserVerification: !silent,
    });
  } catch {
    throw new PasskeyError("registrationRejected");
  }
  if (!verification.verified) throw new PasskeyError("registrationRejected");
  const info = verification.registrationInfo;
  try {
    return await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ password_hash: string | null }[]>`
        SELECT password_hash FROM users WHERE id = ${userId} FOR UPDATE`;
      if (
        !row ||
        (passwordFingerprint(row.password_hash) ?? null) !== sessionPwd
      ) {
        throw new PasskeyError("sessionChanged");
      }
      return tx.passkey.create({
        data: {
          id: info.credential.id,
          userId,
          publicKey: Buffer.from(info.credential.publicKey),
          // biome-ignore lint/plugin/no-bigint-cast: the authenticator's signature counter, a number the verified response carries, not an id.
          counter: BigInt(info.credential.counter),
          transports: info.credential.transports ?? [],
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          name: name?.trim() || null,
          provider: passkeyProvider(info.aaguid, device),
        },
        select: PASSKEY_SELECT,
      });
    });
  } catch (error) {
    // NOTE: a credential id already stored, which `excludeCredentials` should have stopped in the
    // browser; the same refusal either way.
    if (isUniqueViolation(error)) {
      throw new PasskeyError("registrationRejected");
    }
    throw error;
  }
}

// A sign-in challenge is not stored: it travels as a signed token (its own key derived from
// JWT_SECRET, 5 minutes), because /login asks for one on every view to start the autofill request,
// and a row per page view would be a write any crawler can make. Single use is kept at the other end:
// `spendLoginChallenge` records the challenge before the response is verified.
const LOGIN_CHALLENGE_PURPOSE = "webauthn-login-challenge";

export async function loginOptions({
  now = Date.now(),
}: {
  now?: number;
} = {}) {
  // No `allowCredentials`: the browser offers this domain's passkeys (discoverable
  // credentials), so nobody types an email, which also does not reveal which emails have an account.
  const { rpID } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });
  const challengeId = await signActionToken(
    LOGIN_CHALLENGE_PURPOSE,
    { sub: "login", challenge: options.challenge },
    CHALLENGE_TTL_MS / 1000,
    { now },
  );
  return { challengeId, options };
}

// Refuses a token that is not a live sign-in challenge (forged, expired, a registration's id), then
// inserts the challenge's hash BEFORE anything is verified: a replayed response, or a second request
// racing the first, hits the primary key, and a rejected response spends its challenge too.
async function spendLoginChallenge(challengeId: string, now: number) {
  const claims = await verifyActionToken(LOGIN_CHALLENGE_PURPOSE, challengeId, {
    now,
  });
  if (
    claims?.sub !== "login" ||
    typeof claims.challenge !== "string" ||
    typeof claims.exp !== "number"
  ) {
    throw new PasskeyError("challenge");
  }
  // NOTE: the sweep and the insert both read the DATABASE clock, and the insert refuses a challenge
  // that has expired by it. That is what makes the sweep safe: a mark is removed only once its
  // challenge is past expiry, and from then on no request can record that challenge again. `expires_at`
  // is a UTC wall-clock timestamp (Prisma's DateTime), so both sides are converted to UTC explicitly.
  await prisma.$executeRaw`
    DELETE FROM webauthn_consumed_challenges
    WHERE expires_at < (now() AT TIME ZONE 'UTC')`;
  const recorded = await prisma.$executeRaw`
    INSERT INTO webauthn_consumed_challenges (challenge_hash, expires_at)
    SELECT hash, expires_at FROM (
      SELECT ${createHash("sha256").update(claims.challenge).digest("hex")} AS hash,
             to_timestamp(${claims.exp}) AT TIME ZONE 'UTC' AS expires_at
    ) AS spent
    WHERE expires_at > (now() AT TIME ZONE 'UTC')
    ON CONFLICT (challenge_hash) DO NOTHING`;
  if (recorded !== 1) throw new PasskeyError("challenge");
  // `now()` above is when the INSERT started, and an insert can wait on the unique index for a
  // sweep deleting the original's mark to commit, then go through on a time read before that sweep.
  // Re-reading the clock after the insert closes it: a sweep only removes a mark past expiry.
  const [clock] = await prisma.$queryRaw<{ live: boolean }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')
      < (to_timestamp(${claims.exp}) AT TIME ZONE 'UTC') AS live`;
  if (!clock?.live) throw new PasskeyError("challenge");
  return claims.challenge;
}

// `now` is the clock a test injects; production passes none.
export async function loginWithPasskey(
  challengeId: string,
  response: AuthenticationResponseJSON,
  { now = Date.now() }: { now?: number } = {},
) {
  const expectedChallenge = await spendLoginChallenge(challengeId, now);
  const passkey = await prisma.passkey.findUnique({
    where: { id: response.id },
    include: {
      user: {
        select: {
          ...AUTH_USER_SELECT,
          passwordHash: true,
          webauthnUserHandle: true,
        },
      },
    },
  });
  if (!passkey) throw new PasskeyError("unknownPasskey");
  // Without `allowCredentials` WebAuthn requires the `userHandle` to be present and to be the
  // credential owner's; the library only checks the field's type, the binding is the application's.
  const userHandle = response.response.userHandle;
  if (!userHandle || userHandle !== passkey.user.webauthnUserHandle) {
    throw new PasskeyError("unknownPasskey");
  }
  const { rpID, origin } = relyingParty();
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports as Transport[],
      },
    });
  } catch {
    throw new PasskeyError("unknownPasskey");
  }
  if (!verification.verified) throw new PasskeyError("unknownPasskey");
  // A compare-and-swap on the counter: two concurrent sign-ins cannot write out of order and
  // move it backwards, which would hide a cloned credential. The one that loses re-reads and retries
  // while its counter is still ahead of what was stored meanwhile (two tabs at once); a counter at or
  // behind the stored one is refused. An authenticator that never counts (always 0) always writes.
  // biome-ignore lint/plugin/no-bigint-cast: the authenticator's signature counter, a number the verified response carries, not an id.
  const newCounter = BigInt(verification.authenticationInfo.newCounter);
  let expected = passkey.counter;
  for (let attempt = 0; ; attempt++) {
    const written = await prisma.passkey.updateMany({
      where: { id: passkey.id, counter: expected },
      data: {
        // biome-ignore lint/complexity/useMathMinMax: both are bigint, and Math.max throws on a bigint.
        counter: newCounter > expected ? newCounter : expected,
        backedUp: verification.authenticationInfo.credentialBackedUp,
        lastUsedAt: new Date(),
      },
    });
    if (written.count === 1) break;
    const current = await prisma.passkey.findUnique({
      where: { id: passkey.id },
      select: { counter: true },
    });
    if (!current) throw new PasskeyError("unknownPasskey");
    const counterless = newCounter === 0n && current.counter === 0n;
    if ((!counterless && newCounter <= current.counter) || attempt >= 4) {
      throw new PasskeyError("counterRegressed");
    }
    expected = current.counter;
  }
  const { webauthnUserHandle: _, ...user } = passkey.user;
  return user;
}

const PASSKEY_SELECT = {
  id: true,
  name: true,
  provider: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

export async function listPasskeys(userId: bigint) {
  return prisma.passkey.findMany({
    where: { userId },
    select: PASSKEY_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

// Scoped by (id, userId): another account's passkey is not found.
export async function renamePasskey(
  userId: bigint,
  id: string,
  name: string | null,
) {
  const { count } = await prisma.passkey.updateMany({
    where: { id, userId },
    data: { name: name?.trim() || null },
  });
  if (count === 0) throw new PasskeyError("notFound");
}

// Scoped by (id, userId): another account's passkey is not found. Refuses to remove the last passkey
// of an account that has no other way in right now: no password, and no Google identity or Google
// sign-in turned off on this install (`users_auth_method_check` only guarantees the stored identity,
// not that GOOGLE_CLIENT_ID is still set). The user row is locked first, so two concurrent removals
// of the last two passkeys cannot both pass the count.
export async function removePasskey(userId: bigint, id: string) {
  await prisma.$transaction(async (tx) => {
    const [user] = await tx.$queryRaw<
      { password_hash: string | null; google_id: string | null }[]
    >`SELECT password_hash, google_id FROM users WHERE id = ${userId} FOR UPDATE`;
    const target = await tx.passkey.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!user || !target) throw new PasskeyError("notFound");
    const otherWayIn =
      user.password_hash !== null ||
      (user.google_id !== null && config.googleOAuthEnabled);
    if (!otherWayIn && (await tx.passkey.count({ where: { userId } })) <= 1) {
      throw new PasskeyError("lastSignInMethod");
    }
    await tx.passkey.delete({ where: { id } });
  });
}
