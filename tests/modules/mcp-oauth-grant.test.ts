import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from "@/modules/mcp/oauth/grant";
import { verifyAccessToken } from "@/modules/mcp/oauth/tokens";
import { personData } from "@/tests/utils/person";

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

const CLIENT = `gc-${process.pid}`;
const REDIRECT = "https://client.example/cb";
let tenantId = 0n;
let userId = 0n;

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function mintCode(verifier: string): Promise<string> {
  return createAuthorizationCode({
    clientId: CLIENT,
    userId,
    tenantId,
    redirectUri: REDIRECT,
    scopes: ["mcp:read"],
    codeChallenge: challenge(verifier),
    codeChallengeMethod: "S256",
    base: suDb,
  });
}

describe.skipIf(!dbUp)("mcp oauth grant (PKCE + refresh rotation)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "GrantT", slug: `grant-${process.pid}` },
    });
    tenantId = t.id;
    const u = await suDb.user.create({
      data: personData({
        tenantId,
        email: `grant-${process.pid}@example.com`,
        role: "TENANT_ADMIN",
        passwordHash: "x",
      }),
    });
    userId = u.id;
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM mcp_oauth_refresh_tokens WHERE client_id = '${CLIENT}'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM mcp_oauth_access_tokens WHERE client_id = '${CLIENT}'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM mcp_oauth_authorization_codes WHERE client_id = '${CLIENT}'`,
    );
    if (userId)
      await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${userId}`);
    if (tenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    await suDb.$disconnect();
  });

  test("code → token exchange with correct PKCE yields a usable access token", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const code = await mintCode(verifier);
    const res = await exchangeAuthorizationCode({
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      base: suDb,
    });
    expect(res.tokenType).toBe("Bearer");
    expect(res.scopes).toEqual(["mcp:read"]);
    const principal = await verifyAccessToken(res.accessToken, suDb);
    expect(principal?.userId).toBe(userId);
  });

  test("wrong PKCE verifier is rejected", async () => {
    const code = await mintCode(randomBytes(32).toString("base64url"));
    expect(
      exchangeAuthorizationCode({
        code,
        clientId: CLIENT,
        redirectUri: REDIRECT,
        codeVerifier: "the-wrong-verifier",
        base: suDb,
      }),
    ).rejects.toThrow();
  });

  test("redirect_uri mismatch is rejected", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const code = await mintCode(verifier);
    expect(
      exchangeAuthorizationCode({
        code,
        clientId: CLIENT,
        redirectUri: "https://evil.example/cb",
        codeVerifier: verifier,
        base: suDb,
      }),
    ).rejects.toThrow();
  });

  test("an authorization code is single-use", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const code = await mintCode(verifier);
    await exchangeAuthorizationCode({
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      base: suDb,
    });
    expect(
      exchangeAuthorizationCode({
        code,
        clientId: CLIENT,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        base: suDb,
      }),
    ).rejects.toThrow();
  });

  test("refresh rotates; reusing the old refresh revokes the family", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const code = await mintCode(verifier);
    const first = await exchangeAuthorizationCode({
      code,
      clientId: CLIENT,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      base: suDb,
    });
    const rotated = await refreshAccessToken({
      refreshToken: first.refreshToken,
      clientId: CLIENT,
      base: suDb,
    });
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    // Reusing the OLD refresh token is a leak signal → reject + revoke the family.
    expect(
      refreshAccessToken({
        refreshToken: first.refreshToken,
        clientId: CLIENT,
        base: suDb,
      }),
    ).rejects.toThrow();
    // The rotated (newer) token is now revoked too (family-wide).
    expect(
      refreshAccessToken({
        refreshToken: rotated.refreshToken,
        clientId: CLIENT,
        base: suDb,
      }),
    ).rejects.toThrow();
  });
});
