// The seam between a WhatsApp call's voice and a speech-to-speech engine. Audio crosses it as
// 16 kHz mono PCM, which is what the whatsapp-connector media stream carries.

export type CallDirection = "inbound" | "outbound";

/** A tool of the agent, offered to the voice model as a JSON Schema function. */
export interface VoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** `signal` is the invocation's deadline: past it the tool sends nothing and cancels what it sent. */
  invoke(args: unknown, callId: string, signal?: AbortSignal): Promise<string>;
}

export interface VoiceSessionConfig {
  instructions: string;
  /** What the agent says first, once the call is answered. Empty lets the model open the call. */
  greeting: string;
  /** Whether the agent speaks first once the call is answered, or waits to hear the other side. */
  opensCall: boolean;
  /** How long the agent waits for the person to speak before opening the call itself. */
  openingDelayMs?: number;
  language: string;
  voice?: string;
  direction: CallDirection;
  variables: Record<string, string>;
  tools?: VoiceTool[];
}

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  atMs: number;
}

export interface VoiceSessionHandlers {
  /** Agent speech to play into the call. */
  onAudio(pcm16k: Int16Array): void;
  /** The person spoke over the agent: whatever is queued and not played yet must go. */
  onInterrupt(): void;
  onTranscript(entry: TranscriptEntry): void;
  /** The agent decided the call is over. */
  onHangup(reason: string): void;
  onError(error: Error): void;
  /** The engine's own id for this conversation, where its transcript and analysis can be read later. */
  onEngineConversation?(id: string): void;
  /** The agent ran one of its tools; `ok` is false when it failed or timed out. */
  onTool?(name: string, ok: boolean): void;
  /** A measurement worth logging, such as how long the agent took to start answering. */
  onMetric?(name: string, value: number): void;
}

export interface VoiceSession {
  sendAudio(pcm16k: Int16Array): void;
  /** The call is answered: the agent may speak from now on. */
  begin(): void;
  close(): void;
}

export interface VoiceProvider {
  readonly name: string;
  /** `signal` aborts when the call's stream ended before the session opened: the start gives up. */
  open(
    config: VoiceSessionConfig,
    handlers: VoiceSessionHandlers,
    signal?: AbortSignal,
  ): Promise<VoiceSession>;
}
