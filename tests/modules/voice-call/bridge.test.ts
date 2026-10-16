import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  CallBridge,
  type CallRecord,
  isFarewell,
} from "@/modules/voice-call/bridge";
import {
  pcmFromBase64,
  pcmToBase64,
  Resampler,
} from "@/modules/voice-call/pcm";
import type {
  VoiceProvider,
  VoiceSessionHandlers,
} from "@/modules/voice-call/providers/types";
import {
  transcriptText,
  voiceSessionConfig,
} from "@/modules/voice-call/service";
import { until } from "@/tests/utils/poll";

function fakeEngine() {
  const state = {
    handlers: null as VoiceSessionHandlers | null,
    begun: 0,
    received: [] as Int16Array[],
    closed: false,
  };
  const provider: VoiceProvider = {
    name: "fake",
    async open(_config, handlers) {
      state.handlers = handlers;
      return {
        sendAudio: (pcm) => state.received.push(pcm),
        begin: () => {
          state.begun++;
        },
        close: () => {
          state.closed = true;
        },
      };
    },
  };
  return { provider, state };
}

function socket() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    closed: false,
    send: (text: string) => sent.push(JSON.parse(text)),
    close() {},
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("CallBridge", () => {
  test("the caller's voice heard while the engine is still connecting reaches it, in order", async () => {
    const { provider, state } = fakeEngine();
    let connected: () => void = () => {};
    const slow: VoiceProvider = {
      name: "slow",
      open: (config, handlers) =>
        new Promise((resolve) => {
          connected = () => resolve(provider.open(config, handlers));
        }),
    };
    const ws = socket();
    const bridge = new CallBridge(ws, {
      provider: slow,
      configure: () => voiceSessionConfig(ROUTE, CTX),
      onFinished: () => {},
    });
    bridge.onMessage(
      JSON.stringify({ event: "start", call_id: "c", direction: "inbound" }),
    );
    bridge.onMessage(JSON.stringify({ event: "answered" }));
    const hello = new Int16Array(320).fill(1);
    const request = new Int16Array(320).fill(2);
    for (const pcm of [hello, request])
      bridge.onMessage(
        JSON.stringify({ event: "media", payload: pcmToBase64(pcm) }),
      );
    await tick();
    connected();
    await tick();
    bridge.onMessage(
      JSON.stringify({
        event: "media",
        payload: pcmToBase64(new Int16Array(320).fill(3)),
      }),
    );
    expect(state.received.map((pcm) => pcm[0])).toEqual([1, 2, 3]);
    expect(state.begun).toBe(1);
  });

  test("a stream takes no voice before it starts, opens one engine, and holds at most 10 s while it connects", async () => {
    const { provider, state } = fakeEngine();
    let connected: () => void = () => {};
    let configured = 0;
    const slow: VoiceProvider = {
      name: "slow",
      open: (config, handlers) =>
        new Promise((resolve) => {
          connected = () => resolve(provider.open(config, handlers));
        }),
    };
    const bridge = new CallBridge(socket(), {
      provider: slow,
      configure: () => {
        configured++;
        return voiceSessionConfig(ROUTE, CTX);
      },
      onFinished: () => {},
    });
    const media = (fill: number) =>
      JSON.stringify({
        event: "media",
        payload: pcmToBase64(new Int16Array(320).fill(fill)),
      });
    bridge.onMessage(JSON.stringify({ event: "answered" }));
    bridge.onMessage(media(9));
    bridge.onMessage(JSON.stringify({ event: "start", call_id: "c" }));
    bridge.onMessage(JSON.stringify({ event: "start", call_id: "d" }));
    bridge.onMessage(JSON.stringify({ event: "answered" }));
    // 12 s of 20 ms frames at 16 kHz
    for (let i = 0; i < 600; i++) bridge.onMessage(media(1));
    await tick();
    connected();
    await tick();
    expect(configured).toBe(1);
    expect(state.received.some((pcm) => pcm[0] === 9)).toBe(false);
    expect(state.received.reduce((n, pcm) => n + pcm.length, 0)).toBe(
      16_000 * 10,
    );
  });

  test("a placed call opens the engine only once answered, so its ringing holds no agent", async () => {
    const { provider, state } = fakeEngine();
    let configured = 0;
    const bridge = new CallBridge(socket(), {
      provider,
      configure: () => {
        configured++;
        return voiceSessionConfig(ROUTE, { ...CTX, direction: "outbound" });
      },
      onFinished: () => {},
    });
    bridge.onMessage(JSON.stringify({ event: "start", direction: "outbound" }));
    await tick();
    expect(configured).toBe(0);
    bridge.onMessage(JSON.stringify({ event: "answered", call_id: "c" }));
    await until("the engine to begin", () => state.begun === 1);
    expect(configured).toBe(1);
  });

  test("speaks only once the call is answered, and carries voice both ways", async () => {
    const { provider, state } = fakeEngine();
    const ws = socket();
    const records: CallRecord[] = [];
    const bridge = new CallBridge(ws, {
      provider,
      configure: (start) =>
        voiceSessionConfig(
          {
            tenantId: 1n,
            instanceId: 1n,
            inboxId: 7,
            agentId: 1n,
            agentName: "Maria",
            systemPrompt: "Você é a Maria.",
          },
          { conversationId: 7, inboxId: 3, direction: start.direction },
        ),
      onFinished: (record) => records.push(record),
    });

    bridge.onMessage(
      JSON.stringify({
        event: "start",
        call_id: "CALL1",
        direction: "inbound",
        peer: "5511",
      }),
    );
    await tick();
    expect(state.begun).toBe(0);
    bridge.onMessage(
      JSON.stringify({
        event: "media",
        payload: pcmToBase64(new Int16Array(960)),
      }),
    );
    expect(state.received).toHaveLength(0);

    bridge.onMessage(JSON.stringify({ event: "answered" }));
    await tick();
    expect(state.begun).toBe(1);
    bridge.onMessage(
      JSON.stringify({
        event: "media",
        payload: pcmToBase64(new Int16Array(960).fill(7)),
      }),
    );
    expect(state.received[0]?.[0]).toBe(7);

    state.handlers?.onAudio(new Int16Array(320).fill(9));
    expect(ws.sent.at(-1)?.event).toBe("media");
    expect(pcmFromBase64(String(ws.sent.at(-1)?.payload))[0]).toBe(9);

    state.handlers?.onInterrupt();
    expect(ws.sent.at(-1)).toEqual({ event: "clear" });

    state.handlers?.onTranscript({ role: "user", text: "Oi", atMs: 10 });
    state.handlers?.onTranscript({ role: "agent", text: "Olá", atMs: 5 });
    bridge.onMessage(JSON.stringify({ event: "stop" }));
    expect(state.closed).toBe(true);
    expect(records[0]).toMatchObject({
      callId: "CALL1",
      endedBy: "connector",
      provider: "fake",
    });
    expect(records[0]?.transcript.map((entry) => entry.text)).toEqual([
      "Olá",
      "Oi",
    ]);
  });

  test("an agent that ends the call hangs up after what it said is played", async () => {
    const { provider, state } = fakeEngine();
    const ws = socket();
    const records: CallRecord[] = [];
    const bridge = new CallBridge(ws, {
      provider,
      configure: () =>
        voiceSessionConfig(
          {
            tenantId: 1n,
            instanceId: 1n,
            inboxId: 7,
            agentId: 1n,
            agentName: "Maria",
            systemPrompt: "x",
          },
          { conversationId: null, inboxId: null, direction: "inbound" },
        ),
      onFinished: (record) => records.push(record),
    });
    bridge.onMessage(
      JSON.stringify({
        event: "start",
        call_id: "CALL2",
        direction: "inbound",
      }),
    );
    bridge.onMessage(JSON.stringify({ event: "answered" }));
    await tick();
    jest.useFakeTimers();
    // 200 ms of farewell queued on the connector.
    state.handlers?.onAudio(new Int16Array(3200));
    state.handlers?.onHangup("done");
    jest.advanceTimersByTime(100);
    expect(ws.sent.some((frame) => frame.event === "hangup")).toBe(false);
    jest.advanceTimersByTime(900);
    jest.useRealTimers();
    expect(ws.sent.at(-1)).toEqual({
      event: "hangup",
      by: "agent",
      reason: "done",
    });
    expect(records[0]).toMatchObject({ endedBy: "agent", endReason: "done" });
  });

  test("a placed call takes its id from the answer", async () => {
    const { provider } = fakeEngine();
    const records: CallRecord[] = [];
    const bridge = new CallBridge(socket(), {
      provider,
      configure: () =>
        voiceSessionConfig(
          {
            tenantId: 1n,
            instanceId: 1n,
            inboxId: 7,
            agentId: 1n,
            agentName: "Maria",
            systemPrompt: "x",
          },
          { conversationId: 1, inboxId: 1, direction: "outbound" },
        ),
      onFinished: (record) => records.push(record),
    });
    bridge.onMessage(
      JSON.stringify({ event: "start", direction: "outbound", peer: "5511" }),
    );
    bridge.onMessage(JSON.stringify({ event: "answered", call_id: "PLACED1" }));
    bridge.onClose();
    expect(records[0]).toMatchObject({
      callId: "PLACED1",
      direction: "outbound",
    });
  });
});

describe("voice session config", () => {
  const route = {
    tenantId: 1n,
    instanceId: 1n,
    inboxId: 7,
    agentId: 1n,
    agentName: "Maria",
    systemPrompt: "Você é a Maria da clínica.",
  };

  test("keeps the agent's own prompt and adds the rules of a call", () => {
    const config = voiceSessionConfig(route, {
      conversationId: 1,
      inboxId: 1,
      direction: "inbound",
    });
    expect(config.instructions.startsWith("Você é a Maria da clínica.")).toBe(
      true,
    );
    expect(config.instructions).toContain("end_call");
    expect(config.opensCall).toBe(true);
  });

  test("tells an outbound agent that it is the one calling", () => {
    expect(
      voiceSessionConfig(route, {
        conversationId: 1,
        inboxId: 1,
        direction: "outbound",
      }).instructions,
    ).toContain("LIGANDO");
  });

  test("names who said what in the transcript", () => {
    const text = transcriptText(
      {
        callId: "C",
        direction: "inbound",
        peer: null,
        provider: "fake",
        startedAt: "",
        answeredAt: null,
        endedAt: "",
        endedBy: "agent",
        endReason: null,
        engineConversationId: null,
        transcript: [
          { role: "agent", text: "Olá", atMs: 0 },
          { role: "user", text: "Oi", atMs: 1 },
        ],
      },
      "Maria",
    );
    expect(text).toBe("Maria: Olá\nContato: Oi");
  });
});

describe("Resampler", () => {
  test("keeps a tone's level from 16 to 24 kHz and back", () => {
    const tone = Int16Array.from({ length: 16000 }, (_, i) =>
      Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
    );
    const up = new Resampler(16000, 24000).push(tone);
    const back = new Resampler(24000, 16000).push(up);
    expect(Math.abs(up.length - 24000)).toBeLessThan(40);
    const peak = (pcm: Int16Array) =>
      Math.max(...Array.from(pcm.slice(2000, 4000), Math.abs));
    expect(peak(up)).toBeGreaterThan(7500);
    expect(peak(back)).toBeGreaterThan(7500);
  });
});

const ROUTE = {
  tenantId: 1n,
  instanceId: 1n,
  inboxId: 7,
  agentId: 1n,
  agentName: "Maria",
  systemPrompt: "Você é a Maria.",
};
const CTX = { conversationId: 7, inboxId: 3, direction: "inbound" as const };

describe("farewell detection", () => {
  test.each([
    ["Tchau!", true],
    ["Por nada! Tenha um ótimo dia e até logo!", true],
    ["Combinado. Até a próxima.", true],
    ["Clínica Moreira, bom dia! Aqui é a Maria. Como posso ajudar?", false],
    ["Até logo! Posso ajudar em mais alguma coisa?", false],
    ["Sim, aceitamos Unimed.", false],
  ])("%s -> %p", (text, expected) => {
    expect(isFarewell(text)).toBe(expected);
  });

  async function answeredCall() {
    const { provider, state } = fakeEngine();
    const ws = socket();
    const records: CallRecord[] = [];
    const tools: Array<[string, boolean]> = [];
    const bridge = new CallBridge(ws, {
      provider,
      configure: () => voiceSessionConfig(ROUTE, CTX),
      onFinished: (r) => records.push(r),
      onTool: (name, ok) => tools.push([name, ok]),
    });
    bridge.onMessage(
      JSON.stringify({
        event: "start",
        call_id: "c",
        direction: "inbound",
        peer: "1",
      }),
    );
    bridge.onMessage(JSON.stringify({ event: "answered" }));
    await tick();
    // From here the clock is fake: the farewell's silence passes without waiting for it.
    jest.useFakeTimers();
    return {
      bridge,
      ws,
      records,
      tools,
      handlers: state.handlers as VoiceSessionHandlers,
    };
  }

  test("each tool the agent ran reaches the caller, failed ones marked", async () => {
    const { tools, handlers } = await answeredCall();
    handlers.onTool?.("check_calendar", true);
    handlers.onTool?.("update_labels", false);
    expect(tools).toEqual([
      ["check_calendar", true],
      ["update_labels", false],
    ]);
  });

  const silence = () => jest.advanceTimersByTime(10_000);

  afterEach(() => {
    jest.useRealTimers();
  });

  test("a farewell nobody answers ends the call, by the agent", async () => {
    const { ws, records, handlers } = await answeredCall();
    handlers.onTranscript({ role: "agent", text: "Por nada! Tchau!", atMs: 1 });
    silence();
    expect(ws.sent.some((f) => f.event === "hangup")).toBe(true);
    expect(records[0]?.endedBy).toBe("agent");
    expect(records[0]?.endReason).toBe("farewell");
  });

  test("a farewell whose audio arrives late still gets its whole silence after it plays", async () => {
    const { ws, handlers } = await answeredCall();
    const hungUp = () => ws.sent.some((f) => f.event === "hangup");
    handlers.onTranscript({ role: "agent", text: "Tchau!", atMs: 1 });
    jest.advanceTimersByTime(1_000);
    // One second of the farewell's audio, now: it plays until t=2000.
    handlers.onAudio(new Int16Array(16_000));
    jest.advanceTimersByTime(3_000);
    expect(hungUp()).toBe(false);
    jest.advanceTimersByTime(600);
    expect(hungUp()).toBe(true);
  });

  test("the person speaking after the farewell keeps the call open", async () => {
    const { bridge, ws, records, handlers } = await answeredCall();
    handlers.onTranscript({ role: "agent", text: "Tchau!", atMs: 1 });
    const voice = new Int16Array(960).fill(8_000);
    bridge.onMessage(
      JSON.stringify({ event: "media", payload: pcmToBase64(voice) }),
    );
    silence();
    expect(ws.sent.some((f) => f.event === "hangup")).toBe(false);
    expect(records).toHaveLength(0);
  });

  test("an answer that asks something does not arm it", async () => {
    const { ws, handlers } = await answeredCall();
    handlers.onTranscript({
      role: "agent",
      text: "Até logo! Mais alguma coisa?",
      atMs: 1,
    });
    silence();
    expect(ws.sent.some((f) => f.event === "hangup")).toBe(false);
  });
});
