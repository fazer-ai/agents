import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type ChatwootClient, createChatwootClient } from "./client";

// Loads a ChatwootClient for a tenant's instance with both tokens decrypted. Single place that
// resolves the instance + decrypts creds; reused by the runtime and any admin-token
// operation (e.g. the kanban_move_card agent tool). The instance read is scoped (RLS); the
// SSRF-validated client construction (which resolves DNS) happens after, outside the transaction.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface LoadChatwootClientDeps {
  base?: PrismaClient;
  // NOTE: injectable factory for tests; defaults to the real SSRF-validated factory.
  makeClient?: (
    cfg: ConstructorParameters<typeof ChatwootClient>[0],
  ) => Promise<ChatwootClient>;
  // The persona bot token to act AS (bot-token endpoints: send/toggle/assign). Default "" =
  // admin-only client (the bot identity now lives per-persona on ChatwootAgentBot, not the instance).
  botToken?: string;
}

export async function loadChatwootClient(
  tenantId: bigint,
  instanceId: bigint,
  deps: LoadChatwootClientDeps = {},
): Promise<ChatwootClient> {
  const base = deps.base ?? basePrisma;
  // baseUrl + admin token live on the parent deployment (shared across the tenant's accounts); the
  // accountId is per-instance. Single scoped read joins them.
  const instance = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: {
        accountId: true,
        deployment: { select: { baseUrl: true, adminToken: true } },
      },
    }),
  );
  const factory = deps.makeClient ?? createChatwootClient;
  return factory({
    baseUrl: instance.deployment.baseUrl,
    accountId: instance.accountId,
    adminToken: decryptJson<string>(instance.deployment.adminToken),
    botToken: deps.botToken ?? "",
  });
}

// Resolves the persona's Chatwoot Agent Bot for an instance: its numeric id (the gate's "our bot")
// + decrypted access token (used to post the persona's replies / act on its conversations). null
// when the persona has no bot on this instance yet (never bound here). Scoped (RLS).
// A persona's Agent Bot as the two things a caller ever needs together: the token it speaks with, and
// the numeric id the conversation knows it by. Kept as one type because resolving one without the
// other is how a message gets sent by an identity nobody checked.
export interface AgentBotIdentity {
  chatwootAgentBotId: number;
  accessToken: string;
}

export async function loadAgentBot(
  tenantId: bigint,
  instanceId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<AgentBotIdentity | null> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootAgentBot.findUnique({
      where: {
        tenantId_chatwootInstanceId_agentId: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
        },
      },
      select: { chatwootAgentBotId: true, accessToken: true },
    }),
  );
  return row
    ? {
        chatwootAgentBotId: row.chatwootAgentBotId,
        accessToken: decryptJson<string>(row.accessToken),
      }
    : null;
}
