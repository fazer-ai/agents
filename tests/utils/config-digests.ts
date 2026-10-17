import type { ConfigDigests } from "@/modules/voice-call/providers/config-digests";

// The configuration digests of one process, for tests that run no database: what the shared row
// would hold, in a map.
export function memoryConfigDigests(): ConfigDigests {
  const digests = new Map<string, string>();
  return {
    read: async (id) => digests.get(id) ?? null,
    write: async (id, digest) => {
      if (digest === null) digests.delete(id);
      else digests.set(id, digest);
    },
  };
}
