// What a voice agent needs to carry a call, resolved from its settings: the ElevenLabs key out of the
// vault, the voice, and the agent on ElevenLabs, created or brought in step on the way. Run by the
// console after every save and by every call as it opens; the second costs nothing when nothing changed.

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";
import { dbConfigDigests } from "./providers/config-digests";
import {
  checkElevenLabsAgentsAccess,
  deleteElevenLabsAgent,
  ensureElevenLabsAgent,
} from "./providers/elevenlabs-agent";
import { CONFIG_HOLD_LEASE_MS, dbEngineHold } from "./providers/engine-hold";
import { type CallsConfig, readCallsConfig } from "./settings";

export interface CallsSetup {
  calls: CallsConfig;
  apiKey: string;
  voice: string;
  elevenLabsAgentId: string;
}

export type CallsProblem =
  | "agent_not_found"
  | "not_voice_agent"
  | "no_credential"
  | "credential_unusable"
  | "invalid_key"
  | "missing_permission"
  | "unreachable"
  | "sync_failed";

export type CallsSetupResult =
  | { ok: true; setup: CallsSetup }
  | { ok: false; problem: CallsProblem; detail?: string };

/** Three steps, so no request to ElevenLabs runs inside a database transaction: read, sync, write back. */
export async function setUpAgentCalls(
  ctx: TenantContext,
  agentId: bigint,
  opts: {
    checkAccess?: boolean;
    fetchImpl?: typeof fetch;
    base?: PrismaClient;
    // Set on the one retry a lost race earns (below).
    retried?: boolean;
  } = {},
): Promise<CallsSetupResult> {
  const base = opts.base ?? basePrisma;
  const read = await runScopedOn(base, ctx, async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { name: true, kind: true, settings: true },
    });
    if (!agent)
      return { ok: false as const, problem: "agent_not_found" as const };
    if (agent.kind !== "voice")
      return { ok: false as const, problem: "not_voice_agent" as const };
    const calls = readCallsConfig(agent.settings);
    if (!calls.credentialRef)
      return { ok: false as const, problem: "no_credential" as const };
    const key = await tryResolveApiKeyEntry(db, calls.credentialRef);
    if (key.state !== "ok")
      return { ok: false as const, problem: "credential_unusable" as const };
    return {
      ok: true as const,
      name: agent.name,
      calls,
      apiKey: key.secret,
      voice: calls.voice,
    };
  });
  if (!read.ok) return read;
  const { calls, apiKey, voice } = read;
  if (opts.checkAccess) {
    const access = await checkElevenLabsAgentsAccess(apiKey, opts.fetchImpl);
    if (!access.ok)
      return { ok: false, problem: access.reason, detail: access.detail };
  }
  let elevenLabsAgentId: string;
  try {
    elevenLabsAgentId = await ensureElevenLabsAgent(
      apiKey,
      calls.elevenLabsAgentId,
      { name: `${read.name} (fazer.ai agents #${agentId})`, voice, calls },
      opts.fetchImpl,
      dbConfigDigests(base),
      dbEngineHold(CONFIG_HOLD_LEASE_MS, base),
    );
  } catch (err) {
    return {
      ok: false,
      problem: "sync_failed",
      detail: (err as Error).message,
    };
  }
  if (elevenLabsAgentId !== calls.elevenLabsAgentId) {
    // A system write into the operator's block, by SQL so `updated_at` stays: an editor open on this
    // agent must not read it as somebody else's save. An agent saved before it had a calls block gets
    // one, or the next call would create another agent on the tenant's account. Only over the id this
    // setup read: two setups that both found none (a call and the editor's check) both create one, and
    // the one that loses deletes its own and takes the winner's.
    const stored = calls.elevenLabsAgentId;
    const written = await runScopedOn(
      base,
      ctx,
      (db) =>
        db.$executeRaw`UPDATE agents SET settings = jsonb_set(CASE WHEN jsonb_typeof(settings -> 'calls') = 'object' THEN settings ELSE settings || '{"calls": {}}'::jsonb END, '{calls,elevenLabsAgentId}', to_jsonb(${elevenLabsAgentId}::text), true) WHERE id = ${agentId} AND (settings -> 'calls' ->> 'elevenLabsAgentId') IS NOT DISTINCT FROM ${stored}::text`,
    );
    if (written === 0) {
      await deleteElevenLabsAgent(
        apiKey,
        elevenLabsAgentId,
        opts.fetchImpl,
        dbConfigDigests(base),
      );
      // The winner's id is checked as this setup checked its own: read again, key included, since the
      // key may have changed with it and an id is only good on the account that holds it. Once.
      if (opts.retried)
        return {
          ok: false,
          problem: "sync_failed",
          detail:
            "the ElevenLabs agent id kept changing while it was being set",
        };
      return setUpAgentCalls(ctx, agentId, { ...opts, retried: true });
    }
  }
  return { ok: true, setup: { calls, apiKey, voice, elevenLabsAgentId } };
}
