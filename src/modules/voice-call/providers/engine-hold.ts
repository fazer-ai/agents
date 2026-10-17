import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";

// One call at a time starting on an ElevenLabs agent, across every process that takes calls: web
// replicas take them too (docs/deploy.md), and the tools a call declares on the shared agent carry
// its own conversation. The hold is a row lease (`voice_engine_holds`), timed by the database's clock
// so host skew plays no part; a process that dies holding it frees the agent when the lease passes.

/** What a call holds while it starts on an engine agent. */
export interface EngineHold {
  /** What the agent was last declared with, as written under a hold; null when unknown. */
  declaredDigest: string | null;
  /**
   * Records what this hold declared, so the next call skips the same declaration; null before a
   * declaration is sent, since one that applies and then fails leaves the agent carrying it unknown.
   */
  markDeclared(digest: string | null): Promise<void>;
  /** What the agent's configuration was last written with, as written under a hold. */
  configDigest: string | null;
  /** The same for the configuration: null before a write is sent, its digest once it applied. */
  markConfigured(digest: string | null): Promise<void>;
  release(): Promise<void>;
}

// A configuration write holds the agent for its one request (bounded at 15 s) and a margin.
export const CONFIG_HOLD_LEASE_MS = 20_000;
// How long a configuration write waits for the agent: past the longest hold a call's start takes at
// the default open deadline (three of 10 s plus 5 s), so a holder that is alive has let go by then.
export const CONFIG_HOLD_WAIT_MS = 40_000;

export type HoldEngineAgent = (
  engineAgentId: string,
  signal: AbortSignal,
) => Promise<EngineHold>;

// How often a call waiting for the agent asks again.
const RETRY_MS = 150;

/**
 * Holds through the database. `leaseMs` must outlast the longest start it covers: a lease that passes
 * while its call is still starting lets the next call overwrite the declaration under it.
 */
export function dbEngineHold(
  leaseMs: number,
  base: PrismaClient = basePrisma,
): HoldEngineAgent {
  return async (engineAgentId, signal) => {
    const holder = randomUUID();
    for (;;) {
      signal.throwIfAborted();
      const rows = await base.$queryRaw<
        { declared_digest: string | null; config_digest: string | null }[]
      >`
        INSERT INTO voice_engine_holds (engine_agent_id, holder, held_until)
        VALUES (${engineAgentId}, ${holder}::uuid, now() + ${leaseMs} * interval '1 millisecond')
        ON CONFLICT (engine_agent_id) DO UPDATE
          SET holder = EXCLUDED.holder, held_until = EXCLUDED.held_until
          WHERE voice_engine_holds.held_until IS NULL
             OR voice_engine_holds.held_until < now()
        RETURNING declared_digest, config_digest`;
      const row = rows[0];
      if (row) {
        // Every write names this hold, so one whose lease passed and was taken changes nothing.
        return {
          declaredDigest: row.declared_digest,
          configDigest: row.config_digest,
          markConfigured: async (digest) => {
            await base.$executeRaw`
              UPDATE voice_engine_holds SET config_digest = ${digest}
              WHERE engine_agent_id = ${engineAgentId} AND holder = ${holder}::uuid`;
          },
          markDeclared: async (digest) => {
            await base.$executeRaw`
              UPDATE voice_engine_holds SET declared_digest = ${digest}
              WHERE engine_agent_id = ${engineAgentId} AND holder = ${holder}::uuid`;
          },
          release: async () => {
            await base.$executeRaw`
              UPDATE voice_engine_holds SET holder = NULL, held_until = NULL
              WHERE engine_agent_id = ${engineAgentId} AND holder = ${holder}::uuid`;
          },
        };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, RETRY_MS);
        function done() {
          signal.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          reject(signal.reason);
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  };
}
