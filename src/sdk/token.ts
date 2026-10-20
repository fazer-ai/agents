// What the widget reads from the app's token without verifying it (the instance verifies): when it
// expires, so it is renewed before, and whose it is, so a stored conversation is resumed only for the
// user it belongs to.

export interface TokenClaims {
  sub?: string;
  scope?: string;
  exp?: number;
}

export function readClaims(token: string): TokenClaims {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    // atob yields one char per byte; the payload is UTF-8 JSON, so a `sub` with an accent
    // reads the same whether the signer escaped it or not.
    const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder().decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
    const claims = JSON.parse(json) as Record<string, unknown>;
    return {
      sub: typeof claims.sub === "string" ? claims.sub : undefined,
      scope: typeof claims.scope === "string" ? claims.scope : undefined,
      exp: typeof claims.exp === "number" ? claims.exp : undefined,
    };
  } catch {
    return {};
  }
}

// Renewed this long before `exp`, so a turn that starts near the end does not run on an expired one.
export const RENEW_BEFORE_S = 60;

export function stillFresh(claims: TokenClaims, nowMs: number): boolean {
  return claims.exp !== undefined && claims.exp - RENEW_BEFORE_S > nowMs / 1000;
}

// The token-url answers with the token as text or as `{ token }`.
export async function tokenFromResponse(res: Response): Promise<string> {
  const text = (await res.text()).trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as { token?: unknown };
    if (typeof parsed.token === "string") return parsed.token;
    throw new Error("token-url answered JSON without a token");
  }
  return text.replace(/^"|"$/g, "");
}
