import { randomBytes, timingSafeEqual } from "node:crypto";
import logger from "@/api/lib/logger";
import prisma from "@/api/lib/prisma";
import config from "@/config";

// In-memory state is a UX optimization so /auth/me and the signup gates
// can answer "is setup still pending?" without a query on the happy path. It is
// NOT the race guard: the atomic insert in createInitialAdmin (advisory lock +
// re-check) is what guarantees a single bootstrap, correct even across
// instances that each hold their own stale flag.
let setupToken: string | null = null;
let setupComplete = false;

function generateSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function initSetupState(): Promise<void> {
  const existing = await prisma.user.findFirst({ select: { id: true } });
  if (existing) {
    setupComplete = true;
    setupToken = null;
    return;
  }

  setupComplete = false;
  const setupUrl = `${config.publicUrl}/setup`;
  if (config.setupTokenRequired) {
    setupToken = generateSetupToken();
    logger.info(
      `First-run setup required: no users exist yet. Create the initial admin account at ${setupUrl}?token=${setupToken}`,
    );
  } else {
    setupToken = null;
    logger.info(
      `First-run setup required: no users exist yet. SETUP_TOKEN_REQUIRED is disabled; create the initial admin account at ${setupUrl}`,
    );
  }
}

export function isSetupRequired(): boolean {
  return !setupComplete;
}

// Self-heals a stale in-memory `setupComplete=false` (a no-op once the local flag is true):
// (1) the DB has users (another replica or `bun set-admin` created the first one): flip the flag;
// (2) no users AND no `setupToken` (a boot-time DB outage stopped `initSetupState()` before it made
//     one): generate and log it now, or SETUP_TOKEN_REQUIRED stays broken here until a restart.
export async function refreshSetupState(): Promise<void> {
  if (setupComplete) return;
  const existing = await prisma.user.findFirst({ select: { id: true } });
  if (existing) {
    completeSetup();
    return;
  }
  if (config.setupTokenRequired && !setupToken) {
    setupToken = generateSetupToken();
    logger.info(
      `First-run setup required: no users exist yet. Create the initial admin account at ${config.publicUrl}/setup?token=${setupToken}`,
    );
  }
}

export function isSetupTokenRequired(): boolean {
  return config.setupTokenRequired;
}

export function verifySetupToken(token?: string): boolean {
  if (!config.setupTokenRequired) return true;
  if (!setupToken || typeof token !== "string") return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(setupToken);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function completeSetup(): void {
  setupComplete = true;
  setupToken = null;
}
