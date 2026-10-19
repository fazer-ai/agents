import { beforeEach, describe, expect, test } from "bun:test";
import {
  callsByTab,
  callsFormErrors,
  callsSettingsFrom,
  liveness,
  playgroundHasKey,
  readCallsFormState,
} from "@/client/pages/agents/callsFormState";
import { elevenLabsProvider } from "@/modules/voice-call/providers/elevenlabs";
import {
  checkElevenLabsAgentsAccess,
  deleteElevenLabsAgent,
  ElevenLabsRefusal,
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

  test("the provider and its voice and transcription models are read from a list, the first by default", () => {
    expect(readCallsConfig({})).toMatchObject({
      provider: "elevenlabs",
      ttsModel: "eleven_flash_v2_5",
      asrModel: "scribe_realtime",
    });
    expect(
      readCallsConfig({
        calls: {
          provider: "elevenlabs",
          ttsModel: "eleven_v4_turbo",
          asrModel: "scribe_v2_turbo",
        },
      }),
    ).toMatchObject({
      ttsModel: "eleven_v4_turbo",
      asrModel: "scribe_v2_turbo",
    });
    // An English-only voice model, a provider this build does not have: the defaults, not the value.
    expect(
      readCallsConfig({
        calls: {
          provider: "vapi",
          ttsModel: "eleven_flash_v2",
          asrModel: "whisper",
        },
      }),
    ).toMatchObject({
      provider: "elevenlabs",
      ttsModel: "eleven_flash_v2_5",
      asrModel: "scribe_realtime",
    });
  });

  test("the agent on ElevenLabs speaks with the chosen voice model and hears with the chosen transcription", () => {
    const config = elevenLabsAgentConfig({
      name: "Maria",
      prompt: "p",
      voice: "v1",
      calls: readCallsConfig({
        calls: {
          ttsModel: "eleven_multilingual_v2",
          asrModel: "scribe_v2_turbo",
        },
      }),
    });
    expect(config.conversation_config.tts.model_id).toBe(
      "eleven_multilingual_v2",
    );
    expect(config.conversation_config.asr.provider).toBe("scribe_v2_turbo");
  });

  test("the Playground can call while the draft or the saved version has a key", () => {
    const draft = (credentialRef: string) => ({
      ...readCallsFormState({}),
      credentialRef,
    });
    const saved = (credentialRef?: string) => ({
      calls: credentialRef ? { credentialRef } : {},
    });
    expect([
      playgroundHasKey(draft("vault:9"), saved()),
      playgroundHasKey(draft(""), saved("vault:9")),
      playgroundHasKey(draft(""), saved()),
      playgroundHasKey(draft(""), undefined),
    ]).toEqual([true, true, false, false]);
  });

  test("what saving does to the customers' calls follows the saved mode and the form's", () => {
    expect([
      liveness("production", "production"),
      liveness("test", "production"),
      liveness("production", "test"),
      liveness("test", "test"),
    ]).toEqual(["live", "goingLive", "leavingLive", "test"]);
  });

  test("the call settings split between General's Voice card and the Call tab, each field on one", () => {
    const form = readCallsFormState({});
    const { general, call } = callsByTab(form);
    expect(Object.keys(general).sort()).toEqual(
      [
        "asrModel",
        "credentialRef",
        "llm",
        "provider",
        "speed",
        "ttsModel",
        "voice",
      ].sort(),
    );
    expect(Object.keys(call).some((k) => k in general)).toBe(false);
    expect({ ...general, ...call }).toEqual(form);
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
    const before = { calls: { providerAgentId: "agent_1" } };
    const next: { calls: Record<string, unknown> } = {
      calls: { speed: 1.1 },
    };
    keepCallsSystemFields(next, before);
    expect(next.calls).toEqual({
      speed: 1.1,
      providerAgentId: "agent_1",
    });
    // An editor opened before the agent was recreated echoes the id it replaced.
    const stale = { calls: { providerAgentId: "agent_0" } };
    keepCallsSystemFields(stale, before);
    expect(stale.calls.providerAgentId).toBe("agent_1");
    // And a write cannot name one the server never set up.
    const named: { calls: Record<string, unknown> } = {
      calls: { providerAgentId: "agent_2" },
    };
    keepCallsSystemFields(named, {});
    expect(named.calls).toEqual({}); // A bag that leaves the block out keeps it, and one with no id to keep stays as written.
    const bare: Record<string, unknown> = { tone: "x" };
    keepCallsSystemFields(bare, before);
    expect(bare).toEqual({
      tone: "x",
      calls: { providerAgentId: "agent_1" },
    });
    const fresh: Record<string, unknown> = { tone: "x" };
    keepCallsSystemFields(fresh, {});
    expect(fresh).toEqual({ tone: "x" });
  });
});

describe("the agent on ElevenLabs", () => {
  const spec = {
    name: "Maria (fazer.ai agents #1)",
    prompt: "Você é a Maria.",
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
    // The agent on the account carries the agent's own prompt; each call still sends its own.
    expect(cc.agent?.prompt).toMatchObject({ prompt: "Você é a Maria." });
  });

  test("a changed prompt is written to the agent there", async () => {
    const api = fakeApi([
      [200, { agent_id: "agent_p" }],
      [200, {}],
    ]);
    await ensureElevenLabsAgent("k", null, spec, api.fetchImpl, digests, hold);
    await ensureElevenLabsAgent(
      "k",
      "agent_p",
      { ...spec, prompt: "Você é a Maria, agora da loja nova." },
      api.fetchImpl,
      digests,
      hold,
    );
    expect(api.calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
    const patched = api.calls[1]?.body as {
      conversation_config: { agent: { prompt: { prompt: string } } };
    };
    expect(patched.conversation_config.agent.prompt.prompt).toBe(
      "Você é a Maria, agora da loja nova.",
    );
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
      prompt: "p",
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
      prompt: "p",
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
    // The wait for the hello is not on the form, so it never holds the save.
    expect(
      callsFormErrors({
        ...valid,
        speed: "1,5",
        maxDurationMin: "0",
        openingDelaySecs: "6",
        backgroundVolume: "0",
      }),
    ).toEqual(["speed", "maxDurationMin"]);
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

  // The server takes the silence in whole seconds, so 12,5 has to hold the save rather than come back
  // as a refusal from a save the form let through.
  test("a fraction of a second of silence holds the save", () => {
    expect(
      callsFormErrors({
        ...valid,
        endOnSilence: true,
        silenceEndCallSecs: "12,5",
      }),
    ).toEqual(["silenceEndCallSecs"]);
  });

  // With no background sound the volume is not drawn, so a value out of range is left out for the
  // default instead of being sent to a refusal nobody can see the field for.
  test("an undrawn volume or hello wait out of range is left out of the save", () => {
    const saved = callsSettingsFrom({
      ...valid,
      backgroundSound: "",
      backgroundVolume: "0",
      openingDelaySecs: "6",
    });
    expect(saved.backgroundVolume).toBeUndefined();
    expect(saved.openingDelayMs).toBeUndefined();
    expect(
      callsSettingsFrom({
        ...valid,
        backgroundSound: "",
        backgroundVolume: "20",
      }).backgroundVolume,
    ).toBe(0.2);
  });
});

describe("an agent deleted on ElevenLabs after this process wrote it", () => {
  const spec = {
    name: "Maria (fazer.ai agents #1)",
    prompt: "Você é a Maria.",
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
    const spec = {
      name: "Maria",
      prompt: "p",
      voice: "v1",
      calls: readCallsConfig({}),
    };
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

describe("a key ElevenLabs refuses", () => {
  const refused = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  const invalid = {
    detail: { status: "invalid_api_key", message: "Invalid API key" },
  };
  const scoped = {
    detail: {
      status: "missing_permissions",
      message: "The API key is missing the permission convai_read",
    },
  };

  test("is named by the access check, with ElevenLabs' words and not its JSON", async () => {
    expect(
      await checkElevenLabsAgentsAccess("k", refused(401, invalid)),
    ).toEqual({ ok: false, reason: "invalid_key", detail: "Invalid API key" });
    expect(
      await checkElevenLabsAgentsAccess("k", refused(401, scoped)),
    ).toMatchObject({ ok: false, reason: "missing_permission" });
  });

  test("is named the same when the agent is written without that check", async () => {
    const writing = ensureElevenLabsAgent(
      "k",
      null,
      {
        name: "Maria",
        prompt: "p",
        voice: "v1",
        calls: readCallsConfig({}),
      },
      refused(401, invalid),
      digests,
      hold,
    );
    await expect(writing).rejects.toBeInstanceOf(ElevenLabsRefusal);
    await expect(writing).rejects.toMatchObject({
      keyProblem: "invalid_key",
      text: "Invalid API key",
    });
  });

  test("a refusal of the settings is not the key's", async () => {
    await expect(
      ensureElevenLabsAgent(
        "k",
        null,
        {
          name: "Maria",
          prompt: "p",
          voice: "v1",
          calls: readCallsConfig({}),
        },
        refused(422, { detail: "voice not found" }),
        digests,
        hold,
      ),
    ).rejects.toMatchObject({ keyProblem: null, text: "voice not found" });
  });
});

describe("a stored key the runtime will not send as a header", () => {
  // A newline pasted with the key: Bun refuses the header before any request, and names its value.
  const key = "sk_secret_part\nrest_of_the_key";
  // Bun's own fetch (the DOM setup replaces the global one, and its AbortSignal with it), on a port
  // nothing listens on: its header validation refuses the key before the connect.
  const bunFetch = (globalThis as unknown as { BunFetch: typeof fetch })
    .BunFetch;
  const sends = (input: string, init?: RequestInit) =>
    bunFetch(`http://127.0.0.1:9/${input.length}`, {
      ...init,
      signal: undefined,
    });
  const sendingAll = sends as unknown as typeof fetch;
  // Only the request named goes through the validation; every other one is answered.
  const sendingOnly = (part: string) =>
    (async (input: string, init?: RequestInit) =>
      input.includes(part)
        ? sends(input, init)
        : new Response("{}")) as unknown as typeof fetch;
  const spec = {
    name: "Maria",
    prompt: "p",
    voice: "v1",
    calls: readCallsConfig({}),
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
  const handlers: VoiceSessionHandlers = {
    onAudio: () => {},
    onInterrupt: () => {},
    onTranscript: () => {},
    onHangup: () => {},
    onError: () => {},
  };
  const leaked = (text: string) =>
    text.includes("sk_secret_part") || text.includes("rest_of_the_key");

  test("is called an invalid key by the access check, without the key in what it says", async () => {
    // Each character Bun refuses in a header value, and one it takes (Latin-1) that stays a key.
    for (const bad of ["\n", "\r", "\0", "\u0100"]) {
      const result = await checkElevenLabsAgentsAccess(
        `sk_secret_part${bad}rest_of_the_key`,
        sendingAll,
      );
      expect(result, JSON.stringify(bad)).toMatchObject({
        ok: false,
        reason: "invalid_key",
      });
      expect(leaked(JSON.stringify(result)), JSON.stringify(bad)).toBe(false);
    }
    expect(
      await checkElevenLabsAgentsAccess(
        "sk_latin_\u00fc",
        (async () => new Response("{}")) as unknown as typeof fetch,
      ),
    ).toEqual({ ok: true });
  });

  test("fails each request of a call's setup and of the call as the key's problem, never echoing it", async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "writing the agent",
        () => ensureElevenLabsAgent(key, null, spec, sendingAll, digests, hold),
      ],
      [
        "declaring the tools",
        () =>
          elevenLabsProvider({
            apiKey: key,
            agentId: "agent_key_tools",
            fetchImpl: sendingOnly("/v1/convai/agents/"),
            holdEngine: hold,
            configDigests: digests,
          }).open(config, handlers),
      ],
      [
        "asking for the call's URL",
        async () => {
          // The tools declared by an earlier call, so this one goes straight to the URL.
          await elevenLabsProvider({
            apiKey: "k",
            agentId: "agent_key_url",
            fetchImpl: (async (input: string) =>
              new Response("{}", {
                status: input.includes("get-signed-url") ? 500 : 200,
              })) as unknown as typeof fetch,
            holdEngine: hold,
            configDigests: digests,
          })
            .open(config, handlers)
            .catch(() => {});
          return elevenLabsProvider({
            apiKey: key,
            agentId: "agent_key_url",
            fetchImpl: sendingOnly("get-signed-url"),
            holdEngine: hold,
            configDigests: digests,
          }).open(config, handlers);
        },
      ],
    ];
    for (const [what, run] of cases) {
      const err = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, what).toBeInstanceOf(ElevenLabsRefusal);
      expect(err, what).toMatchObject({ keyProblem: "invalid_key" });
      expect(leaked(String((err as Error).message)), what).toBe(false);
    }
  });
});
