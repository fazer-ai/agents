// ElevenLabs Agents as the voice engine of a call. The agent is configured on ElevenLabs with
// pcm_16000 both ways, which is the call's own format, so audio passes through untouched. The
// prompt and the greeting are overridden per call, which the agent has to allow
// (platform_settings.overrides). The agent's tools are declared on it before the call opens and run
// here, answered on the call's socket.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { withKeyedQueue } from "@/lib/locks";
import { pcmFromBase64, pcmToBase64 } from "../pcm";
import { type ConfigDigests, dbConfigDigests } from "./config-digests";
import { forgetElevenLabsAgent, keyedFetch } from "./elevenlabs-agent";
import { syncElevenLabsTools, VOICE_TOOL_TIMEOUT_MS } from "./elevenlabs-tools";
import {
  dbEngineHold,
  type EngineHold,
  type HoldEngineAgent,
} from "./engine-hold";
import { withDeadline } from "./tool-deadline";
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
  /** How a call holds the agent across processes; the database by default. */
  holdEngine?: HoldEngineAgent;
  base?: PrismaClient;
  /** Where a gone agent's configuration is forgotten; the database (`base`) by default. */
  configDigests?: ConfigDigests;
}

export function elevenLabsProvider(options: ElevenLabsOptions): VoiceProvider {
  return {
    name: "elevenlabs",
    open: (config, handlers, signal) =>
      openSession(options, config, handlers, signal),
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
  const res = await keyedFetch(
    fetchImpl,
    options.apiKey,
    `${API}/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(options.agentId)}`,
    { signal },
  );
  if (res.status === 404)
    await forgetElevenLabsAgent(
      options.agentId,
      options.configDigests ?? dbConfigDigests(options.base),
    );
  if (!res.ok)
    throw new Error(`elevenlabs: signed url failed with ${res.status}`);
  const body = (await res.json()) as { signed_url?: string };
  if (!body.signed_url) throw new Error("elevenlabs: signed url missing");
  return body.signed_url;
}

// The tools are declared on the ElevenLabs agent, shared by every call it takes, and carry what this
// call's conversation holds (its card, its labels); a conversation takes them as they are when it
// starts. So one call holds the agent from declaring its tools until its conversation started, and
// the next call declares its own only then. In this process through a queue, and across the processes
// that take calls (web replicas do) through the engine hold.
// A call that ended while queued leaves the wait at once, and gives its turn up when it comes, so the
// calls behind it do not wait for an abandoned start.
function holdHere(
  agentId: string,
  signal: AbortSignal | undefined,
): Promise<() => void> {
  return new Promise((acquired, refused) => {
    const gaveUp = () =>
      refused(new Error("elevenlabs: the call ended before it started"));
    if (signal?.aborted) return gaveUp();
    signal?.addEventListener("abort", gaveUp, { once: true });
    void withKeyedQueue(
      `elevenlabs-agent:${agentId}`,
      () =>
        new Promise<void>((release) => {
          signal?.removeEventListener("abort", gaveUp);
          if (signal?.aborted) release();
          else acquired(release);
        }),
    );
  });
}

// The longest a start holds the agent: the declaration and the signed URL, the socket's opening and
// the conversation's start, each bounded by the open deadline, with a margin for the round trips.
// A deadline, cut short by the call's end when there is one.
function withEnd(deadline: AbortSignal, ended: AbortSignal | undefined) {
  return ended ? AbortSignal.any([deadline, ended]) : deadline;
}

function holdLeaseMs(openTimeoutMs: number): number {
  return openTimeoutMs * 3 + 5_000;
}

async function openSession(
  options: ElevenLabsOptions,
  config: VoiceSessionConfig,
  handlers: VoiceSessionHandlers,
  callEnded?: AbortSignal,
): Promise<VoiceSession> {
  const openMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const leaseMs = holdLeaseMs(openMs);
  const releaseHere = await holdHere(options.agentId, callEnded);
  let hold: EngineHold;
  try {
    // A holder elsewhere frees the agent within its lease, so waiting longer means it is stuck.
    hold = await (options.holdEngine ?? dbEngineHold(leaseMs, options.base))(
      options.agentId,
      withEnd(AbortSignal.timeout(leaseMs), callEnded),
    );
  } catch (err) {
    releaseHere();
    throw new Error(
      `elevenlabs: the agent is held by another call's start: ${(err as Error).message}`,
    );
  }
  let released = false;
  // The hold is bounded from here, not from `begin`: an inbound call opens on its start frame and
  // begins on its answer, and an answer that never comes would otherwise keep every later call to
  // this agent waiting in this process after the lease let the others through. A call that has not
  // started its conversation when the lease passes is failed, since its declaration may be gone.
  const holdTimer = setTimeout(() => {
    if (released) return;
    release();
    handlers.onError(
      new Error("elevenlabs: the call did not start within the agent's hold"),
    );
  }, leaseMs);
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(holdTimer);
    releaseHere();
    void hold.release().catch((err: Error) => {
      logger.warn(
        "elevenlabs: the agent hold was not released: %s",
        err.message,
      );
    });
  };
  try {
    return await openHeld(options, config, handlers, hold, release, callEnded);
  } catch (err) {
    release();
    throw err;
  }
}

async function openHeld(
  options: ElevenLabsOptions,
  config: VoiceSessionConfig,
  handlers: VoiceSessionHandlers,
  hold: EngineHold,
  release: () => void,
  callEnded: AbortSignal | undefined,
): Promise<VoiceSession> {
  // The agent is held from here: a declaration or a signed URL that hangs would hold every later
  // call to it, so both are bounded by the same deadline as the socket's opening, and both stop
  // when the call ends.
  const signal = withEnd(
    AbortSignal.timeout(options.openTimeoutMs ?? OPEN_TIMEOUT_MS),
    callEnded,
  );
  const declared = await syncElevenLabsTools(
    {
      ...options,
      signal,
      declared: hold.declaredDigest,
      onDeclaring: () => hold.markDeclared(null),
      configDigests: options.configDigests ?? dbConfigDigests(options.base),
    },
    config.tools,
  );
  if (declared) await hold.markDeclared(declared);
  const ws = new WebSocket(await signedUrl(options, signal));
  const startedAt = Date.now();
  let closed = false;
  // Aborted on close: a tool still running when the call ends sends nothing after it.
  const ended = new AbortController();
  let started = false;
  const pending: Int16Array[] = [];
  let heardVoice = false;
  // Armed once the conversation is asked for: the agent is held until ElevenLabs says it started.
  let startTimer: ReturnType<typeof setTimeout> | null = null;

  await new Promise<void>((resolve, reject) => {
    // A handshake that lands after the call gave up would be a socket nobody closes.
    const giveUp = (why: string) => {
      clearTimeout(timer);
      callEnded?.removeEventListener("abort", onEnded);
      ws.close();
      reject(new Error(why));
    };
    const timer = setTimeout(
      () => giveUp("elevenlabs: open timed out"),
      options.openTimeoutMs ?? OPEN_TIMEOUT_MS,
    );
    const onEnded = () =>
      giveUp("elevenlabs: the call ended before it started");
    if (callEnded?.aborted) return onEnded();
    callEnded?.addEventListener("abort", onEnded, { once: true });
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      callEnded?.removeEventListener("abort", onEnded);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      callEnded?.removeEventListener("abort", onEnded);
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
        ended.signal,
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
        // Heard, however quietly said: the person has spoken and the agent is not to open the call.
        if (text) heardVoice = true;
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
    // A tool's answer can no longer reach the engine, whatever audio the bridge still plays out.
    ended.abort();
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
      ended.abort();
      if (startTimer) clearTimeout(startTimer);
      release();
      ws.close();
    },
  };
}
