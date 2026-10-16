// Which voice agent answers an inbox's calls, beside the text agent that answers its messages. The
// answer lives on the Chatwoot fork too (the inbox's `ai_voice`: a switch and the URL its calls'
// audio goes to), written whenever what decides it changes here: the binding, or the voice agent's
// switch and mode. Only an enabled voice agent in production answers; a test one leaves the calls
// ringing the human agents. The URL carries the inbox's own route token, minted once and never
// rotated, and every write sends it whole: two racing writes differ only in the switch, and each
// re-reads the binding afterwards and writes again when it moved, so the fork converges on the last.

import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeAgentMode } from "@/modules/agents/mode";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { ensureAgentBot } from "@/modules/chatwoot/provisioning";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { WHATSAPP_CHANNEL } from "./channel";

export const VOICE_STREAM_MOUNT = "/api/v1/voice/stream";

/** Where the fork sends an inbox's call audio: this deployment, over WebSocket, with the inbox's token. */
export function voiceStreamUrl(publicUrl: string, routeToken: string): string {
  const base = publicUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}${VOICE_STREAM_MOUNT}/${routeToken}`;
}

interface VoiceBinding {
  chatwootInstanceId: bigint;
  chatwootInboxId: number;
  voiceAgentId: bigint | null;
  voiceRouteToken: string | null;
}

const BINDING_SELECT = {
  chatwootInstanceId: true,
  chatwootInboxId: true,
  voiceAgentId: true,
  voiceRouteToken: true,
} as const;

function sameBinding(a: VoiceBinding, b: VoiceBinding): boolean {
  return a.voiceAgentId === b.voiceAgentId;
}

/** Whether the inbox's calls go to its voice agent: one is bound, switched on, in production. */
async function answers(
  ctx: TenantContext,
  binding: VoiceBinding,
  base: PrismaClient,
): Promise<boolean> {
  if (binding.voiceAgentId === null) return false;
  const agent = await runScopedOn(base, ctx, (db) =>
    db.agent.findUnique({
      where: { id: binding.voiceAgentId as bigint },
      select: { enabled: true, mode: true, kind: true },
    }),
  );
  return (
    !!agent &&
    agent.kind === "voice" &&
    agent.enabled &&
    normalizeAgentMode(agent.mode) === "production"
  );
}

async function writeToFork(
  tenantId: bigint,
  binding: VoiceBinding,
  on: boolean,
  base: PrismaClient,
  deps: LoadChatwootClientDeps,
): Promise<void> {
  if (!binding.voiceRouteToken) return;
  const client = await loadChatwootClient(
    tenantId,
    binding.chatwootInstanceId,
    {
      base,
      makeClient: deps.makeClient,
    },
  );
  await client.setVoiceAgent(
    binding.chatwootInboxId,
    on,
    voiceStreamUrl(
      config.publicUrl,
      decryptJson<string>(binding.voiceRouteToken),
    ),
  );
}

/** Writes one inbox's binding to the fork, again while it keeps moving under the write. */
async function syncInbox(
  ctx: TenantContext,
  inboxId: bigint,
  base: PrismaClient,
  deps: LoadChatwootClientDeps,
): Promise<void> {
  const tenantId = ctx.tenantId as bigint;
  const read = () =>
    runScopedOn(base, ctx, (db) =>
      db.inbox.findUnique({ where: { id: inboxId }, select: BINDING_SELECT }),
    );
  let binding = await read();
  // NOTE: bounded: each pass follows a binding that committed after the previous one was read.
  for (let pass = 0; binding && pass < 3; pass++) {
    await writeToFork(
      tenantId,
      binding,
      await answers(ctx, binding, base),
      base,
      deps,
    );
    const after = await read();
    if (!after || sameBinding(binding, after)) return;
    binding = after;
  }
}

/**
 * Binds a voice agent to an inbox's calls, or unbinds it (`agentId` null). Refuses an inbox that is
 * not WhatsApp (422) and an agent that is not a voice agent (422). 502 when the fork could not be
 * written; the binding is kept, and the next save of the agent writes it again.
 */
export async function bindInboxVoiceAgent(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint | null,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ voiceAgentId: string | null }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const bound = await runScopedOn(base, ctx, async (db) => {
    const inbox = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        channelType: true,
        voiceRouteToken: true,
        chatwootInstanceId: true,
      },
    });
    if (!inbox) throw new NotFoundError("inbox not found");
    if (inbox.channelType !== WHATSAPP_CHANNEL)
      throw new AppError(
        "only a WhatsApp inbox takes calls",
        422,
        "errors.voiceInboxNotWhatsapp",
      );
    let agentName: string | null = null;
    if (agentId !== null) {
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { kind: true, name: true },
      });
      if (!agent) throw new NotFoundError("agent not found");
      if (agent.kind !== "voice")
        throw new AppError(
          "only a voice agent answers calls",
          422,
          "errors.voiceAgentRequired",
        );
      agentName = agent.name;
    }
    const minted = inbox.voiceRouteToken ? null : generateRouteToken();
    await db.inbox.update({
      where: { id: inboxId },
      data: {
        voiceAgentId: agentId,
        ...(minted
          ? {
              voiceRouteToken: encryptJson(minted.token),
              voiceRouteTokenHash: minted.hash,
            }
          : {}),
      },
    });
    return { instanceId: inbox.chatwootInstanceId, agentName };
  });
  try {
    // The agent's own bot, never attached to the inbox: the identity its notes about a call are
    // posted under (`reportCall`).
    if (agentId !== null && bound.agentName !== null) {
      const client = await loadChatwootClient(ctx.tenantId, bound.instanceId, {
        base,
        makeClient: deps.makeClient,
      });
      await ensureAgentBot(
        ctx.tenantId,
        bound.instanceId,
        agentId,
        bound.agentName,
        client,
        { base },
      );
    }
    await syncInbox(ctx, inboxId, base, deps);
  } catch (err) {
    logger.warn(
      "voice-call: could not write inbox %s's voice agent to Chatwoot: %s",
      String(inboxId),
      (err as Error).message,
    );
    throw new AppError(
      "Chatwoot could not be reached",
      502,
      "errors.voiceInboxChatwootUnreachable",
    );
  }
  return { voiceAgentId: agentId === null ? null : String(agentId) };
}

/** Writes, on every inbox whose calls this voice agent answers, whether it answers them now. */
export async function syncVoiceAgentInboxes(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
  deps: LoadChatwootClientDeps = {},
): Promise<void> {
  if (ctx.tenantId === null) return;
  const inboxes = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { voiceAgentId: agentId },
      select: { id: true },
    }),
  );
  for (const inbox of inboxes) {
    try {
      await syncInbox(ctx, inbox.id, base, deps);
    } catch (err) {
      logger.warn(
        "voice-call: could not write inbox %s's voice agent to Chatwoot: %s",
        String(inbox.id),
        (err as Error).message,
      );
    }
  }
}
