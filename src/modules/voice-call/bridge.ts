// One WhatsApp call carried between the whatsapp-connector media stream and a voice engine.
//
// The connector speaks JSON text frames: `start` (call metadata and audio format), `answered`
// (the voice is wired: speak from now on), `media` (base64 PCM, 16 kHz mono), `stop`. This side
// answers with `media`, `clear` (drop what was queued and not played: the person barged in) and
// `hangup`, with who ended it (`agent` or `error`) and why. Audio the engine produces faster than
// real time is queued on the connector, so the bridge keeps the queue's play-out horizon to hang up only after the farewell has been heard.

import { pcmFromBase64, pcmMs, pcmToBase64 } from "./pcm";
import type {
  CallDirection,
  TranscriptEntry,
  VoiceProvider,
  VoiceSession,
  VoiceSessionConfig,
} from "./providers/types";

const CALL_RATE = 16_000;
const HANGUP_TAIL_MS = 600;
// After a farewell has been heard, how long the person has to say something before the call ends.
const FAREWELL_SILENCE_MS = 2_500;
// How long a goodbye's transcript waits for its audio when the audio has not started: the engine can
// send the words seconds before it speaks them, and the silence counts from the end of what is heard.
const FAREWELL_AUDIO_WAIT_MS = 8_000;
// The most of the caller's voice kept while the engine connects; what comes after it is dropped.
const EARLY_MAX_SAMPLES = CALL_RATE * 10;
// Peak above which a frame from the person counts as speech, not line noise.
const VOICE_PEAK = 1_500;

// Bounded by letters on both sides, not `\b`: an ASCII boundary that never sees the end of "você".
const FAREWELL =
  /(?<![\p{L}\p{N}])(tchau|até logo|até mais(?! tarde)|até a próxima|até breve|tenha um (ótimo|bom|excelente|lindo) (dia|tarde|noite|fim de semana)|uma ótima (tarde|noite)|fique bem|boa (tarde|noite) pra você)(?![\p{L}\p{N}])/iu;

/**
 * Whether an answer of the agent closes the call: it says goodbye and asks nothing. The model is told
 * to call end_call after a farewell, and some never do (qwen, measured 0 in 3): the call is then
 * ended by the bridge once the farewell has played and the person stays silent.
 */
export function isFarewell(text: string): boolean {
  const t = text.trim();
  if (t.includes("?")) return false;
  // A goodbye closes what is said: the phrase in an opening ("Uma ótima tarde! Aqui é a Ana") or in
  // the middle of an answer is no farewell, so only the last sentence is read.
  const sentences = t.split(/(?<=[.!…])\s+/).filter(Boolean);
  return FAREWELL.test(sentences.at(-1) ?? "");
}

// The agent's audio carries the background sound the whole call, so its VOICE is read by level: 50 ms
// windows above this RMS. Measured on a call with the background on, 100 ms windows: the background
// between 0.009 and 0.016 of full scale, the voice above 0.05.
const AGENT_VOICE_RMS = 0.035 * 32_768;
const VOICE_WINDOW = CALL_RATE / 20;

/** Where the voice in a chunk of the agent's audio ends, in ms after the chunk starts; null for none. */
export function voiceEndInMs(pcm: Int16Array): number | null {
  let end: number | null = null;
  for (let i = 0; i < pcm.length; i += VOICE_WINDOW) {
    const stop = Math.min(pcm.length, i + VOICE_WINDOW);
    let sum = 0;
    for (let j = i; j < stop; j++) sum += (pcm[j] as number) ** 2;
    if (Math.sqrt(sum / (stop - i)) > AGENT_VOICE_RMS)
      end = pcmMs(stop, CALL_RATE);
  }
  return end;
}

function loud(pcm: Int16Array): boolean {
  for (const sample of pcm) if (Math.abs(sample) > VOICE_PEAK) return true;
  return false;
}

export interface CallStart {
  callId: string | null;
  direction: CallDirection;
  peer: string | null;
}

export interface CallRecord extends CallStart {
  provider: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
  endedBy: "connector" | "agent" | "error";
  endReason: string | null;
  // The voice engine's id for the conversation, where its summary is read once the call is over.
  engineConversationId: string | null;
  transcript: TranscriptEntry[];
}

export interface StreamSocket {
  send(text: string): void;
  close(): void;
}

export interface CallBridgeOptions {
  provider: VoiceProvider;
  /** Builds the engine's configuration once the connector said who is on the call. */
  configure(start: CallStart): Promise<VoiceSessionConfig> | VoiceSessionConfig;
  onFinished(record: CallRecord): void;
  /** Each line of the transcript as it is heard, for a caller that shows the call live. */
  onTranscript?(entry: TranscriptEntry): void;
  /** Each tool the agent ran, as it returns, for a caller that shows the call live. */
  onTool?(name: string, ok: boolean): void;
  /** The voice engine is connected: the agent is about to speak. */
  onReady?(): void;
  /** Taps for tests and recordings: what the person said and what the agent said, 16 kHz. */
  tap?: { caller?(pcm: Int16Array): void; agent?(pcm: Int16Array): void };
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** The direction the stream's URL named, for a start frame that leaves it out. */
  direction?: CallDirection;
}

export class CallBridge {
  private session: VoiceSession | null = null;
  private opening: Promise<void> | null = null;
  private start: CallStart | null = null;
  private answered = false;
  private finished = false;
  // Aborted when the call ends: an engine still starting (queued for its agent, holding it, or in
  // its handshake) gives up then, instead of finishing a start nobody is on the line for.
  private readonly ended = new AbortController();
  private playoutEnd = 0;
  // When the agent's voice (not its background sound) stops playing on the line.
  private voiceEnd = 0;
  // The pending goodbye: when it was said, and whether any of its audio reached the line yet.
  private farewellAt = 0;
  private farewellHeard = false;
  private readonly startedAt = new Date();
  private answeredAt: Date | null = null;
  private readonly transcript: TranscriptEntry[] = [];
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private engineConversationId: string | null = null;
  private farewellTimer: ReturnType<typeof setTimeout> | null = null;
  // The caller's voice from the answer until the engine is connected: their hello, often.
  private early: Int16Array[] = [];
  private earlySamples = 0;

  constructor(
    private readonly socket: StreamSocket,
    private readonly options: CallBridgeOptions,
  ) {}

  private log(message: string, fields?: Record<string, unknown>) {
    this.options.log?.(message, { callId: this.start?.callId, ...fields });
  }

  onMessage(raw: string) {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    // `null` is the one JSON value whose event cannot be read (a number or a string reads undefined):
    // the throw would leave a socket handler, where nothing catches it.
    if (frame === null) return;
    switch (frame.event) {
      case "start":
        if (this.start) return;
        this.start = {
          callId: typeof frame.call_id === "string" ? frame.call_id : null,
          direction:
            frame.direction === "outbound" || frame.direction === "inbound"
              ? frame.direction
              : (this.options.direction ?? "inbound"),
          peer: typeof frame.peer === "string" ? frame.peer : null,
        };
        this.log("call stream started", { direction: this.start.direction });
        // A placed call may ring for long, and opening the engine holds its agent for every other
        // call to it (providers/elevenlabs.ts): it opens once answered. A call to the inbox is
        // answered at once, so it opens now.
        if (this.start.direction === "inbound")
          this.opening = this.openSession();
        break;
      case "answered":
        if (!this.start) return;
        // NOTE: a placed call only has its id once dialled, after the stream opened.
        if (!this.start.callId && typeof frame.call_id === "string")
          this.start.callId = frame.call_id;
        this.answered = true;
        this.answeredAt = new Date();
        this.log("call answered");
        this.opening ??= this.openSession();
        void this.opening.then(() => {
          if (!this.finished) this.session?.begin();
        });
        break;
      case "media": {
        if (!this.answered) return;
        const pcm = pcmFromBase64(String(frame.payload ?? ""));
        this.options.tap?.caller?.(pcm);
        if (this.farewellTimer && loud(pcm)) this.cancelFarewell();
        if (this.session) this.session.sendAudio(pcm);
        else if (this.earlySamples + pcm.length <= EARLY_MAX_SAMPLES) {
          this.early.push(pcm);
          this.earlySamples += pcm.length;
        }
        break;
      }
      case "stop":
        this.finish("connector", "stopped");
        break;
    }
  }

  onClose() {
    this.finish("connector", "socket_closed");
  }

  /** Ends the call from this side now, as a shutdown that cannot wait for it does. */
  hangup(reason: string) {
    this.hangupNow("error", reason);
  }

  private async openSession() {
    if (!this.start) return;
    try {
      const config = await this.options.configure(this.start);
      // Ended while it was being configured: nothing to open, and no engine agent to hold.
      if (this.finished) return;
      this.session = await this.options.provider.open(
        config,
        {
          onAudio: (pcm) => {
            if (this.finished) return;
            this.options.tap?.agent?.(pcm);
            const now = Date.now();
            const startsAt = Math.max(this.playoutEnd, now);
            this.playoutEnd = startsAt + pcmMs(pcm.length, CALL_RATE);
            const voice = voiceEndInMs(pcm);
            if (voice === null) {
              this.socket.send(
                JSON.stringify({ event: "media", payload: pcmToBase64(pcm) }),
              );
              return;
            }
            this.voiceEnd = Math.max(this.voiceEnd, startsAt + voice);
            // The goodbye's voice started: its silence counts from the end of it, not from a bound.
            if (this.farewellTimer && !this.farewellHeard) {
              this.farewellHeard = true;
              this.scheduleFarewell();
            }
            this.socket.send(
              JSON.stringify({ event: "media", payload: pcmToBase64(pcm) }),
            );
          },
          onInterrupt: () => {
            // The person spoke over the goodbye: the call goes on.
            this.cancelFarewell();
            this.playoutEnd = Date.now();
            this.voiceEnd = this.playoutEnd;
            this.socket.send(JSON.stringify({ event: "clear" }));
          },
          onTranscript: (entry) => {
            this.transcript.push(entry);
            this.options.onTranscript?.(entry);
            if (entry.role === "agent" && isFarewell(entry.text))
              this.armFarewell();
            // A new turn of the person's, however quietly said: the goodbye was not the end.
            else if (entry.role === "user") this.cancelFarewell();
            this.log("transcript", {
              role: entry.role,
              chars: entry.text.length,
            });
          },
          onHangup: (reason) => this.hangupAfterPlayout(reason),
          onEngineConversation: (id) => {
            this.engineConversationId = id;
          },
          onTool: (name, ok) => this.options.onTool?.(name, ok),
          onMetric: (name, value) => this.log("metric", { name, value }),
          onError: (error) => {
            this.log("voice engine error", { error: error.message });
            if (!this.finished) this.hangupNow("error", error.message);
          },
        },
        this.ended.signal,
      );
      // In the same turn as the assignment, so nothing heard later can overtake it.
      for (const pcm of this.early.splice(0)) this.session.sendAudio(pcm);
      if (this.finished) this.session.close();
      else this.options.onReady?.();
    } catch (error) {
      this.log("could not open the voice engine", {
        error: (error as Error).message,
      });
      this.hangupNow("error", (error as Error).message);
    }
  }

  private armFarewell() {
    this.cancelFarewell();
    this.farewellAt = Date.now();
    // A voice still playing when the words arrive is the goodbye's own.
    this.farewellHeard = this.voiceEnd > this.farewellAt;
    this.scheduleFarewell();
  }

  // The next look at the pending goodbye: once its audio has played and the silence after it passed,
  // or, while its audio has not started, once the bound on waiting for it passed.
  private scheduleFarewell() {
    if (this.farewellTimer) clearTimeout(this.farewellTimer);
    const now = Date.now();
    const at = this.farewellHeard
      ? Math.max(this.voiceEnd, now) + FAREWELL_SILENCE_MS
      : this.farewellAt + FAREWELL_AUDIO_WAIT_MS;
    this.farewellTimer = setTimeout(() => this.checkFarewell(), at - now);
  }

  private checkFarewell() {
    this.farewellTimer = null;
    if (this.finished || this.hangupTimer) return;
    // From the end of the voice still playing: a voice that arrived after the transcript moves it,
    // and the background sound, which never stops, does not.
    if (
      this.farewellHeard &&
      this.voiceEnd + FAREWELL_SILENCE_MS > Date.now()
    ) {
      this.scheduleFarewell();
      return;
    }
    this.log("farewell went unanswered; hanging up");
    this.hangupNow("agent", "farewell");
  }

  private cancelFarewell() {
    if (this.farewellTimer) clearTimeout(this.farewellTimer);
    this.farewellTimer = null;
  }

  private hangupAfterPlayout(reason: string) {
    if (this.hangupTimer || this.finished) return;
    const wait = Math.max(0, this.playoutEnd - Date.now()) + HANGUP_TAIL_MS;
    this.log("agent ends the call", { reason, waitMs: Math.round(wait) });
    this.hangupTimer = setTimeout(() => this.hangupNow("agent", reason), wait);
  }

  private hangupNow(by: "agent" | "error", reason: string) {
    if (this.finished) return;
    this.socket.send(JSON.stringify({ event: "hangup", by, reason }));
    this.finish(by, reason);
    this.socket.close();
  }

  private finish(by: CallRecord["endedBy"], reason: string | null) {
    if (this.finished) return;
    this.finished = true;
    this.ended.abort();
    if (this.hangupTimer) clearTimeout(this.hangupTimer);
    this.cancelFarewell();
    this.session?.close();
    const start = this.start ?? {
      callId: null,
      direction: "inbound" as const,
      peer: null,
    };
    this.options.onFinished({
      ...start,
      provider: this.options.provider.name,
      startedAt: this.startedAt.toISOString(),
      answeredAt: this.answeredAt?.toISOString() ?? null,
      endedAt: new Date().toISOString(),
      endedBy: by,
      endReason: reason,
      engineConversationId: this.engineConversationId,
      transcript: [...this.transcript].sort((a, b) => a.atMs - b.atMs),
    });
  }
}
