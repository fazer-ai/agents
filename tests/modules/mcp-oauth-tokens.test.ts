import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeJwt, SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { mcpResourceId } from "@/modules/mcp/oauth/metadata";
import {
  issueAccessToken,
  revokeAccessToken,
  verifyAccessToken,
} from "@/modules/mcp/oauth/tokens";

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

let tenantId = 0n;
let userId = 0n;
const CLIENT = `c-${process.pid}`;

describe.skipIf(!dbUp)("mcp oauth access tokens", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "McpT", slug: `mcp-${process.pid}` },
    });
    tenantId = t.id;
    const u = await suDb.user.create({
      data: {
        tenantId,
        email: `mcp-${process.pid}@example.com`,
        role: "TENANT_ADMIN",
        passwordHash: "x", // satisfies the users_auth_method_check constraint
      },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM mcp_oauth_access_tokens WHERE client_id = '${CLIENT}'`,
    );
    if (userId)
      await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${userId}`);
    if (tenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    await suDb.$disconnect();
  });

  async function issue(scopes: string[] = ["mcp:read"]) {
    return issueAccessToken({
      clientId: CLIENT,
      userId,
      tenantId,
      role: "TENANT_ADMIN",
      scopes,
      base: suDb,
    });
  }

  test("issued token verifies to the principal", async () => {
    const { token } = await issue(["mcp:read", "mcp:write"]);
    const v = await verifyAccessToken(token, suDb);
    expect(v).not.toBeNull();
    expect(v?.userId).toBe(userId);
    expect(v?.tenantId).toBe(tenantId);
    expect(v?.role).toBe("TENANT_ADMIN");
    expect(v?.scopes).toEqual(["mcp:read", "mcp:write"]);
  });

  test("revocation is immediate (jti denylist)", async () => {
    const { token, jti } = await issue();
    expect(await verifyAccessToken(token, suDb)).not.toBeNull();
    await revokeAccessToken(jti, suDb);
    expect(await verifyAccessToken(token, suDb)).toBeNull();
  });

  test("a tampered token is rejected", async () => {
    const { token } = await issue();
    const tampered = `${token.slice(0, -2)}xx`;
    expect(await verifyAccessToken(tampered, suDb)).toBeNull();
  });

  test("an issued token is bound to our canonical resource id (RFC 8707 aud)", async () => {
    const { token } = await issue();
    expect(decodeJwt(token).aud).toBe(mcpResourceId());
  });

  // Brand rename compatibility window. We SIGN only the current issuer, but verify accepts the
  // pre-rename one so access tokens minted by the previous image do not 401 mid-deploy. The window
  // that has to be covered is the 15-minute access TTL — refresh tokens are opaque (no issuer), so
  // the first rotation after the upgrade already mints under the current one. Dropped at 2.0.
  test("we sign the current issuer", async () => {
    const { token } = await issue();
    expect(decodeJwt(token).iss).toBe("fazerai:mcp");
  });

  test("a token carrying the pre-rename issuer still verifies", async () => {
    // Reuse a real jti so the denylist lookup finds its row; only the `iss` claim differs from
    // what we mint today.
    const { jti } = await issue(["mcp:read"]);
    const legacy = await new SignJWT({
      tenant_id: tenantId.toString(),
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setJti(jti)
      .setIssuer("secretaria-v4:mcp")
      .setAudience(mcpResourceId())
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(config.mcpJwtSecret));
    const v = await verifyAccessToken(legacy, suDb);
    expect(v).not.toBeNull();
    expect(v?.userId).toBe(userId);
    expect(v?.jti).toBe(jti);
  });

  test("an unknown issuer is still rejected", async () => {
    const { jti } = await issue(["mcp:read"]);
    const foreign = await new SignJWT({
      tenant_id: tenantId.toString(),
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setJti(jti)
      .setIssuer("evil:mcp")
      .setAudience(mcpResourceId())
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(config.mcpJwtSecret));
    expect(await verifyAccessToken(foreign, suDb)).toBeNull();
  });

  test("a token bound to a different audience is rejected (RFC 8707)", async () => {
    // Signed with OUR mcp secret, correct issuer/alg, but a foreign aud → must not verify.
    const forged = await new SignJWT({
      tenant_id: tenantId.toString(),
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setJti("forged-aud")
      .setIssuer("fazerai:mcp")
      .setAudience("https://evil.example.com/api/v1/mcp")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(config.mcpJwtSecret));
    expect(await verifyAccessToken(forged, suDb)).toBeNull();
  });

  test("a token signed with the APP secret does not validate in the MCP realm", async () => {
    const appToken = await new SignJWT({
      role: "SUPER_ADMIN",
      scopes: ["mcp:admin"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(userId))
      .setJti("forged")
      .setIssuer("fazerai:mcp")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(config.jwtSecret));
    expect(await verifyAccessToken(appToken, suDb)).toBeNull();
  });

  test("a role change since issuance invalidates the token", async () => {
    const { token } = await issue();
    expect(await verifyAccessToken(token, suDb)).not.toBeNull();
    await suDb.$executeRawUnsafe(
      `UPDATE users SET role = 'AGENT' WHERE id = ${userId}`,
    );
    expect(await verifyAccessToken(token, suDb)).toBeNull();
    // restore for other tests
    await suDb.$executeRawUnsafe(
      `UPDATE users SET role = 'TENANT_ADMIN' WHERE id = ${userId}`,
    );
  });

  test("an expired persisted token is rejected even with a valid signature", async () => {
    const { token, jti } = await issue();
    await suDb.$executeRawUnsafe(
      `UPDATE mcp_oauth_access_tokens SET expires_at = now() - interval '1 hour' WHERE jti = '${jti}'`,
    );
    expect(await verifyAccessToken(token, suDb)).toBeNull();
  });
});
