import type { ConfigDigests } from "@/modules/voice-call/providers/config-digests";
import type {
  EngineHold,
  HoldEngineAgent,
} from "@/modules/voice-call/providers/engine-hold";

// The engine hold of one process, for provider tests that run no database: holds queue per agent and
// what was declared or configured is remembered across holds, as the database row does. `configs` is
// shared with `memoryConfigDigests` when a test needs both views of the same row.
export function memoryEngineHold(
  configs: Map<string, string> = new Map(),
): HoldEngineAgent {
  const declared = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  const put = (map: Map<string, string>, id: string, d: string | null) => {
    if (d === null) map.delete(id);
    else map.set(id, d);
  };
  return async (agentId, signal) => {
    const before = tails.get(agentId) ?? Promise.resolve();
    let free = () => {};
    tails.set(
      agentId,
      new Promise<void>((resolve) => {
        free = resolve;
      }),
    );
    await Promise.race([
      before,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    ]);
    const hold: EngineHold = {
      declaredDigest: declared.get(agentId) ?? null,
      markDeclared: async (digest) => put(declared, agentId, digest),
      configDigest: configs.get(agentId) ?? null,
      markConfigured: async (digest) => put(configs, agentId, digest),
      release: async () => free(),
    };
    return hold;
  };
}

// The configuration digests of one process, over the same map a `memoryEngineHold` is given.
export function memoryConfigDigests(
  configs: Map<string, string> = new Map(),
): ConfigDigests {
  return {
    read: async (id) => configs.get(id) ?? null,
    write: async (id, digest) => {
      if (digest === null) configs.delete(id);
      else configs.set(id, digest);
    },
  };
}
