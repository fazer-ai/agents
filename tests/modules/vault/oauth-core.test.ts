import { describe, expect, test } from "bun:test";
import {
  buildOAuthCallbackHtml,
  computeCodeChallenge,
  decryptOAuthStateRaw,
  encryptOAuthState,
  generateCodeVerifier,
  newNonce,
  OAUTH_CALLBACK_SCRIPT,
} from "@/modules/vault/oauth-core";

describe("oauth-core: PKCE", () => {
  test("verifier is URL-safe and in the RFC 7636 length range", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).not.toMatch(/[+/=]/);
  });

  test("challenge is deterministic and URL-safe", () => {
    // RFC 7636, Appendix B: S256 is the unpadded base64url of the verifier's SHA-256.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(computeCodeChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(computeCodeChallenge(verifier)).toBe(computeCodeChallenge(verifier));
  });

  test("newNonce is non-empty and URL-safe", () => {
    // Twelve random bytes: sixteen base64url characters, and a fresh value every call.
    const n = newNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newNonce()).not.toBe(n);
  });
});

describe("oauth-core: encrypted state", () => {
  test("encrypt/decrypt round-trips an arbitrary object", () => {
    const blob = encryptOAuthState({ a: 1, b: "x", arr: [1, 2] });
    const back = decryptOAuthStateRaw<{ a: number; b: string; arr: number[] }>(
      blob,
    );
    expect(back.a).toBe(1);
    expect(back.b).toBe("x");
    expect(back.arr).toEqual([1, 2]);
  });

  test("a tampered blob is rejected", () => {
    const blob = encryptOAuthState({ hello: "world" });
    const tampered = `${blob.slice(0, -4)}XXXX`;
    expect(() => decryptOAuthStateRaw(tampered)).toThrow();
  });
});

describe("oauth-core: callback HTML (CSP-safe)", () => {
  test("embeds the cfg JSON (channel/type/origin/ok) and the FIXED pinned script", () => {
    const html = buildOAuthCallbackHtml({
      ok: true,
      message: "connected",
      targetOrigin: "https://app.example.com",
      channel: "oauth-mcp",
      type: "mcp-oauth",
      title: "MCP OAuth",
    });
    expect(html).toContain('id="cfg"');
    expect(html).toContain('"origin":"https://app.example.com"');
    expect(html).toContain('"channel":"oauth-mcp"');
    expect(html).toContain('"type":"mcp-oauth"');
    expect(html).toContain('"ok":true');
    // The executable script must be exactly the pinned constant (whose sha256 is in csp.ts).
    expect(html).toContain(`<script>${OAUTH_CALLBACK_SCRIPT}</script>`);
  });

  test("the pinned script reads the channel/type from cfg (does not hardcode them)", () => {
    expect(OAUTH_CALLBACK_SCRIPT).toContain("cfg.channel");
    expect(OAUTH_CALLBACK_SCRIPT).toContain("cfg.type");
    expect(OAUTH_CALLBACK_SCRIPT).not.toContain("oauth-google");
  });

  test("escapes a hostile message so it cannot break out of the JSON block", () => {
    const html = buildOAuthCallbackHtml({
      ok: false,
      message: "</script><b>x",
      targetOrigin: "https://app",
      channel: "oauth-mcp",
      type: "mcp-oauth",
      title: "MCP OAuth",
    });
    expect(html).not.toContain("</script><b>x");
  });
});
