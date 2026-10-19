// Which voice agent answers an inbox's calls, beside the text agent that answers its messages. The
// answer lives on the Chatwoot fork too (the inbox's `ai_voice`: a switch and the URL its calls'
// audio goes to), written whenever what decides it changes here: the binding, or the voice agent's
// switch and mode. Only an enabled voice agent in production answers; a test one leaves the calls
// ringing the human agents. The URL carries the inbox's own route token, minted once and never
// rotated, and every write sends it whole: two racing writes differ only in the switch, and each
// re-reads the binding and whether it answers afterwards, and writes again when either moved, so the
// fork converges on the last.

import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeAgentMode } from "@/modules/agents/mode";
import { auditMutation } from "@/modules/audit/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { ensureAgentBot } from "@/modules/chatwoot/provisioning";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { takesCalls, WHATSAPP_CHANNEL } from "./channel";

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
  instance: { disconnectedAt: Date | null };
}

const BINDING_SELECT = {
  chatwootInstanceId: true,
  chatwootInboxId: true,
  voiceAgentId: true,
  voiceRouteToken: true,
  instance: { select: { disconnectedAt: true } },
} as const;

/**
 * Whether the inbox's calls go to its voice agent: the account is connected, and one is bound,
 * switched on, in production. The same question `resolveVoiceRoute` asks of a call.
 */
async function answers(
  ctx: TenantContext,
  binding: VoiceBinding,
  base: PrismaClient,
): Promise<boolean> {
  if (binding.voiceAgentId === null || binding.instance.disconnectedAt !== null)
    return false;
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

// Before the calls are written, the bound agent's own bot: the identity its notes about a call are
// posted under (`reportCall`), never attached to the inbox. Here and not only on binding, so the
// write that repairs a binding also repairs a bot that could not be created then.
async function writeToFork(
  ctx: TenantContext,
  binding: VoiceBinding,
  on: boolean,
  base: PrismaClient,
  deps: LoadChatwootClientDeps,
  // The account's client, kept by a caller that may have to write again after the rows are gone.
  clients?: Map<bigint, ChatwootClient>,
): Promise<void> {
  if (!binding.voiceRouteToken) return;
  const tenantId = ctx.tenantId as bigint;
  const client =
    clients?.get(binding.chatwootInstanceId) ??
    (await loadChatwootClient(tenantId, binding.chatwootInstanceId, {
      base,
      makeClient: deps.makeClient,
    }));
  clients?.set(binding.chatwootInstanceId, client);
  const agentId = binding.voiceAgentId;
  // Only to switch the calls on: switching them off must not wait on a bot it does not use.
  if (on && agentId !== null) {
    const agent = await runScopedOn(base, ctx, (db) =>
      db.agent.findUnique({ where: { id: agentId }, select: { name: true } }),
    );
    if (agent)
      await ensureAgentBot(
        tenantId,
        binding.chatwootInstanceId,
        agentId,
        agent.name,
        client,
        { base },
      );
  }
  await client.setVoiceAgent(
    binding.chatwootInboxId,
    on,
    voiceStreamUrl(
      config.publicUrl,
      decryptJson<string>(binding.voiceRouteToken),
    ),
  );
}

/**
 * Switches the calls off on the fork for every inbox of these accounts (all of the tenant's when none
 * are named) that routes them to us, before a removal deletes the rows: the route token and the account
 * credentials go with them, and a call routed to a token that no longer resolves is answered by nobody,
 * where a call with routing off rings the team. Best-effort, one failure not stopping the others.
 */
export async function switchOffVoiceRouting(
  ctx: TenantContext,
  instanceIds: bigint[] | null,
  base: PrismaClient = basePrisma,
  deps: LoadChatwootClientDeps = {},
): Promise<void> {
  if (ctx.tenantId === null) return;
  const routed = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: {
        voiceRouteToken: { not: null },
        ...(instanceIds ? { chatwootInstanceId: { in: instanceIds } } : {}),
      },
      select: BINDING_SELECT,
    }),
  );
  for (const binding of routed) {
    try {
      // No agent: switching off needs no bot to post under.
      await writeToFork(
        ctx,
        { ...binding, voiceAgentId: null },
        false,
        base,
        deps,
      );
    } catch (err) {
      logger.warn(
        "voice-call: could not switch inbox %s's calls off before removing it: %s",
        String(binding.chatwootInboxId),
        (err as Error).message,
      );
    }
  }
}

// A binding still moving after a sync's passes is written again this much later, this many times.
const SYNC_RETRY_MS = 1_000;
const SYNC_RETRIES = 2;

/** Writes one inbox's binding to the fork, again while it keeps moving under the write. */
async function syncInbox(
  ctx: TenantContext,
  inboxId: bigint,
  base: PrismaClient,
  deps: LoadChatwootClientDeps,
  retries = SYNC_RETRIES,
): Promise<void> {
  const read = () =>
    runScopedOn(base, ctx, (db) =>
      db.inbox.findUnique({ where: { id: inboxId }, select: BINDING_SELECT }),
    );
  let binding = await read();
  if (!binding) return;
  let on = await answers(ctx, binding, base);
  const clients = new Map<bigint, ChatwootClient>();
  // NOTE: bounded: each pass follows a binding, or an agent switch or mode, that committed after the
  // previous one was read.
  for (let pass = 0; pass < 3; pass++) {
    await writeToFork(ctx, binding, on, base, deps, clients);
    const after = await read();
    if (!after) {
      // Removed while this wrote (an account or deployment removal): its own switch-off may have
      // landed before this write, so the calls are switched off again, with the client loaded
      // before the credentials went.
      if (on)
        await writeToFork(
          ctx,
          { ...binding, voiceAgentId: null },
          false,
          base,
          deps,
          clients,
        );
      return;
    }
    const nowOn = await answers(ctx, after, base);
    if (
      after.voiceAgentId === binding.voiceAgentId &&
      after.voiceRouteToken === binding.voiceRouteToken &&
      nowOn === on
    )
      return;
    binding = after;
    on = nowOn;
  }
  // Still moving after the last pass: the newest write on the fork may be an older state's, which no
  // later save would correct. Written again shortly, apart from the caller, whose own write is done.
  if (retries === 0) {
    logger.warn(
      "voice-call: inbox %s's voice binding kept changing while it was written; the next save repairs it",
      String(inboxId),
    );
    return;
  }
  setTimeout(() => {
    syncInbox(ctx, inboxId, base, deps, retries - 1).catch((err: Error) =>
      logger.warn(
        "voice-call: could not write inbox %s's voice agent to Chatwoot: %s",
        String(inboxId),
        err.message,
      ),
    );
  }, SYNC_RETRY_MS).unref?.();
}

/**
 * What refuses a voice binding, asked by the bind under its locks and by the MCP preview without
 * them: a disconnected account (409), an inbox that is not WhatsApp or not on the connector (422), an
 * agent that does not exist or is not a voice agent. `agentKind` is undefined when no agent is being
 * bound, null when the agent is gone. An unbind is never refused: a binding stored while the inbox's
 * provider was still unknown must stay clearable once the provider turns out to take no calls, or
 * it keeps the agent from being deleted.
 */
export function voiceBindingRefusal(state: {
  channelType: string | null;
  provider: string | null;
  disconnected: boolean;
  agentKind: string | null | undefined;
}): AppError | null {
  if (state.agentKind === undefined) return null;
  if (state.disconnected)
    return new AppError(
      "this account is disconnected; reconnect it before assigning an agent",
      409,
      "errors.chatwootAccountDisconnected",
    );
  if (state.channelType !== WHATSAPP_CHANNEL)
    return new AppError(
      "only a WhatsApp inbox takes calls",
      422,
      "errors.voiceInboxNotWhatsapp",
    );
  if (!takesCalls(state))
    return new AppError(
      "only a WhatsApp inbox on the fazer.ai connector takes calls",
      422,
      "errors.voiceInboxNotConnector",
    );
  if (state.agentKind === null) return new NotFoundError("agent not found");
  if (state.agentKind !== "voice")
    return new AppError(
      "only a voice agent answers calls",
      422,
      "errors.voiceAgentRequired",
    );
  return null;
}

/** The refusal `bindInboxVoiceAgent` would give, read without its locks (a preview). */
export async function checkVoiceBinding(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint | null,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const state = await runScopedOn(base, ctx, async (db) => {
    const inbox = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        channelType: true,
        provider: true,
        instance: { select: { disconnectedAt: true } },
      },
    });
    if (!inbox) throw new NotFoundError("inbox not found");
    const agent =
      agentId === null
        ? undefined
        : await db.agent.findUnique({
            where: { id: agentId },
            select: { kind: true },
          });
    return {
      channelType: inbox.channelType,
      provider: inbox.provider,
      disconnected: inbox.instance.disconnectedAt !== null,
      agentKind: agent === undefined ? undefined : (agent?.kind ?? null),
    };
  });
  const refusal = voiceBindingRefusal(state);
  if (refusal) throw refusal;
}

/**
 * Binds a voice agent to an inbox's calls, or unbinds it (`agentId` null). Refuses an inbox that is
 * not WhatsApp (422), an agent that is not a voice agent (422) and a disconnected account (409). 502
 * when the fork could not be written; the binding is kept, and the next save of any voice agent
 * writes it again.
 */
export async function bindInboxVoiceAgent(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint | null,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ voiceAgentId: string | null }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  await runScopedOn(base, ctx, async (db) => {
    const inbox = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        channelType: true,
        provider: true,
        chatwootInstanceId: true,
      },
    });
    if (!inbox) throw new NotFoundError("inbox not found");
    // In the module's order (account, agent, inbox), as the text binding takes them. The account
    // row first, so a disconnect cannot stamp it between this read and the commit. The agent as a
    // foreign key would lock it (`Inbox.voiceAgentId` has no `@relation`), so `deleteAgent` cannot
    // leave the binding pointing at nothing. The inbox last, so two first bindings do not both mint
    // a token: the second reads the first's.
    const account = await db.$queryRaw<{ disconnected_at: Date | null }[]>`
      SELECT disconnected_at FROM chatwoot_instances
       WHERE id = ${inbox.chatwootInstanceId} FOR NO KEY UPDATE`;
    const agent =
      agentId === null
        ? undefined
        : await db.$queryRaw<{ kind: string }[]>`
            SELECT kind FROM agents WHERE id = ${agentId} FOR KEY SHARE`;
    const refusal = voiceBindingRefusal({
      channelType: inbox.channelType,
      provider: inbox.provider,
      disconnected: account[0]?.disconnected_at != null,
      agentKind: agent === undefined ? undefined : (agent[0]?.kind ?? null),
    });
    if (refusal) throw refusal;
    const locked = await db.$queryRaw<
      { voice_route_token: string | null; voice_agent_id: bigint | null }[]
    >`
      SELECT voice_route_token, voice_agent_id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
    const minted = locked[0]?.voice_route_token ? null : generateRouteToken();
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
    // Who answers the inbox's calls, recorded as the text binding's `inbox.bind` is: only a change.
    const was = locked[0]?.voice_agent_id ?? null;
    if (was !== agentId)
      await auditMutation(db, ctx, {
        action: "inbox.bind_voice",
        target: `inbox:${inboxId}`,
        before: { voiceAgentId: was === null ? null : String(was) },
        after: { voiceAgentId: agentId === null ? null : String(agentId) },
      });
  });
  try {
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

/**
 * Writes, on every inbox whose calls this voice agent answers, whether it answers them now; and on
 * every inbox with no voice agent that ever had one, that its calls are off, which repairs an unbind
 * whose write to the fork failed.
 */
export async function syncVoiceAgentInboxes(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
  deps: LoadChatwootClientDeps = {},
): Promise<void> {
  if (ctx.tenantId === null) return;
  const inboxes = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: {
        OR: [
          { voiceAgentId: agentId },
          { voiceAgentId: null, voiceRouteToken: { not: null } },
        ],
      },
      select: { id: true },
    }),
  );
  await syncVoiceInboxes(ctx, inboxes, base, deps);
}

/** Writes each inbox's calls to the fork, one failure not stopping the others. */
export async function syncVoiceInboxes(
  ctx: TenantContext,
  inboxes: { id: bigint }[],
  base: PrismaClient = basePrisma,
  deps: LoadChatwootClientDeps = {},
): Promise<void> {
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
