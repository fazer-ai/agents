import type {
  EngineHold,
  HoldEngineAgent,
} from "@/modules/voice-call/providers/engine-hold";

// The engine hold of one process, for provider tests that run no database: holds queue per agent and
// what was declared is remembered across holds, as the database row does.
export function memoryEngineHold(): HoldEngineAgent {
  const declared = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
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
      markDeclared: async (digest) => {
        if (digest === null) declared.delete(agentId);
        else declared.set(agentId, digest);
      },
      release: async () => free(),
    };
    return hold;
  };
}
