#!/usr/bin/env bun
// Dev helper: mint a session JWT for an existing user without knowing their
// password (same shape as setAuthCookie in src/api/lib/auth.ts). Use for local
// curl verification only; never commit credentials or print in CI.
import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";

const email = process.argv[2];
if (!email) {
  console.error("usage: bun scripts/mint-session.ts <email>");
  process.exit(1);
}

const user = await basePrisma.user.findFirst({
  where: { email: { equals: email, mode: "insensitive" } },
  select: {
    id: true,
    email: true,
    isSuperAdmin: true,
    passwordHash: true,
  },
});
if (!user) {
  console.error(`no user for ${email}`);
  process.exit(1);
}

const pwd = user.passwordHash
  ? createHmac("sha256", config.jwtSecret)
      .update(user.passwordHash)
      .digest("base64url")
      .slice(0, 22)
  : undefined;

const token = await new SignJWT({
  userId: user.id.toString(),
  email: user.email,
  role: user.isSuperAdmin ? "SUPER_ADMIN" : "TENANT_ADMIN",
  tenantId: null,
  ...(pwd ? { pwd } : {}),
})
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(config.jwtSecret));

console.log(token);
await basePrisma.$disconnect();
