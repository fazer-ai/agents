import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import type { ChatwootClient } from "./client";
import { invalidateRouteTokenCache } from "./route-token-cache";
import { chatwootOutgoingUrl } from "./webhook-mount";

// Agent Bot provisioning: ONE Chatwoot Agent Bot per (instance, our Agent persona) — the bot is the
// message sender shown in Chatwoot, so each persona gets its own visible identity (name = the
// persona's name). Provisioning is LAZY — ensureAgentBot runs the first time an operator binds a
// persona to an inbox of the instance (see bindInbox); connecting the bot to specific inboxes is the
// binder's job. The bot's `secret` IS the HMAC key the receiver verifies (fork-confirmed); the route
// token is embedded in the outgoing_url and only its SHA-256 hash is stored. All network I/O happens
// OUTSIDE any transaction; the persist is a short scoped tx.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export interface EnsuredAgentBot {
  chatwootAgentBotId: number;
  accessToken: string; // decrypted
}

interface CreatedAgentBot {
  id: number;
  accessToken: string;
  secret: string;
}

function parseCreatedAgentBot(raw: unknown): CreatedAgentBot {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError("Chatwoot agent_bot create: unexpected response", 502);
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : Number(r.id);
  const accessToken = r.access_token;
  const secret = r.secret;
  if (
    !Number.isFinite(id) ||
    typeof accessToken !== "string" ||
    typeof secret !== "string"
  ) {
    throw new AppError(
      "Chatwoot agent_bot create: missing id/access_token/secret",
      502,
    );
  }
  return { id, accessToken, secret };
}

export interface EnsureAgentBotDeps {
  base?: PrismaClient;
}

// Lazy, idempotent per-persona provisioning: ensure (instance, agentId) has its own Chatwoot Agent
// Bot, creating it on the first bind and reusing it after. Returns the bot's numeric id + decrypted
// access token (the binder connects it to the inbox; the runtime posts with the token). The CALLER
// supplies an admin-capable ChatwootClient. Network (createAgentBot) is outside the tx; persist is a
// short scoped tx. The bot is named after the persona (kept in sync on rename via renameAgentBots).
export async function ensureAgentBot(
  tenantId: bigint,
  instanceId: bigint,
  agentId: bigint,
  agentName: string,
  client: ChatwootClient,
  deps: EnsureAgentBotDeps = {},
): Promise<EnsuredAgentBot> {
  const base = deps.base ?? basePrisma;
  const key = {
    tenantId_chatwootInstanceId_agentId: {
      tenantId,
      chatwootInstanceId: instanceId,
      agentId,
    },
  };

  const existing = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootAgentBot.findUnique({
      where: key,
      select: { chatwootAgentBotId: true, accessToken: true },
    }),
  );
  if (existing) {
    // Self-heal: only reuse the stored bot if it STILL exists on Chatwoot. An operator can delete the
    // bot out-of-band; reusing its dead id/token would 401 every reply. If it's gone, fall through to
    // re-provision and refresh THIS row in place (so re-binding the inbox repairs it).
    const live = await client.listAgentBots();
    if (live.some((b) => b.id === existing.chatwootAgentBotId)) {
      return {
        chatwootAgentBotId: existing.chatwootAgentBotId,
        accessToken: decryptJson<string>(existing.accessToken),
      };
    }
    logger.warn(
      "chatwoot: stored bot %d gone on Chatwoot (instance %s, agent %s) — re-provisioning",
      existing.chatwootAgentBotId,
      String(instanceId),
      String(agentId),
    );
  }

  const { token: routeToken, hash: routeTokenHash } = generateRouteToken();
  const outgoingUrl = chatwootOutgoingUrl(config.publicUrl, routeToken);
  const created = parseCreatedAgentBot(
    await client.createAgentBot({ name: agentName, outgoingUrl }),
  );

  // Re-provision path: the row exists but its Chatwoot bot was deleted — refresh it in place (the
  // (tenant, instance, agent) unique key is unchanged, so no insert/race).
  if (existing) {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootAgentBot.update({
        where: key,
        data: {
          chatwootAgentBotId: created.id,
          accessToken: encryptJson(created.accessToken),
          webhookSecret: encryptJson(created.secret),
          webhookRouteTokenHash: routeTokenHash,
          name: agentName,
        },
      }),
    );
    // The row's route-token hash just changed, so the PREVIOUS hash is now orphaned. The receiver
    // caches resolutions by hash, and a stale entry would keep accepting the retired token for the
    // length of its TTL. The old hash is not in hand here, so drop the whole cache: re-provisioning
    // is rare and the cache refills on the next event.
    invalidateRouteTokenCache();
    logger.info(
      "chatwoot: re-provisioned agent bot %d for instance %s / agent %s (old bot was deleted)",
      created.id,
      String(instanceId),
      String(agentId),
    );
    return { chatwootAgentBotId: created.id, accessToken: created.accessToken };
  }

  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: created.id,
          accessToken: encryptJson(created.accessToken),
          webhookSecret: encryptJson(created.secret),
          webhookRouteTokenHash: routeTokenHash,
          name: agentName,
        },
      }),
    );
    logger.info(
      "chatwoot: provisioned agent bot %d for instance %s / agent %s (lazy, on first bind)",
      created.id,
      String(instanceId),
      String(agentId),
    );
    return { chatwootAgentBotId: created.id, accessToken: created.accessToken };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a concurrent first-bind race (unique on tenant+instance+agent). Our freshly-created bot is
    // orphaned on Chatwoot (rare — admin-only); adopt the winner's row to keep our DB consistent.
    logger.warn(
      "chatwoot: ensureAgentBot lost the race for instance %s / agent %s; bot %d orphaned",
      String(instanceId),
      String(agentId),
      created.id,
    );
    const winner = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootAgentBot.findUniqueOrThrow({
        where: key,
        select: { chatwootAgentBotId: true, accessToken: true },
      }),
    );
    return {
      chatwootAgentBotId: winner.chatwootAgentBotId,
      accessToken: decryptJson<string>(winner.accessToken),
    };
  }
}

// Keep each Chatwoot bot's visible name in sync with its persona's name (the bot is the sender shown
// in conversations). Renames every bot the persona owns (one per instance it's bound on). Best-effort
// per bot: a Chatwoot failure logs and is skipped (our row name is still updated as the source of
// truth) so a rename never fails the agent update; the next bind/edit can reconcile.
export async function renameAgentBots(
  tenantId: bigint,
  agentId: bigint,
  name: string,
  deps: { base?: PrismaClient; makeClient?: LoadClientFactory } = {},
): Promise<void> {
  const base = deps.base ?? basePrisma;
  const bots = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootAgentBot.findMany({
      where: { agentId },
      select: { id: true, chatwootInstanceId: true, chatwootAgentBotId: true },
    }),
  );
  for (const bot of bots) {
    try {
      const client = await loadChatwootClient(
        tenantId,
        bot.chatwootInstanceId,
        {
          base,
          makeClient: deps.makeClient,
        },
      );
      await client.updateAgentBot(bot.chatwootAgentBotId, { name });
    } catch (err) {
      logger.warn(
        "chatwoot: renameAgentBot failed (bot %d): %s",
        bot.chatwootAgentBotId,
        err instanceof Error ? err.message : String(err),
      );
    }
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootAgentBot.update({ where: { id: bot.id }, data: { name } }),
    );
  }
}

type LoadClientFactory = (
  cfg: ConstructorParameters<typeof ChatwootClient>[0],
) => Promise<ChatwootClient>;
