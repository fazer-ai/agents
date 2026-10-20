// The token a browser presents on the SDK's turn: a JWT the embedding application's server signed
// with one of the app's keys (docs/client-channel.md, "Embedding with the SDK"). Verified here before
// anything else about the request is believed. Every refusal is the same 401, unknown app included,
// so the answer does not say which part failed.
import { decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import type { ExternalIdentity } from "@/modules/client-channel/identity";
import { ANON_KID, anonTokenKey, anonUserId } from "./anonymous";
import type { ResolvedClientApp } from "./service";

// The longest a token may live. The SDK renews before expiry, so a short life costs nothing and
// bounds what a token copied out of a browser is worth.
export const MAX_TOKEN_LIFETIME_S = 60 * 60;
const CLOCK_SKEW_S = 60;

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  name: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
  scope: z.string().min(1).max(255).optional(),
  exp: z.number(),
});

const anonClaimsSchema = z.object({
  sub: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  exp: z.number(),
});

export function invalidToken(): AppError {
  return new AppError("invalid token", 401, "errors.clientAppTokenInvalid");
}

// The person a token names, as one of THIS app's users. The app's internal id leads the id, so the
// same `sub` in two apps (or the one a tenant key states on the proxy route) is two different people.
export function appUserId(appId: bigint, sub: string): string {
  return `app:${appId}:${sub}`;
}

// The identity a token names, and whether the instance signed it for an anonymous session.
export interface VerifiedClientUser extends ExternalIdentity {
  anonymous: boolean;
}

// `app` is what `resolveClientApp` returned for the route's public id (null for an unknown one), read
// by the caller first because the answer's CORS headers depend on it whatever the token says.
export async function verifyClientAppToken(
  app: ResolvedClientApp | null,
  authorization: string | null | undefined,
  now: Date = new Date(),
): Promise<VerifiedClientUser> {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!token) throw invalidToken();
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw invalidToken();
  }
  if (!kid || !app) throw invalidToken();
  // An anonymous token stops verifying the moment the operator turns anonymous sessions off.
  const anonymous = kid === ANON_KID;
  if (anonymous && !app.anonymousEnabled) throw invalidToken();
  const secret = anonymous ? undefined : app.keys.get(kid);
  if (!anonymous && !secret) throw invalidToken();
  const key = anonymous
    ? anonTokenKey(app.id)
    : new TextEncoder().encode(secret);

  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience: app.publicId,
      requiredClaims: ["exp", "sub"],
      currentDate: now,
      clockTolerance: CLOCK_SKEW_S,
    }));
  } catch {
    throw invalidToken();
  }
  const nowS = Math.floor(now.getTime() / 1000);
  if (anonymous) {
    const claims = anonClaimsSchema.safeParse(payload);
    if (!claims.success) throw invalidToken();
    if (claims.data.exp > nowS + MAX_TOKEN_LIFETIME_S + CLOCK_SKEW_S)
      throw invalidToken();
    return { id: anonUserId(app.id, claims.data.sub), anonymous: true };
  }
  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) throw invalidToken();
  if (claims.data.exp > nowS + MAX_TOKEN_LIFETIME_S + CLOCK_SKEW_S)
    throw invalidToken();

  return {
    id: appUserId(app.id, claims.data.sub),
    name: claims.data.name,
    email: claims.data.email,
    scope: claims.data.scope,
    anonymous: false,
  };
}
