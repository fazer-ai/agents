// The agent's tools on an OpenAI Realtime session. A call's arguments arrive inside a response; the
// tool runs while that response finishes, and its output goes back once the response is done, with a
// new response asked for: the Realtime API refuses a second response while one is in progress.

import type { VoiceTool } from "./types";

export const TOOL_TIMEOUT_MS = 10_000;

export const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description:
    "Encerra a ligação. Use só depois de se despedir, quando a conversa terminou ou a pessoa pediu para desligar.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Por que a ligação terminou, em poucas palavras.",
      },
    },
    required: ["reason"],
  },
};

export function realtimeToolDefs(tools: VoiceTool[] = []) {
  return [
    END_CALL_TOOL,
    ...tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  ];
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`tool timed out after ${ms} ms`)), ms),
    ),
  ]);
}

export class RealtimeToolRunner {
  private pending: Promise<void>[] = [];
  private readonly byName: Map<string, VoiceTool>;

  constructor(
    tools: VoiceTool[] = [],
    private readonly send: (event: Record<string, unknown>) => void,
    private readonly onMetric?: (name: string, value: number) => void,
  ) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Runs a call the model made; answers false for end_call, which is not a tool. */
  start(event: Record<string, unknown>): boolean {
    const name = String(event.name ?? "");
    if (name === "end_call") return false;
    const callId = String(event.call_id ?? "");
    const tool = this.byName.get(name);
    const started = Date.now();
    const run = (async () => {
      let output: string;
      try {
        if (!tool) throw new Error(`unknown tool ${name}`);
        const args = JSON.parse(String(event.arguments ?? "{}"));
        output = await withTimeout(tool.invoke(args, callId), TOOL_TIMEOUT_MS);
      } catch (err) {
        output = `Erro ao usar a ferramenta: ${(err as Error).message}`;
      }
      this.onMetric?.(`tool_ms:${name}`, Date.now() - started);
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
    })();
    this.pending.push(run);
    return true;
  }

  /** Once a response is done: hands back what the tools answered and asks the model to go on. */
  async flush(): Promise<boolean> {
    if (this.pending.length === 0) return false;
    const running = this.pending.splice(0);
    await Promise.all(running);
    this.send({ type: "response.create" });
    return true;
  }
}
