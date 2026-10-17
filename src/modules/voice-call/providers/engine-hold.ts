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
  release(): Promise<void>;
}

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
      const rows = await base.$queryRaw<{ declared_digest: string | null }[]>`
        INSERT INTO voice_engine_holds (engine_agent_id, holder, held_until)
        VALUES (${engineAgentId}, ${holder}::uuid, now() + ${leaseMs} * interval '1 millisecond')
        ON CONFLICT (engine_agent_id) DO UPDATE
          SET holder = EXCLUDED.holder, held_until = EXCLUDED.held_until
          WHERE voice_engine_holds.held_until IS NULL
             OR voice_engine_holds.held_until < now()
        RETURNING declared_digest`;
      const row = rows[0];
      if (row) {
        // Every write names this hold, so one whose lease passed and was taken changes nothing.
        return {
          declaredDigest: row.declared_digest,
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
