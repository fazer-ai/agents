// The anonymous visitor of an embedding app that allows one (docs/client-channel.md, "Anonymous
// visitors"). The instance stands in for the app's server: it hands the page a long-lived session
// credential, kept in that browser's storage, and short tokens for it that the turn verifies like the
// app's own. Nothing is stored: both are signed with keys derived from ENCRYPTION_KEY per app, so the
// app's secret rotating does not end anyone's session and whoever holds that secret cannot mint one.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT } from "jose";
import config from "@/config";

// The `kid` of a token the instance signed for an anonymous session. An app's own keys are `key_…`.
export const ANON_KID = "anon";
// The anonymous token's life. The widget renews it with the session credential before it runs out.
export const ANON_TOKEN_LIFETIME_S = 10 * 60;

const SESSION = /^anon_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function derived(purpose: "session" | "token", appId: bigint): Buffer {
  const root = createHash("sha256").update(config.encryptionKey).digest();
  return createHmac("sha256", root)
    .update(`fazer-ai-anon:${purpose}:${appId}`)
    .digest();
}

function sign(appId: bigint, id: string): string {
  return createHmac("sha256", derived("session", appId))
    .update(id)
    .digest("base64url");
}

// The person an anonymous session is, as one of this app's users. Its own prefix, so no `sub` an app
// signs (`app:<id>:<sub>`) and no id a tenant key states on the proxy route can name it.
export function anonUserId(appId: bigint, sessionId: string): string {
  return `anon:${appId}:${sessionId}`;
}

// Whether a client-channel user id is an anonymous session's (`anonUserId`): only this module mints
// the prefix, and the routes that take an id from a host refuse it.
export function isAnonUserId(id: string): boolean {
  return id.startsWith("anon:");
}

export function mintAnonSession(appId: bigint): {
  id: string;
  session: string;
} {
  const id = randomBytes(16).toString("base64url");
  return { id, session: `anon_${id}.${sign(appId, id)}` };
}

// The session's id when the credential is one this instance signed for this app, else null.
export function readAnonSession(
  appId: bigint,
  credential: string,
): string | null {
  const match = SESSION.exec(credential);
  if (!match) return null;
  const [, id, signature] = match as unknown as [string, string, string];
  const expected = Buffer.from(sign(appId, id));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? id
    : null;
}

export function anonTokenKey(appId: bigint): Uint8Array {
  return new Uint8Array(derived("token", appId));
}

export async function mintAnonToken(
  app: { id: bigint; publicId: string },
  sessionId: string,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: ANON_KID })
    .setSubject(sessionId)
    .setAudience(app.publicId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ANON_TOKEN_LIFETIME_S)
    .sign(anonTokenKey(app.id));
}
