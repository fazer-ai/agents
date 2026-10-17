import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";

// What each ElevenLabs agent's configuration was last written with, shared by every process that
// writes it (web replicas set calls up too, docs/deploy.md). A write is skipped only when the agent
// is known to carry it; the digest is forgotten before a write is sent, so one that applies and then
// fails leaves the agent unknown rather than recorded as what it was before.

export interface ConfigDigests {
  read(engineAgentId: string): Promise<string | null>;
  write(engineAgentId: string, digest: string | null): Promise<void>;
}

export function dbConfigDigests(
  base: PrismaClient = basePrisma,
): ConfigDigests {
  return {
    read: async (engineAgentId) => {
      const rows = await base.$queryRaw<{ config_digest: string | null }[]>`
        SELECT config_digest FROM voice_engine_holds
        WHERE engine_agent_id = ${engineAgentId}`;
      return rows[0]?.config_digest ?? null;
    },
    write: async (engineAgentId, digest) => {
      await base.$executeRaw`
        INSERT INTO voice_engine_holds (engine_agent_id, config_digest)
        VALUES (${engineAgentId}, ${digest})
        ON CONFLICT (engine_agent_id) DO UPDATE SET config_digest = EXCLUDED.config_digest`;
    },
  };
}
