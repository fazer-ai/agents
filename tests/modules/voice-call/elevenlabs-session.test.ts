import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import type {
  VoiceSessionConfig,
  VoiceSessionHandlers,
} from "@/modules/voice-call/providers/types";
import { memoryEngineHold } from "@/tests/utils/engine-hold";
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

// The deadline each run of check_calendar was handed.
const toolSignals: Array<AbortSignal | undefined> = [];

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
      invoke: async (_args, _id, signal) => {
        toolSignals.push(signal);
        return "livre às 10h";
      },
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
      holdEngine: memoryEngineHold(),
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
    // Run under the call's deadline, which had not passed when it answered.
    expect(
      toolSignals.map((s) => s instanceof AbortSignal && !s.aborted),
    ).toEqual([true]);
  });
});

describe("a tool still running when an ElevenLabs call ends", () => {
  // Either end: the bridge hangs up, or ElevenLabs closes the socket while the bridge still plays
  // the audio out and has not closed the session yet.
  for (const [ending, end] of [
    ["the call hangs up", (session: { close(): void }) => session.close()],
    ["ElevenLabs closes the socket", () => server?.stop(true)],
  ] as const) {
    test(`is cut when ${ending}, so nothing it sends lands after it`, async () => {
      const engine = fakeEngine([{ tool_name: "book", tool_call_id: "t1" }]);
      const handed: { signal?: AbortSignal } = {};
      const session = await elevenLabsProvider({
        apiKey: "k",
        holdEngine: memoryEngineHold(),
        agentId: "agent-session-close-test",
        fetchImpl: engine.fetchImpl,
      }).open(
        {
          ...CONFIG,
          tools: [
            {
              name: "book",
              description: "d",
              parameters: { type: "object", properties: {} },
              invoke: (_args, _id, signal) => {
                handed.signal = signal;
                return new Promise<string>(() => {});
              },
            },
          ],
        },
        {
          onAudio: () => {},
          onInterrupt: () => {},
          onTranscript: () => {},
          onHangup: () => {},
          onError: () => {},
        },
      );
      session.begin();
      await until("the tool to start", () => handed.signal);
      expect(handed.signal?.aborted).toBe(false);
      end(session);
      await until("the tool to be cut", () => handed.signal?.aborted);
      session.close();
    });
  }
});

describe("calls on one ElevenLabs agent", () => {
  test("each declares its tools once the previous conversation started, and a set already there is not declared again", async () => {
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
      holdEngine: memoryEngineHold(),
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
    // A third with the second's tools finds them already on the agent, as the hold recorded.
    const third = await provider.open(configFor("B"), handlers);
    third.begin();
    await until("the third conversation to start", () => order.length === 5);
    first.close();
    opened.close();
    third.close();
    expect(order).toEqual([
      "declared A",
      "started A",
      "declared B",
      "started B",
      "started B",
    ]);
  });
});

describe("an ElevenLabs socket that never opens", () => {
  test("is closed when the open times out, and frees the agent for the next call", async () => {
    const sockets: Array<{ closed: boolean }> = [];
    class NeverOpens {
      readyState = 0;
      closed = false;
      constructor() {
        sockets.push(this);
      }
      addEventListener() {}
      send() {}
      close() {
        this.closed = true;
      }
    }
    globalThis.WebSocket = NeverOpens as unknown as typeof WebSocket;
    const fetchImpl = (async (input: string) =>
      input.includes("get-signed-url")
        ? new Response(JSON.stringify({ signed_url: "ws://127.0.0.1:1/" }))
        : new Response("{}")) as unknown as typeof fetch;
    const provider = elevenLabsProvider({
      apiKey: "k",
      holdEngine: memoryEngineHold(),
      agentId: "agent-never-opens",
      fetchImpl,
      openTimeoutMs: 1,
    });
    const handlers: VoiceSessionHandlers = {
      onAudio: () => {},
      onInterrupt: () => {},
      onTranscript: () => {},
      onHangup: () => {},
      onError: () => {},
    };
    await expect(provider.open(CONFIG, handlers)).rejects.toThrow(
      "open timed out",
    );
    await expect(provider.open(CONFIG, handlers)).rejects.toThrow(
      "open timed out",
    );
    expect(sockets.map((s) => s.closed)).toEqual([true, true]);
  });
});

describe("an ElevenLabs request that hangs while the agent is held", () => {
  const handlers: VoiceSessionHandlers = {
    onAudio: () => {},
    onInterrupt: () => {},
    onTranscript: () => {},
    onHangup: () => {},
    onError: () => {},
  };
  // Answers every request at once except the one `hangs` names, which waits for its abort.
  function hangingOn(hangs: "declare" | "signed-url") {
    const asked: string[] = [];
    const fetchImpl = ((input: string, init?: RequestInit) => {
      const kind = input.includes("get-signed-url") ? "signed-url" : "declare";
      asked.push(kind);
      if (kind !== hangs)
        return Promise.resolve(
          new Response(JSON.stringify({ signed_url: "ws://127.0.0.1:1/" })),
        );
      // A request sent with no deadline would wait here for ever: refused at once, so the test
      // fails on it instead of hanging.
      if (!init?.signal)
        return Promise.reject(new Error("sent with no deadline"));
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as unknown as typeof fetch;
    return { asked, fetchImpl };
  }

  for (const hangs of ["declare", "signed-url"] as const) {
    test(`a ${hangs} request is cut at the open deadline, and the next call is not held behind it`, async () => {
      const api = hangingOn(hangs);
      const provider = elevenLabsProvider({
        apiKey: "k",
        holdEngine: memoryEngineHold(),
        agentId: `agent-hangs-${hangs}`,
        fetchImpl: api.fetchImpl,
        openTimeoutMs: 5,
      });
      // Distinct tools per open, so each one declares them again.
      const opened = (n: number) =>
        provider.open(
          {
            ...CONFIG,
            tools: CONFIG.tools?.map((t) => ({ ...t, description: `v${n}` })),
          },
          handlers,
        );
      await expect(opened(1)).rejects.toThrow("aborted");
      await expect(opened(2)).rejects.toThrow("aborted");
      expect(api.asked.filter((k) => k === hangs)).toHaveLength(2);
    });
  }
});

describe("an ElevenLabs conversation that never starts", () => {
  test("is reported as an error, and the agent is free for the next call", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined })
          ? undefined
          : new native.BunResponse("no", { status: 400 });
      },
      // Takes the socket and the request to start, and never answers it.
      websocket: { message() {} },
    });
    const url = `ws://127.0.0.1:${server.port}/`;
    const fetchImpl = (async (input: string) =>
      input.includes("get-signed-url")
        ? new Response(JSON.stringify({ signed_url: url }))
        : new Response("{}")) as unknown as typeof fetch;
    const errors: string[] = [];
    const handlers: VoiceSessionHandlers = {
      onAudio: () => {},
      onInterrupt: () => {},
      onTranscript: () => {},
      onHangup: () => {},
      onError: (err) => errors.push(err.message),
    };
    const provider = elevenLabsProvider({
      apiKey: "k",
      holdEngine: memoryEngineHold(),
      agentId: "agent-never-starts",
      fetchImpl,
      openTimeoutMs: 200,
    });
    const first = await provider.open(CONFIG, handlers);
    first.begin();
    await until("the start to be given up", () => errors.length > 0);
    expect(errors).toEqual(["elevenlabs: the conversation did not start"]);
    const second = await provider.open(CONFIG, handlers);
    first.close();
    second.close();
  });
});

describe("a call this side opens", () => {
  // The engine answers the conversation's start and, when told to, hears the person say something.
  function openingEngine(personSpeaks: boolean) {
    const userMessages: string[] = [];
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
          if (frame.type === "user_message") userMessages.push(frame.text);
          if (frame.type !== "conversation_initiation_client_data") return;
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
          if (personSpeaks)
            ws.send(
              JSON.stringify({
                type: "user_transcript",
                user_transcription_event: { user_transcript: "alô?" },
              }),
            );
        },
      },
    });
    const url = `ws://127.0.0.1:${server.port}/`;
    const fetchImpl = (async (input: string) =>
      input.includes("get-signed-url")
        ? new Response(JSON.stringify({ signed_url: url }))
        : new Response("{}")) as unknown as typeof fetch;
    return { userMessages, fetchImpl };
  }

  async function call(personSpeaks: boolean) {
    const engine = openingEngine(personSpeaks);
    const heard: string[] = [];
    const session = await elevenLabsProvider({
      apiKey: "k",
      holdEngine: memoryEngineHold(),
      agentId: `agent-opens-${personSpeaks}`,
      fetchImpl: engine.fetchImpl,
    }).open(
      { ...CONFIG, opensCall: true, greeting: "", openingDelayMs: 100 },
      {
        onAudio: () => {},
        onInterrupt: () => {},
        onTranscript: (entry) => heard.push(entry.text),
        onHangup: () => {},
        onError: () => {},
      },
    );
    session.begin();
    return { engine, heard, session };
  }

  test("asks the agent to open it when nobody spoke", async () => {
    const { engine, session } = await call(false);
    await until("the opening asked for", () => engine.userMessages.length > 0);
    session.close();
  });

  test("does not, once the person was heard, however quietly", async () => {
    const { engine, heard, session } = await call(true);
    await until("the person heard", () => heard.includes("alô?"));
    // Past the opening delay, with room: the opening would have been asked by now.
    const past = Date.now() + 400;
    await until("the opening delay to pass", () => Date.now() > past);
    session.close();
    expect(engine.userMessages).toEqual([]);
  });
});

describe("a call that opens and is never answered", () => {
  test("gives the agent up when its hold's lease passes, and the next call goes on", async () => {
    const engine = fakeEngine([]);
    const provider = elevenLabsProvider({
      apiKey: "k",
      holdEngine: memoryEngineHold(),
      agentId: "agent-never-answered",
      fetchImpl: engine.fetchImpl,
      // The lease is three of these plus five seconds.
      openTimeoutMs: 1_000,
    });
    const errors: string[] = [];
    const handlers: VoiceSessionHandlers = {
      onAudio: () => {},
      onInterrupt: () => {},
      onTranscript: () => {},
      onHangup: () => {},
      onError: (err) => errors.push(err.message),
    };
    // Opened on its start frame, and the answer that would begin it never comes.
    const first = await provider.open(CONFIG, handlers);
    const second = await provider.open(CONFIG, {
      ...handlers,
      onError: () => {},
    });
    expect(errors).toEqual([
      "elevenlabs: the call did not start within the agent's hold",
    ]);
    first.close();
    second.close();
  }, 20_000);
});

// A call that ends (the person hung up, the stream dropped) while its engine is still starting gives
// the start up at once: queued behind another call to the same agent, acquiring the agent's hold, in
// a request, or in the socket's handshake. A start nobody is on the line for would otherwise hold the
// agent, and every later call to it, until its own deadlines passed.
describe("a call that ends while its engine is starting", () => {
  const handlers: VoiceSessionHandlers = {
    onAudio: () => {},
    onInterrupt: () => {},
    onTranscript: () => {},
    onHangup: () => {},
    onError: () => {},
  };
  // Every declaration waits for its own abort; `asked` names each open that reached one.
  function declarationsHang() {
    const asked: string[] = [];
    const fetchImpl = ((input: string, init?: RequestInit) => {
      if (input.includes("get-signed-url"))
        return Promise.resolve(
          new Response(JSON.stringify({ signed_url: "ws://127.0.0.1:1/" })),
        );
      asked.push(String(init?.body ?? ""));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as unknown as typeof fetch;
    return { asked, fetchImpl };
  }
  // A start that should give up and does not would otherwise leave the test waiting with no end: it
  // fails here, naming the start, at a bound well under the suite's.
  const settles = async <T>(start: Promise<T>): Promise<T> => {
    let outcome: { value: T } | { error: unknown } | null = null;
    start.then(
      (value) => {
        outcome = { value };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    const settled = await until("the start to settle", () => outcome, {
      deadlineMs: 3_000,
    });
    if ("error" in settled) throw settled.error;
    return settled.value;
  };
  const opened = (
    provider: ReturnType<typeof elevenLabsProvider>,
    n: number,
    signal: AbortSignal,
  ) =>
    provider.open(
      {
        ...CONFIG,
        tools: CONFIG.tools?.map((t) => ({ ...t, description: `v${n}` })),
      },
      handlers,
      signal,
    );

  test("queued behind another call, it leaves the queue, and the call after it is not held by it", async () => {
    const api = declarationsHang();
    const provider = elevenLabsProvider({
      apiKey: "k",
      holdEngine: memoryEngineHold(),
      agentId: "agent-ends-queued",
      fetchImpl: api.fetchImpl,
      openTimeoutMs: 60_000,
    });
    const first = new AbortController();
    const second = new AbortController();
    const third = new AbortController();
    const one = opened(provider, 1, first.signal);
    await until("the first call to declare", () => api.asked.length === 1);
    const two = opened(provider, 2, second.signal);
    const three = opened(provider, 3, third.signal);
    second.abort();
    await expect(settles(two)).rejects.toThrow("ended before it started");
    first.abort();
    await expect(settles(one)).rejects.toThrow("aborted");
    // The second gave its turn up: the third declares next.
    await until("the third call to declare", () => api.asked.length === 2);
    expect(api.asked[1]).toContain("v3");
    third.abort();
    await expect(settles(three)).rejects.toThrow("aborted");
  });

  test("acquiring the agent's hold, it stops waiting", async () => {
    let waiting = false;
    const provider = elevenLabsProvider({
      apiKey: "k",
      // Another process holds the agent: the hold is only ever given up by the signal.
      holdEngine: (_agentId, signal) =>
        new Promise((_resolve, reject) => {
          waiting = true;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      agentId: "agent-ends-holding",
      fetchImpl: declarationsHang().fetchImpl,
      openTimeoutMs: 60_000,
    });
    const ended = new AbortController();
    const one = opened(provider, 1, ended.signal);
    await until("the call to wait for the hold", () => waiting);
    ended.abort();
    await expect(settles(one)).rejects.toThrow("held by another call's start");
  });

  test("in the socket's handshake, it closes the socket", async () => {
    const sockets: Array<{ closed: boolean }> = [];
    class NeverOpens {
      readyState = 0;
      closed = false;
      constructor() {
        sockets.push(this);
      }
      addEventListener() {}
      send() {}
      close() {
        this.closed = true;
      }
    }
    globalThis.WebSocket = NeverOpens as unknown as typeof WebSocket;
    const fetchImpl = (async (input: string) =>
      input.includes("get-signed-url")
        ? new Response(JSON.stringify({ signed_url: "ws://127.0.0.1:1/" }))
        : new Response("{}")) as unknown as typeof fetch;
    const provider = elevenLabsProvider({
      apiKey: "k",
      holdEngine: memoryEngineHold(),
      agentId: "agent-ends-handshake",
      fetchImpl,
      openTimeoutMs: 60_000,
    });
    const ended = new AbortController();
    const one = opened(provider, 1, ended.signal);
    await until("the socket to be dialled", () => sockets.length === 1);
    ended.abort();
    await expect(settles(one)).rejects.toThrow("ended before it started");
    expect(sockets.map((s) => s.closed)).toEqual([true]);
  });
});
