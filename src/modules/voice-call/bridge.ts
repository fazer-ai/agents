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
// The most of the caller's voice kept while the engine connects; what comes after it is dropped.
const EARLY_MAX_SAMPLES = CALL_RATE * 10;
// Peak above which a frame from the person counts as speech, not line noise.
const VOICE_PEAK = 1_500;

const FAREWELL =
  /\b(tchau|até logo|até mais|até a próxima|até breve|tenha um (ótimo|bom|excelente|lindo) (dia|tarde|noite|fim de semana)|uma ótima (tarde|noite)|fique bem|boa (tarde|noite) pra você)\b/i;

/**
 * Whether an answer of the agent closes the call: it says goodbye and asks nothing. The model is told
 * to call end_call after a farewell, and some never do (qwen, measured 0 in 3): the call is then
 * ended by the bridge once the farewell has played and the person stays silent.
 */
export function isFarewell(text: string): boolean {
  const t = text.trim();
  return FAREWELL.test(t) && !t.includes("?");
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
}

export class CallBridge {
  private session: VoiceSession | null = null;
  private opening: Promise<void> | null = null;
  private start: CallStart | null = null;
  private answered = false;
  private finished = false;
  private playoutEnd = 0;
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
    switch (frame.event) {
      case "start":
        if (this.start) return;
        this.start = {
          callId: typeof frame.call_id === "string" ? frame.call_id : null,
          direction: frame.direction === "outbound" ? "outbound" : "inbound",
          peer: typeof frame.peer === "string" ? frame.peer : null,
        };
        this.log("call stream started", { direction: this.start.direction });
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
        void this.opening?.then(() => this.session?.begin());
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

  private async openSession() {
    if (!this.start) return;
    try {
      const config = await this.options.configure(this.start);
      this.session = await this.options.provider.open(config, {
        onAudio: (pcm) => {
          if (this.finished) return;
          this.options.tap?.agent?.(pcm);
          const now = Date.now();
          this.playoutEnd =
            Math.max(this.playoutEnd, now) + pcmMs(pcm.length, CALL_RATE);
          this.socket.send(
            JSON.stringify({ event: "media", payload: pcmToBase64(pcm) }),
          );
        },
        onInterrupt: () => {
          this.playoutEnd = Date.now();
          this.socket.send(JSON.stringify({ event: "clear" }));
        },
        onTranscript: (entry) => {
          this.transcript.push(entry);
          this.options.onTranscript?.(entry);
          if (entry.role === "agent" && isFarewell(entry.text))
            this.armFarewell();
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
      });
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
    const check = () => {
      if (this.finished || this.hangupTimer) return;
      // From the end of what is still playing: audio that arrived after the transcript moves it.
      const left = this.playoutEnd + FAREWELL_SILENCE_MS - Date.now();
      if (left > 0) {
        this.farewellTimer = setTimeout(check, left);
        return;
      }
      this.farewellTimer = null;
      this.log("farewell went unanswered; hanging up");
      this.hangupNow("agent", "farewell");
    };
    this.farewellTimer = setTimeout(
      check,
      Math.max(0, this.playoutEnd - Date.now()) + FAREWELL_SILENCE_MS,
    );
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
