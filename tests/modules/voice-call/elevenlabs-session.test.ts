import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import type {
  VoiceSessionConfig,
  VoiceSessionHandlers,
} from "@/modules/voice-call/providers/types";
import { until } from "@/tests/utils/poll";

// A tool the agent asks for on the call runs here, its result goes back on the call's socket, and
// the caller hears about it: the playground shows each one as the call goes.

// The provider dials the global WebSocket, which the DOM preload replaces with one that never
// connects; Bun's own is put back for these tests (and its Response for the server).
const native = globalThis as unknown as {
  BunWebSocket: typeof WebSocket;
  BunResponse: typeof Response;
};
const inert = globalThis.WebSocket;

type Server = ReturnType<typeof Bun.serve>;
let server: Server | null = null;

beforeEach(() => {
  globalThis.WebSocket = native.BunWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = inert;
  server?.stop(true);
  server = null;
});

/** An ElevenLabs conversation socket that asks for the given tool calls and collects the answers. */
function fakeEngine(calls: Array<{ tool_name: string; tool_call_id: string }>) {
  const results: Array<Record<string, unknown>> = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined })
        ? undefined
        : new native.BunResponse("no", { status: 400 });
    },
    websocket: {
      // Asked once the session introduced itself, so its listener is already in place.
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type === "conversation_initiation_client_data") {
          for (const call of calls)
            ws.send(
              JSON.stringify({
                type: "client_tool_call",
                client_tool_call: call,
              }),
            );
          return;
        }
        if (frame.type !== "client_tool_result") return;
        results.push(frame);
        if (results.length === calls.length) resolveDone();
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}/`;
  const fetchImpl = (async (input: string) => {
    if (input.includes("get-signed-url"))
      return new Response(JSON.stringify({ signed_url: url }));
    return new Response("{}");
  }) as unknown as typeof fetch;
  return { results, done, fetchImpl };
}

const CONFIG: VoiceSessionConfig = {
  instructions: "x",
  greeting: "",
  opensCall: false,
  language: "pt",
  direction: "inbound",
  variables: {},
  tools: [
    {
      name: "check_calendar",
      description: "d",
      parameters: { type: "object", properties: {} },
      invoke: async () => "livre às 10h",
    },
  ],
};

describe("a tool the agent runs on an ElevenLabs call", () => {
  test("is answered on the socket and reported to the caller, a failed one as failed", async () => {
    const engine = fakeEngine([
      { tool_name: "check_calendar", tool_call_id: "t1" },
      { tool_name: "send_image", tool_call_id: "t2" },
    ]);
    const seen: Array<[string, boolean]> = [];
    const handlers: VoiceSessionHandlers = {
      onAudio: () => {},
      onInterrupt: () => {},
      onTranscript: () => {},
      onHangup: () => {},
      onError: () => {},
      onTool: (name, ok) => seen.push([name, ok]),
    };
    const session = await elevenLabsProvider({
      apiKey: "k",
      agentId: "agent-session-test",
      fetchImpl: engine.fetchImpl,
    }).open(CONFIG, handlers);
    session.begin();
    await engine.done;
    session.close();
    expect(seen).toEqual([
      ["check_calendar", true],
      ["send_image", false],
    ]);
    expect(engine.results).toMatchObject([
      { tool_call_id: "t1", result: "livre às 10h", is_error: false },
      { tool_call_id: "t2", is_error: true },
    ]);
  });
});

describe("two calls on one ElevenLabs agent", () => {
  test("the second declares its tools only once the first's conversation started", async () => {
    const order: string[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined })
          ? undefined
          : new native.BunResponse("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw));
          if (frame.type !== "conversation_initiation_client_data") return;
          order.push(
            `started ${frame.conversation_config_override.agent.prompt.prompt}`,
          );
          ws.send(
            JSON.stringify({
              type: "conversation_initiation_metadata",
              conversation_initiation_metadata_event: {
                conversation_id: "c",
                agent_output_audio_format: "pcm_16000",
                user_input_audio_format: "pcm_16000",
              },
            }),
          );
        },
      },
    });
    const url = `ws://127.0.0.1:${server.port}/`;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      if (input.includes("get-signed-url"))
        return new Response(JSON.stringify({ signed_url: url }));
      const tools = JSON.parse(String(init?.body)).conversation_config.agent
        .prompt.tools as Array<{ description: string }>;
      order.push(`declared ${tools[0]?.description}`);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const handlers: VoiceSessionHandlers = {
      onAudio: () => {},
      onInterrupt: () => {},
      onTranscript: () => {},
      onHangup: () => {},
      onError: () => {},
    };
    const provider = elevenLabsProvider({
      apiKey: "k",
      agentId: "agent-shared-test",
      fetchImpl,
    });
    const configFor = (card: string): VoiceSessionConfig => ({
      ...CONFIG,
      instructions: card,
      tools: CONFIG.tools?.map((tool) => ({ ...tool, description: card })),
    });
    const first = await provider.open(configFor("A"), handlers);
    const second = provider.open(configFor("B"), handlers);
    first.begin();
    const opened = await second;
    opened.begin();
    await until("the second conversation to start", () => order.length === 4);
    first.close();
    opened.close();
    expect(order).toEqual([
      "declared A",
      "started A",
      "declared B",
      "started B",
    ]);
  });
});
