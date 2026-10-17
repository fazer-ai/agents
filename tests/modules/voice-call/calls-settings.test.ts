import { beforeEach, describe, expect, test } from "bun:test";
import {
  callsFormErrors,
  callsSettingsFrom,
  readCallsFormState,
} from "@/client/pages/agents/callsFormState";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import {
  checkElevenLabsAgentsAccess,
  deleteElevenLabsAgent,
  elevenLabsAgentConfig,
  elevenLabsCallSummary,
  ensureElevenLabsAgent,
} from "@/modules/voice-call/providers/elevenlabs-agent";
import type {
  VoiceSessionConfig,
  VoiceSessionHandlers,
} from "@/modules/voice-call/providers/types";
import {
  CALLS_DEFAULTS,
  DEFAULT_CALL_VOICE,
  keepCallsSystemFields,
  readCallsConfig,
} from "@/modules/voice-call/settings";
import {
  memoryConfigDigests,
  memoryEngineHold,
} from "@/tests/utils/engine-hold";

// What each ElevenLabs agent was last written with, as the shared row would hold it; fresh per test.
let configs = new Map<string, string>();
let digests = memoryConfigDigests(configs);
let hold = memoryEngineHold(configs);
beforeEach(() => {
  configs = new Map();
  digests = memoryConfigDigests(configs);
  hold = memoryEngineHold(configs);
});

describe("calls settings", () => {
  test("a voice agent that never configured its calls has the defaults, Raquel's voice included", () => {
    expect(readCallsConfig({})).toEqual(CALLS_DEFAULTS);
    expect(readCallsConfig({}).voice).toBe(DEFAULT_CALL_VOICE);
  });

  test("numbers are clamped, keywords deduplicated and capped", () => {
    const c = readCallsConfig({
      calls: {
        enabled: true,
        speed: 3,
        openingDelayMs: -5,
        silenceEndCallSecs: 1,
        maxDurationSecs: 99_999,
        turnEagerness: "sometimes",
        keywords: ["Unimed", " Unimed ", "", 3, "x".repeat(80)],
      },
    });
    expect(c.speed).toBe(1.2);
    expect(c.openingDelayMs).toBe(0);
    expect(c.silenceEndCallSecs).toBe(10);
    expect(c.maxDurationSecs).toBe(3600);
    expect(c.turnEagerness).toBe("normal");
    expect(c.keywords).toEqual(["Unimed"]);
  });

  test("a null silence never ends the call", () => {
    expect(
      readCallsConfig({ calls: { silenceEndCallSecs: null } })
        .silenceEndCallSecs,
    ).toBeNull();
  });

  test("the background and tool sounds take only ElevenLabs' presets, and null turns them off", () => {
    expect(
      readCallsConfig({
        calls: { backgroundSound: "office2", toolSound: "elevator3" },
      }),
    ).toMatchObject({ backgroundSound: "office2", toolSound: "elevator3" });
    expect(
      readCallsConfig({
        calls: { backgroundSound: "jungle", toolSound: "office1" },
      }),
    ).toMatchObject({ backgroundSound: null, toolSound: "typing" });
    expect(
      readCallsConfig({ calls: { toolSound: null } }).toolSound,
    ).toBeNull();
    expect(
      readCallsConfig({ calls: { backgroundVolume: 7 } }).backgroundVolume,
    ).toBe(1);
  });

  test("a save keeps the stored ElevenLabs agent id, whether it leaves the id out or echoes another", () => {
    const before = { calls: { elevenLabsAgentId: "agent_1" } };
    const next: { calls: Record<string, unknown> } = {
      calls: { speed: 1.1 },
    };
    keepCallsSystemFields(next, before);
    expect(next.calls).toEqual({
      speed: 1.1,
      elevenLabsAgentId: "agent_1",
    });
    // An editor opened before the agent was recreated echoes the id it replaced.
    const stale = { calls: { elevenLabsAgentId: "agent_0" } };
    keepCallsSystemFields(stale, before);
    expect(stale.calls.elevenLabsAgentId).toBe("agent_1");
    // And a write cannot name one the server never set up.
    const named: { calls: Record<string, unknown> } = {
      calls: { elevenLabsAgentId: "agent_2" },
    };
    keepCallsSystemFields(named, {});
    expect(named.calls).toEqual({});
  });
});

describe("the agent on ElevenLabs", () => {
  const spec = {
    name: "Maria (fazer.ai agents #1)",
    voice: "v1",
    calls: readCallsConfig({}),
  };

  function fakeApi(answers: Array<[number, unknown]>) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method ?? "GET",
        url,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      const [status, body] = answers.shift() ?? [200, {}];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("is created when the agent has none, in the call's audio format", async () => {
    const api = fakeApi([[200, { agent_id: "agent_new" }]]);
    expect(
      await ensureElevenLabsAgent(
        "k",
        null,
        spec,
        api.fetchImpl,
        digests,
        hold,
      ),
    ).toBe("agent_new");
    expect(api.calls[0]?.url).toEndWith("/v1/convai/agents/create");
    const created = api.calls[0]?.body as
      | { conversation_config: Record<string, Record<string, unknown>> }
      | undefined;
    const cc = created?.conversation_config ?? {};
    expect(cc.asr?.user_input_audio_format).toBe("pcm_16000");
    expect(cc.tts?.agent_output_audio_format).toBe("pcm_16000");
    expect(cc.tts?.voice_id).toBe("v1");
  });

  test("is patched once per change, and recreated when it was deleted there", async () => {
    const api = fakeApi([
      [200, {}],
      [404, {}],
      [200, { agent_id: "agent_again" }],
    ]);
    expect(
      await ensureElevenLabsAgent(
        "k",
        "agent_x",
        spec,
        api.fetchImpl,
        digests,
        hold,
      ),
    ).toBe("agent_x");
    expect(
      await ensureElevenLabsAgent(
        "k",
        "agent_x",
        spec,
        api.fetchImpl,
        digests,
        hold,
      ),
    ).toBe("agent_x");
    expect(api.calls).toHaveLength(1);
    const changed = { ...spec, voice: "v2" };
    expect(
      await ensureElevenLabsAgent(
        "k",
        "agent_x",
        changed,
        api.fetchImpl,
        digests,
        hold,
      ),
    ).toBe("agent_again");
    expect(api.calls.map((c) => c.method)).toEqual(["PATCH", "PATCH", "POST"]);
  });

  test("a new key is checked against ElevenLabs even with the settings unchanged", async () => {
    const api = fakeApi([
      [200, {}],
      [404, {}],
      [200, { agent_id: "agent_on_b" }],
    ]);
    expect(
      await ensureElevenLabsAgent(
        "key-a",
        "agent_y",
        spec,
        api.fetchImpl,
        digests,
        hold,
      ),
    ).toBe("agent_y");
    // The other account does not have agent_y: the agent is created there instead.
    expect(
      await ensureElevenLabsAgent(
        "key-b",
        "agent_y",
        spec,
        api.fetchImpl,
        digests,
        hold,
      ),
    ).toBe("agent_on_b");
    expect(api.calls.map((c) => c.method)).toEqual(["PATCH", "PATCH", "POST"]);
  });
});

describe("the agent's settings on ElevenLabs", () => {
  test("carry the background sound, and spell it off with nulls so a save switches it off", () => {
    const on = elevenLabsAgentConfig({
      name: "a",
      voice: "v",
      calls: readCallsConfig({
        calls: { backgroundSound: "restaurant", backgroundVolume: 0.3 },
      }),
    });
    expect(on.conversation_config.conversation.background_sound).toEqual({
      source_type: "preset",
      source_id: "restaurant",
      volume: 0.3,
      crossfade_loop: true,
    });
    const off = elevenLabsAgentConfig({
      name: "a",
      voice: "v",
      calls: readCallsConfig({}),
    });
    expect(on.platform_settings.summary_language).toBe("pt");
    expect(off.conversation_config.conversation.background_sound).toMatchObject(
      { source_type: null, source_id: null },
    );
  });
});

describe("the call's summary from ElevenLabs", () => {
  const noWait = async () => {};
  function answers(bodies: Array<[number, unknown]>) {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const [status, body] = bodies.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { urls, fetchImpl };
  }

  test("waits for the analysis and returns its summary", async () => {
    const api = answers([
      [200, { status: "processing", analysis: null }],
      [
        200,
        { status: "done", analysis: { transcript_summary: " Marcou dia 3. " } },
      ],
    ]);
    expect(
      await elevenLabsCallSummary("k", "conv_1", {
        fetchImpl: api.fetchImpl,
        wait: noWait,
      }),
    ).toBe("Marcou dia 3.");
    expect(api.urls[0]).toEndWith("/v1/convai/conversations/conv_1");
  });

  test("gives up on a failed conversation, and after a bounded wait", async () => {
    expect(
      await elevenLabsCallSummary("k", "c", {
        fetchImpl: answers([[200, { status: "failed" }]]).fetchImpl,
        wait: noWait,
      }),
    ).toBeNull();
    const never = answers([]);
    expect(
      await elevenLabsCallSummary("k", "c", {
        fetchImpl: never.fetchImpl,
        wait: noWait,
      }),
    ).toBeNull();
    expect(never.urls.length).toBe(6);
  });
});

describe("the call settings form", () => {
  const valid = readCallsFormState({});

  test("opening and saving the form writes back the numbers that were stored", () => {
    const stored = {
      maxDurationSecs: 90,
      backgroundVolume: 0.155,
      speed: 1.05,
      openingDelayMs: 1250,
      silenceEndCallSecs: 45,
    };
    const numbers = (c: ReturnType<typeof readCallsConfig>) => ({
      maxDurationSecs: c.maxDurationSecs,
      backgroundVolume: c.backgroundVolume,
      speed: c.speed,
      openingDelayMs: c.openingDelayMs,
      silenceEndCallSecs: c.silenceEndCallSecs,
    });
    const saved = callsSettingsFrom(readCallsFormState(stored));
    expect(numbers(readCallsConfig({ calls: saved }))).toEqual(
      numbers(readCallsConfig({ calls: stored })),
    );
    expect(readCallsFormState(stored).maxDurationMin).toBe("1,5");
  });

  test("a saved agent's numbers are all in range", () => {
    expect(callsFormErrors(valid)).toEqual([]);
  });

  test("a negative or zero longest call is refused, not clamped to a minute", () => {
    expect(callsFormErrors({ ...valid, maxDurationMin: "-5" })).toEqual([
      "maxDurationMin",
    ]);
    expect(callsFormErrors({ ...valid, maxDurationMin: "0" })).toEqual([
      "maxDurationMin",
    ]);
    expect(callsFormErrors({ ...valid, maxDurationMin: "" })).toEqual([
      "maxDurationMin",
    ]);
    expect(callsFormErrors({ ...valid, maxDurationMin: "7" })).toEqual([]);
  });

  test("each number is judged in the unit the form shows, and only when its field is in use", () => {
    expect(
      callsFormErrors({
        ...valid,
        speed: "1,5",
        openingDelaySecs: "6",
        backgroundVolume: "0",
      }),
    ).toEqual(["speed", "openingDelaySecs"]);
    expect(
      callsFormErrors({
        ...valid,
        backgroundSound: "office1",
        backgroundVolume: "0",
        endOnSilence: true,
        silenceEndCallSecs: "5",
      }),
    ).toEqual(["silenceEndCallSecs", "backgroundVolume"]);
    expect(
      callsFormErrors({
        ...valid,
        endOnSilence: false,
        silenceEndCallSecs: "x",
      }),
    ).toEqual([]);
  });
});

describe("an agent deleted on ElevenLabs after this process wrote it", () => {
  const spec = {
    name: "Maria (fazer.ai agents #1)",
    voice: "v1",
    calls: readCallsConfig({}),
  };
  const handlers: VoiceSessionHandlers = {
    onAudio: () => {},
    onInterrupt: () => {},
    onTranscript: () => {},
    onHangup: () => {},
    onError: () => {},
  };
  const config: VoiceSessionConfig = {
    instructions: "x",
    greeting: "",
    opensCall: false,
    language: "pt",
    direction: "inbound",
    variables: {},
    tools: [],
  };

  // Each request answered in turn: [status, body].
  function api(answers: Array<[number, unknown]>) {
    return (async () => {
      const [status, body] = answers.shift() ?? [200, {}];
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  }

  test("is created again by the next setup, whether its tools or its call found it gone", async () => {
    const cases: Array<[string, Array<[number, unknown]>]> = [
      ["agent_gone_tools", [[404, {}]]],
      [
        "agent_gone_call",
        [
          [200, {}],
          [404, {}],
        ],
      ],
    ];
    for (const [agentId, gone] of cases) {
      const fetchImpl = api([
        [200, {}],
        ...gone,
        [404, {}],
        [200, { agent_id: `${agentId}_back` }],
      ]);
      expect(
        await ensureElevenLabsAgent(
          "k",
          agentId,
          spec,
          fetchImpl,
          digests,
          hold,
        ),
      ).toBe(agentId);
      await expect(
        elevenLabsProvider({
          apiKey: "k",
          agentId,
          fetchImpl,
          holdEngine: hold,
          configDigests: digests,
        }).open(config, handlers),
      ).rejects.toThrow("404");
      expect(
        await ensureElevenLabsAgent(
          "k",
          agentId,
          spec,
          fetchImpl,
          digests,
          hold,
        ),
      ).toBe(`${agentId}_back`);
    }
  });
});

describe("the requests a call's setup makes to ElevenLabs", () => {
  test("each one carries a deadline, so a stalled provider cannot hold the call or the Playground", async () => {
    const unbounded: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (!init?.signal) unbounded.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PATCH") return new Response("{}", { status: 404 });
      if (init?.method === "POST")
        return new Response(JSON.stringify({ agent_id: "agent_bounded" }));
      return new Response(
        JSON.stringify({
          status: "done",
          analysis: { transcript_summary: "ok" },
        }),
      );
    }) as unknown as typeof fetch;
    const spec = { name: "Maria", voice: "v1", calls: readCallsConfig({}) };
    await checkElevenLabsAgentsAccess("k", fetchImpl);
    await ensureElevenLabsAgent(
      "k",
      "agent_old",
      spec,
      fetchImpl,
      digests,
      hold,
    );
    await deleteElevenLabsAgent("k", "agent_bounded", fetchImpl, digests);
    await elevenLabsCallSummary("k", "conv", { fetchImpl });
    expect(unbounded).toEqual([]);
  });
});
