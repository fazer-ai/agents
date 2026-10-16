// ElevenLabs Agents as the voice engine of a call. The agent is configured on ElevenLabs with
// pcm_16000 both ways, which is the call's own format, so audio passes through untouched. The
// prompt and the greeting are overridden per call, which the agent has to allow
// (platform_settings.overrides). The agent's tools are declared on it before the call opens and run
// here, answered on the call's socket.

import { withKeyedQueue } from "@/lib/locks";
import { pcmFromBase64, pcmToBase64 } from "../pcm";
import { forgetElevenLabsAgent } from "./elevenlabs-agent";
import { syncElevenLabsTools, VOICE_TOOL_TIMEOUT_MS } from "./elevenlabs-tools";
import { withDeadline } from "./realtime-tools";
import type {
  VoiceProvider,
  VoiceSession,
  VoiceSessionConfig,
  VoiceSessionHandlers,
} from "./types";

const API = "https://api.elevenlabs.io";

interface ServerEvent {
  type?: string;
  conversation_initiation_metadata_event?: {
    conversation_id?: string;
    agent_output_audio_format?: string;
    user_input_audio_format?: string;
  };
  audio_event?: { audio_base_64?: string };
  user_transcription_event?: { user_transcript?: string };
  agent_response_event?: { agent_response?: string };
  ping_event?: { event_id?: number; ping_ms?: number };
  client_tool_call?: {
    tool_name?: string;
    tool_call_id?: string;
    parameters?: Record<string, unknown>;
  };
}
const OPEN_TIMEOUT_MS = 10_000;

export interface ElevenLabsOptions {
  apiKey: string;
  agentId: string;
  toolSound?: string | null;
  fetchImpl?: typeof fetch;
  openTimeoutMs?: number;
}

export function elevenLabsProvider(options: ElevenLabsOptions): VoiceProvider {
  return {
    name: "elevenlabs",
    open: (config, handlers) => openSession(options, config, handlers),
  };
}

// Peak above which a frame counts as the person speaking, not line noise.
const VOICE_PEAK = 1_500;

function loud(pcm: Int16Array): boolean {
  for (const sample of pcm) if (Math.abs(sample) > VOICE_PEAK) return true;
  return false;
}

async function signedUrl(
  options: ElevenLabsOptions,
  signal: AbortSignal,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(options.agentId)}`,
    { headers: { "xi-api-key": options.apiKey }, signal },
  );
  if (res.status === 404) forgetElevenLabsAgent(options.agentId);
  if (!res.ok)
    throw new Error(`elevenlabs: signed url failed with ${res.status}`);
  const body = (await res.json()) as { signed_url?: string };
  if (!body.signed_url) throw new Error("elevenlabs: signed url missing");
  return body.signed_url;
}

// The tools are declared on the ElevenLabs agent, shared by every call it takes, and carry what this
// call's conversation holds (its card, its labels); a conversation takes them as they are when it
// starts. So one call holds the agent from declaring its tools until its conversation started, and
// the next call declares its own only then. Within this process: calls are served by the single
// replica that runs the workers (docs/deploy.md).
function holdAgent(agentId: string): Promise<() => void> {
  return new Promise((acquired) => {
    void withKeyedQueue(
      `elevenlabs-agent:${agentId}`,
      () => new Promise<void>((release) => acquired(release)),
    );
  });
}

async function openSession(
  options: ElevenLabsOptions,
  config: VoiceSessionConfig,
  handlers: VoiceSessionHandlers,
): Promise<VoiceSession> {
  const release = await holdAgent(options.agentId);
  try {
    return await openHeld(options, config, handlers, release);
  } catch (err) {
    release();
    throw err;
  }
}

async function openHeld(
  options: ElevenLabsOptions,
  config: VoiceSessionConfig,
  handlers: VoiceSessionHandlers,
  release: () => void,
): Promise<VoiceSession> {
  // The agent is held from here: a declaration or a signed URL that hangs would hold every later
  // call to it, so both are bounded by the same deadline as the socket's opening.
  const signal = AbortSignal.timeout(options.openTimeoutMs ?? OPEN_TIMEOUT_MS);
  await syncElevenLabsTools({ ...options, signal }, config.tools);
  const ws = new WebSocket(await signedUrl(options, signal));
  const startedAt = Date.now();
  let closed = false;
  let started = false;
  const pending: Int16Array[] = [];
  let heardVoice = false;
  // Armed once the conversation is asked for: the agent is held until ElevenLabs says it started.
  let startTimer: ReturnType<typeof setTimeout> | null = null;

  await new Promise<void>((resolve, reject) => {
    // A handshake that lands after the call gave up would be a socket nobody closes.
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("elevenlabs: open timed out"));
    }, options.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("elevenlabs: could not open the socket"));
    });
  });

  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };

  const tools = new Map((config.tools ?? []).map((tool) => [tool.name, tool]));
  const runTool = async (
    call: NonNullable<ServerEvent["client_tool_call"]>,
  ) => {
    const name = call.tool_name ?? "";
    const id = call.tool_call_id ?? "";
    const tool = tools.get(name);
    const started = Date.now();
    let result: string;
    let isError = false;
    try {
      if (!tool) throw new Error(`unknown tool ${name}`);
      result = await withDeadline(
        (signal) => tool.invoke(call.parameters ?? {}, id, signal),
        VOICE_TOOL_TIMEOUT_MS,
      );
    } catch (err) {
      result = `Erro ao usar a ferramenta: ${(err as Error).message}`;
      isError = true;
    }
    handlers.onMetric?.(`tool_ms:${name}`, Date.now() - started);
    handlers.onTool?.(name, !isError);
    send({
      type: "client_tool_result",
      tool_call_id: id,
      result,
      is_error: isError,
    });
  };

  ws.addEventListener("message", (message) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(message.data));
    } catch {
      return;
    }
    switch (event.type) {
      case "conversation_initiation_metadata": {
        if (startTimer) clearTimeout(startTimer);
        release();
        const meta = event.conversation_initiation_metadata_event ?? {};
        if (meta.conversation_id)
          handlers.onEngineConversation?.(meta.conversation_id);
        if (
          meta.agent_output_audio_format !== "pcm_16000" ||
          meta.user_input_audio_format !== "pcm_16000"
        ) {
          handlers.onError(
            new Error(
              `elevenlabs: the agent must speak pcm_16000 both ways (got ${meta.user_input_audio_format}/${meta.agent_output_audio_format})`,
            ),
          );
        }
        break;
      }
      case "audio": {
        const b64 = event.audio_event?.audio_base_64;
        if (b64) handlers.onAudio(pcmFromBase64(b64));
        break;
      }
      case "interruption":
        handlers.onInterrupt();
        break;
      case "user_transcript": {
        const text = String(
          event.user_transcription_event?.user_transcript ?? "",
        ).trim();
        if (text)
          handlers.onTranscript({
            role: "user",
            text,
            atMs: Date.now() - startedAt,
          });
        break;
      }
      case "agent_response": {
        const text = String(
          event.agent_response_event?.agent_response ?? "",
        ).trim();
        if (text)
          handlers.onTranscript({
            role: "agent",
            text,
            atMs: Date.now() - startedAt,
          });
        break;
      }
      case "client_tool_call":
        if (event.client_tool_call) void runTool(event.client_tool_call);
        break;
      case "ping":
        setTimeout(
          () => send({ type: "pong", event_id: event.ping_event?.event_id }),
          Number(event.ping_event?.ping_ms ?? 0),
        );
        break;
    }
  });
  ws.addEventListener("close", (closeEvent) => {
    release();
    // NOTE: the agent's end_call system tool ends the conversation by closing the socket.
    if (!closed) handlers.onHangup(`elevenlabs_closed_${closeEvent.code}`);
  });

  return {
    sendAudio(pcm16k) {
      if (!heardVoice && loud(pcm16k)) heardVoice = true;
      if (!started) {
        pending.push(pcm16k);
        return;
      }
      send({ user_audio_chunk: pcmToBase64(pcm16k) });
    },
    begin() {
      if (started) return;
      started = true;
      startTimer = setTimeout(() => {
        release();
        if (closed) return;
        handlers.onError(
          new Error("elevenlabs: the conversation did not start"),
        );
      }, options.openTimeoutMs ?? OPEN_TIMEOUT_MS);
      send({
        type: "conversation_initiation_client_data",
        dynamic_variables: config.variables,
        conversation_config_override: {
          agent: {
            prompt: { prompt: config.instructions },
            first_message: config.greeting,
            language: config.language.split("-")[0],
          },
        },
      });
      for (const chunk of pending.splice(0))
        send({ user_audio_chunk: pcmToBase64(chunk) });
      // NOTE: an empty first_message makes the agent wait for the person to speak; a call this side
      // opens has the model write its own opening, which the platform only does in reply to a turn.
      // It waits openingDelayMs first: a person who answers with "alô?" is answered instead.
      if (config.opensCall && !config.greeting.trim())
        setTimeout(() => {
          if (closed || heardVoice) return;
          send({
            type: "user_message",
            text: "(a ligação foi atendida agora; abra a conversa)",
          });
        }, config.openingDelayMs ?? 0);
    },
    close() {
      closed = true;
      if (startTimer) clearTimeout(startTimer);
      release();
      ws.close();
    },
  };
}
