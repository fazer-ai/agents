import { createHmac } from "node:crypto";
import * as jose from "jose";
import config from "@/config";

// Short-lived signed tokens that carry one step of a flow to the next (a passkey sign-in challenge,
// from `/auth/passkeys/login/options` to `/auth/passkeys/login`). Stateless: nothing is stored, and
// what makes a token single use is a check the caller makes against the database.
//
// Each purpose signs with its OWN key, derived from JWT_SECRET. A shared key with only a `purpose`
// claim to tell them apart would leave every session cookie (also an HS256 JWT under JWT_SECRET)
// one forgotten check away from being accepted as an action token, and the reverse. With derived
// keys the signature itself fails.
function keyFor(purpose: string): Uint8Array {
  return createHmac("sha256", config.jwtSecret)
    .update(`action-token:${purpose}`)
    .digest();
}

export type ActionTokenClaims = { sub: string } & Record<
  string,
  string | number
>;

// `now` (epoch ms) is the clock a test injects; production passes none.
export async function signActionToken(
  purpose: string,
  claims: ActionTokenClaims,
  ttlSeconds: number,
  { now = Date.now() }: { now?: number } = {},
): Promise<string> {
  const { sub, ...rest } = claims;
  const iat = Math.floor(now / 1000);
  return new jose.SignJWT(rest)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setAudience(purpose)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(keyFor(purpose));
}

// Null for anything that is not a valid, unexpired token for THIS purpose: malformed, forged,
// expired, or signed for another purpose. The caller cannot tell those apart, and should not.
export async function verifyActionToken(
  purpose: string,
  token: string,
  { now }: { now?: number } = {},
): Promise<(jose.JWTPayload & { sub: string }) | null> {
  try {
    const { payload } = await jose.jwtVerify(token, keyFor(purpose), {
      audience: purpose,
      algorithms: ["HS256"],
      ...(now === undefined ? {} : { currentDate: new Date(now) }),
    });
    if (typeof payload.sub !== "string") return null;
    return payload as jose.JWTPayload & { sub: string };
  } catch {
    return null;
  }
}
