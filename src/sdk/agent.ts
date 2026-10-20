// <fazer-ai-agent>: the client channel's widget, served by the instance at /api/v1/sdk/agent.js
// (docs/client-channel.md, "The widget"). A host page adds the script and the tag; the element signs
// in through the app's token route, runs turns against the SDK's turn route, runs the tools the page
// registered in the browser, and renders the conversation in its own shadow root.
import { renderMarkdown } from "./markdown";
import { readSse } from "./sse";
import { readClaims, stillFresh, tokenFromResponse } from "./token";

type Json = Record<string, unknown>;

export interface AgentTool {
  name: string;
  description: string;
  // What the progress line says while the tool runs, in place of its name.
  label?: string;
  parameters?: Json;
  run: (args: Json) => unknown | Promise<unknown>;
}

interface ClientToolSpec {
  name: string;
  description: string;
  parameters: Json;
}

interface ToolCall {
  toolCallId: string;
  name: string;
  args: Json;
}

type ToolAnswer = { ok: true; result: unknown } | { ok: false; error: string };

type TurnResult =
  | { threadId: string; status: "pending"; calls: ToolCall[] }
  | { threadId: string; status: "done"; reply: string };

type Message =
  // `voice`: a person's message that was spoken, shown with a mark beside the transcription.
  | { kind: "user" | "agent" | "error"; text: string; voice?: boolean }
  | { kind: "step"; name: string; ok?: boolean };

export interface AgentTexts {
  open: string;
  close: string;
  title: string;
  placeholder: string;
  send: string;
  reset: string;
  empty: string;
  thinking: string;
  failed: string;
  tooManySteps: string;
  signInFailed: string;
  record: string;
  cancelRecording: string;
  sendRecording: string;
  requestingMic: string;
  recording: string;
  recordingEnding: string;
  transcribing: string;
  voiceMark: string;
  micDenied: string;
  micMissing: string;
  voiceTooShort: string;
  voiceTooLong: string;
  voiceEmpty: string;
  voiceUnavailable: string;
  voiceFailed: string;
}

const TEXTS: Record<"en" | "pt", AgentTexts> = {
  en: {
    open: "Open the assistant",
    close: "Close the assistant",
    title: "Assistant",
    placeholder: "Ask anything about this page",
    send: "Send",
    reset: "New conversation",
    empty:
      "Ask about what you see here. The assistant reads what you can read and takes you where you need to go.",
    thinking: "Thinking…",
    failed: "The assistant could not answer.",
    tooManySteps: "The assistant took too many steps and stopped.",
    signInFailed: "Could not sign in to the assistant.",
    record: "Record a voice message",
    cancelRecording: "Cancel the recording",
    sendRecording: "Send the voice message",
    requestingMic: "Waiting for the microphone…",
    recording: "Recording",
    recordingEnding: "Sending by itself at 2:00",
    transcribing: "Transcribing…",
    voiceMark: "Voice message",
    micDenied: "The browser did not allow the microphone.",
    micMissing: "No microphone could be used.",
    voiceTooShort: "The recording was too short.",
    voiceTooLong: "The recording is too long to send.",
    voiceEmpty: "Nothing could be heard in the recording.",
    voiceUnavailable: "This assistant does not take voice messages.",
    voiceFailed: "The voice message could not be transcribed.",
  },
  pt: {
    open: "Abrir o assistente",
    close: "Fechar o assistente",
    title: "Assistente",
    placeholder: "Pergunte sobre esta página",
    send: "Enviar",
    reset: "Nova conversa",
    empty:
      "Pergunte sobre o que você vê aqui. O assistente lê o que você pode ler e leva você até onde precisa ir.",
    thinking: "Pensando…",
    failed: "O assistente não conseguiu responder.",
    tooManySteps: "O assistente deu passos demais e parou.",
    signInFailed: "Não foi possível entrar no assistente.",
    record: "Gravar mensagem de voz",
    cancelRecording: "Cancelar a gravação",
    sendRecording: "Enviar a mensagem de voz",
    requestingMic: "Aguardando o microfone…",
    recording: "Gravando",
    recordingEnding: "Envia sozinha em 2:00",
    transcribing: "Transcrevendo…",
    voiceMark: "Mensagem de voz",
    micDenied: "O navegador não liberou o microfone.",
    micMissing: "Nenhum microfone pôde ser usado.",
    voiceTooShort: "A gravação ficou curta demais.",
    voiceTooLong: "A gravação ficou longa demais para enviar.",
    voiceEmpty: "Não deu para ouvir nada na gravação.",
    voiceUnavailable: "Este assistente não recebe mensagens de voz.",
    voiceFailed: "Não foi possível transcrever a mensagem de voz.",
  },
};

// A turn can ask for tools several times before it answers; this bounds an agent that keeps asking.
const MAX_ROUNDS = 8;
// How much of the conversation is kept in the browser to show again after a reload.
const LOG_MAX = 40;
const HIGHLIGHT_TOOL = "highlight_element";
const HIGHLIGHT_MS = 6000;
const TARGET_ATTR = "data-fazer-ai-target";
// A voice message: stopped and sent by itself at the ceiling, with a warning shown before it, and one
// shorter than the floor is a tap, not a message.
const RECORDING_MAX_MS = 120_000;
const RECORDING_WARN_MS = 10_000;
const RECORDING_MIN_MS = 700;
// What the recorder is asked for, in order: the first the browser supports. Bun reads a multipart
// file's type from its name, so each goes with the extension the instance reads back as audio.
const RECORDING_TYPES: Array<[string, string]> = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/mp4", "m4a"],
];
// The textarea grows with what is typed up to this height, and only then scrolls.
const INPUT_MAX_PX = 120;

const SCRIPT_ORIGIN = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  try {
    return src ? new URL(src).origin : location.origin;
  } catch {
    return location.origin;
  }
})();

// Cloudflare's script for the human check an app may put before a new anonymous session, loaded only
// when the tag names a `turnstile-site-key` and a session has to be opened.
const TURNSTILE_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
    },
  ): string;
  remove(id: string): void;
}

let turnstileLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const w = window as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  turnstileLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () =>
      w.turnstile
        ? resolve(w.turnstile)
        : reject(new Error("fazer-ai-agent: Turnstile did not load"));
    script.onerror = () => {
      // NOTE: forgotten, so the next session tries the script again instead of failing forever.
      turnstileLoad = null;
      script.remove();
      reject(new Error("fazer-ai-agent: Turnstile did not load"));
    };
    document.head.appendChild(script);
  });
  return turnstileLoad;
}

const STYLE = `
:host {
  --fazer-ai-accent: #4f46e5;
  --fazer-ai-accent-text: #ffffff;
  --fazer-ai-bg: #ffffff;
  --fazer-ai-surface: #f4f4f5;
  --fazer-ai-text: #18181b;
  --fazer-ai-muted: #71717a;
  --fazer-ai-border: #e4e4e7;
  --fazer-ai-error: #b91c1c;
  --fazer-ai-radius: 12px;
  --fazer-ai-font: inherit;
  font-family: var(--fazer-ai-font);
  color: var(--fazer-ai-text);
}
:host([theme="dark"]) {
  --fazer-ai-accent: #818cf8;
  --fazer-ai-accent-text: #111827;
  --fazer-ai-bg: #18181b;
  --fazer-ai-surface: #27272a;
  --fazer-ai-text: #f4f4f5;
  --fazer-ai-muted: #a1a1aa;
  --fazer-ai-border: #3f3f46;
  --fazer-ai-error: #f87171;
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"]):not([theme="dark"])) {
    --fazer-ai-accent: #818cf8;
    --fazer-ai-accent-text: #111827;
    --fazer-ai-bg: #18181b;
    --fazer-ai-surface: #27272a;
    --fazer-ai-text: #f4f4f5;
    --fazer-ai-muted: #a1a1aa;
    --fazer-ai-border: #3f3f46;
    --fazer-ai-error: #f87171;
  }
}
* { box-sizing: border-box; }
.fab {
  position: fixed; bottom: var(--fazer-ai-offset-bottom, 24px); right: var(--fazer-ai-offset-side, 24px);
  z-index: 2147483000;
  width: 52px; height: 52px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--fazer-ai-accent); color: var(--fazer-ai-accent-text);
  box-shadow: 0 6px 20px rgba(0,0,0,.2); display: grid; place-items: center;
}
:host([position="bottom-left"]) .fab { right: auto; left: var(--fazer-ai-offset-side, 24px); }
.panel {
  position: fixed; bottom: calc(var(--fazer-ai-offset-bottom, 24px) + 64px);
  right: var(--fazer-ai-offset-side, 24px); z-index: 2147483000;
  width: min(400px, calc(100vw - var(--fazer-ai-offset-side, 24px) - 16px));
  height: min(600px, calc(100vh - var(--fazer-ai-offset-bottom, 24px) - 96px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--fazer-ai-bg); color: var(--fazer-ai-text);
  border: 1px solid var(--fazer-ai-border); border-radius: var(--fazer-ai-radius);
  box-shadow: 0 12px 40px rgba(0,0,0,.25);
}
:host([position="bottom-left"]) .panel { right: auto; left: var(--fazer-ai-offset-side, 24px); }
:host([mode="inline"]) .panel {
  position: static; width: 100%; height: 100%; min-height: 360px; box-shadow: none;
  border: 0; border-radius: 0;
}
:host([mode="inline"]) .fab, :host([mode="inline"]) .close { display: none; }
@media (max-width: 640px) {
  :host(:not([mode="inline"])) .panel { inset: 0; width: auto; height: auto; border-radius: 0; }
}
.panel[hidden], .fab[hidden] { display: none; }
@media (max-width: 640px) {
  :host(:not([mode="inline"])) .fab[aria-expanded="true"] { display: none; }
}
header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--fazer-ai-border); }
header h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
.ghost { background: none; border: 0; color: var(--fazer-ai-muted); cursor: pointer; font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 6px; }
.ghost:hover { color: var(--fazer-ai-text); background: var(--fazer-ai-surface); }
.ghost:disabled { opacity: .5; cursor: default; }
.challenge { display: flex; justify-content: center; }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; font-size: 14px; line-height: 1.45; }
.empty { color: var(--fazer-ai-muted); margin: 0; }
.msg { padding: 8px 12px; border-radius: calc(var(--fazer-ai-radius) - 4px); max-width: 88%; overflow-wrap: anywhere; }
.msg p { margin: 0 0 6px; } .msg p:last-child { margin-bottom: 0; }
.msg ul, .msg ol { margin: 4px 0; padding-left: 20px; }
.msg pre { margin: 6px 0; padding: 8px; overflow-x: auto; background: var(--fazer-ai-surface); border-radius: 6px; font-size: 12px; }
.msg code { font-size: .92em; }
.msg a { color: var(--fazer-ai-accent); }
.user { align-self: flex-end; background: var(--fazer-ai-accent); color: var(--fazer-ai-accent-text); white-space: pre-wrap; }
.agent { align-self: flex-start; background: var(--fazer-ai-surface); }
.error { align-self: stretch; color: var(--fazer-ai-error); background: var(--fazer-ai-surface); }
.step, .status { color: var(--fazer-ai-muted); font-size: 12px; margin: 0; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--fazer-ai-border); align-items: flex-end; }
textarea { flex: 1; resize: none; font: inherit; font-size: 14px; line-height: 22px; color: inherit; background: var(--fazer-ai-surface); border: 1px solid var(--fazer-ai-border); border-radius: 8px; padding: 8px 10px; min-height: 40px; max-height: 120px; overflow-y: hidden; }
textarea.scroll { overflow-y: auto; }
textarea::placeholder { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
textarea:focus { outline: 2px solid var(--fazer-ai-accent); outline-offset: -1px; }
.send { border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer; font: inherit; font-size: 14px; background: var(--fazer-ai-accent); color: var(--fazer-ai-accent-text); }
.send:disabled { opacity: .5; cursor: default; }
.icon { flex: none; width: 40px; height: 40px; border: 0; border-radius: 8px; display: grid; place-items: center; cursor: pointer; background: none; color: var(--fazer-ai-muted); }
.icon:hover { color: var(--fazer-ai-text); background: var(--fazer-ai-surface); }
.icon:disabled { opacity: .5; cursor: default; }
.icon.rec-send { background: var(--fazer-ai-accent); color: var(--fazer-ai-accent-text); }
form [hidden] { display: none; }
.rec { flex: 1; display: flex; align-items: center; gap: 8px; min-height: 40px; font-size: 14px; }
.rec .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--fazer-ai-error); animation: fazer-ai-pulse 1.2s ease-in-out infinite; }
.rec[data-state="asking"] .dot, .rec[data-state="transcribing"] .dot { background: var(--fazer-ai-muted); }
.rec .time { font-variant-numeric: tabular-nums; }
.rec .time.ending { color: var(--fazer-ai-error); font-weight: 600; }
.rec .label { flex: 1; min-width: 0; color: var(--fazer-ai-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@keyframes fazer-ai-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .rec .dot { animation: none; } }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.voice-mark { display: inline-flex; vertical-align: -2px; margin-right: 6px; opacity: .85; }
`;

const ICON_CHAT =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_FAB_CLOSE =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_MIC =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>';
const ICON_MIC_MARK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/></svg>';
const ICON_SEND =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>';
const ICON_CLOSE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// A thread waiting for the browser's answers, with the storage key of the owner it belongs to.
interface Suspended {
  thread: string;
  key: string | null;
}

type VoiceState = "idle" | "asking" | "recording" | "transcribing";

// The recording under way: the microphone's stream, whose tracks are stopped whatever ends it.
interface Recording {
  stream: MediaStream;
  recorder: MediaRecorder;
  extension: string;
  chunks: Blob[];
  // Settles on the recorder's `stop`, whoever stopped it: the person, the ceiling, or the browser
  // when the microphone went away.
  stopped: Promise<void>;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  ending: boolean;
  abort?: AbortController;
}

export class FazerAiAgent extends HTMLElement {
  static observedAttributes = ["lang", "token-url", "mode"];

  // An app that already holds the JWT in the browser hands it over here instead of a token-url.
  // Replacing it is a change of identity, as `identityChanged()` describes.
  get tokenProvider(): (() => string | Promise<string>) | undefined {
    return this.#tokenProvider;
  }
  set tokenProvider(provider: (() => string | Promise<string>) | undefined) {
    this.#tokenProvider = provider;
    this.identityChanged();
  }
  // How the agent's navigation reaches the host's router; the default fits most single-page apps.
  navigate: (path: string) => void = (path) => {
    history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  get texts(): Partial<AgentTexts> {
    return this.#texts;
  }
  set texts(value: Partial<AgentTexts>) {
    this.#texts = value;
    if (this.#els) this.#paint();
  }

  #tools = new Map<string, AgentTool>();
  #context: Json | (() => Json) | null = null;
  #tokenProvider?: () => string | Promise<string>;
  #texts: Partial<AgentTexts> = {};
  // The anonymous session's credential, held here as well as in storage, so a browser that denies
  // storage still renews the same session while the page is open.
  #anonSession: string | undefined;
  #token: string | null = null;
  // Bumped on every change of identity, so a turn started for the previous user stops writing.
  #identity = 0;
  // The user the conversation on screen belongs to (the token's `sub`), its thread, and a "New
  // conversation" pressed before any token said whose stored thread to forget.
  #owner: string | null = null;
  #threadId: string | undefined;
  // The identity whose token the panel is asking for to show the earlier conversation.
  #restoring: number | undefined;
  // The token being asked for, so two callers ask once.
  #asking:
    | { identity: number; quiet: boolean; token: Promise<string> }
    | undefined;
  #resetPending = false;
  // Whether a handed-over conversation may become the open one: "New conversation" turns it off
  // until the next change of identity, so no hand-over (a late one, or a retry) reopens what the
  // person set aside.
  #adoptHandOver = true;
  // Ends the Turnstile challenge on screen, if any: a change of identity takes it down at once.
  #cancelChallenge: ((reason?: Error) => void) | null = null;
  // Bumped when what asked for a challenge no longer wants it (a cancelled voice message), so a
  // token request it started never shows one, wherever that request was.
  #challengeEpoch = 0;
  #messages: Message[] = [];
  // Where the open thread's messages start on screen: what came before belongs to a thread that was
  // dropped, and is not kept for it.
  #logFrom = 0;
  #busy = false;
  #open = false;
  #voice: VoiceState = "idle";
  #recording: Recording | null = null;
  // Bumped whenever a recording is cancelled, so what was waiting on it (the microphone's answer,
  // the recorder's stop, the transcription) does nothing when it arrives.
  #voiceRun = 0;
  #root: ShadowRoot;
  #els: {
    fab: HTMLButtonElement;
    panel: HTMLElement;
    title: HTMLElement;
    reset: HTMLButtonElement;
    close: HTMLButtonElement;
    log: HTMLElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    mic: HTMLButtonElement;
    rec: HTMLElement;
    recCancel: HTMLButtonElement;
    recSend: HTMLButtonElement;
    recTime: HTMLElement;
    recLabel: HTMLElement;
    voiceStatus: HTMLElement;
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    this.#root.innerHTML = `<style>${STYLE}</style>
<button class="fab" type="button" aria-controls="panel" aria-expanded="false">${ICON_CHAT}</button>
<section class="panel" id="panel" hidden role="dialog">
  <header><h2></h2><button class="ghost reset" type="button"></button><button class="ghost close" type="button">${ICON_CLOSE}</button></header>
  <div class="log" aria-live="polite"></div>
  <div class="challenge"><slot name="challenge"></slot></div>
  <form>
    <div class="rec" hidden><button class="icon rec-cancel" type="button">${ICON_CLOSE}</button><span class="dot" aria-hidden="true"></span><span class="time" role="timer">00:00</span><span class="label"></span><button class="icon rec-send" type="button">${ICON_SEND}</button></div>
    <textarea rows="1"></textarea><button class="icon mic" type="button" hidden>${ICON_MIC}</button><button class="send" type="submit"></button>
    <span class="sr voice-status" aria-live="polite"></span>
  </form>
</section>`;
    const q = <T extends Element>(s: string) =>
      this.#root.querySelector(s) as T;
    this.#els = {
      fab: q(".fab"),
      panel: q(".panel"),
      title: q("h2"),
      reset: q(".reset"),
      close: q(".close"),
      log: q(".log"),
      input: q("textarea"),
      send: q(".send"),
      mic: q(".mic"),
      rec: q(".rec"),
      recCancel: q(".rec-cancel"),
      recSend: q(".rec-send"),
      recTime: q(".rec .time"),
      recLabel: q(".rec .label"),
      voiceStatus: q(".voice-status"),
    };
    this.#els.fab.addEventListener("click", () =>
      this.#open ? this.close() : this.open(),
    );
    this.#els.mic.addEventListener("click", () => void this.#startVoice());
    this.#els.recCancel.addEventListener("click", () => this.#cancelVoice());
    this.#els.recSend.addEventListener("click", () => void this.#finishVoice());
    this.#els.panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || this.#voice === "idle") return;
      e.preventDefault();
      e.stopPropagation();
      this.#cancelVoice();
    });
    this.#els.close.addEventListener("click", () => this.close());
    this.#els.reset.addEventListener("click", () => this.reset());
    this.#els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.#submit();
      }
    });
    this.#els.input.addEventListener("input", () => {
      this.#fitInput();
      this.#syncSend();
    });
    q<HTMLFormElement>("form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.#submit();
    });
  }

  connectedCallback() {
    if (this.getAttribute("mode") === "inline") this.#open = true;
    this.#paint();
    this.#restore();
  }

  disconnectedCallback() {
    this.#cancelVoice();
  }

  attributeChangedCallback(
    name: string,
    old: string | null,
    value: string | null,
  ) {
    // NOTE: absent is a way of signing in too (an anonymous session), so adding the URL changes who
    // the widget speaks for as much as replacing it does.
    if (name === "token-url" && old !== value) this.identityChanged();
    if (name === "mode") this.#open = value === "inline";
    this.#paint();
    if (this.isConnected) this.#restore();
  }

  tool(def: AgentTool): void {
    if (def.name === HIGHLIGHT_TOOL)
      throw new Error(`${HIGHLIGHT_TOOL} is built in`);
    this.#tools.set(def.name, def);
  }

  untool(name: string): void {
    this.#tools.delete(name);
  }

  context(value: Json | (() => Json) | null): void {
    this.#context = value;
  }

  open(): void {
    this.#open = true;
    this.#paint();
    this.#els.input.focus();
    this.#restore();
  }

  close(): void {
    if (this.getAttribute("mode") === "inline") return;
    this.#open = false;
    this.#paint();
  }

  // The host signed another user in, or into another scope, without reloading the page. The cached
  // token is dropped and the conversation on screen with it; the next message fetches a token and
  // resumes whatever that user has stored.
  identityChanged(): void {
    this.#identity++;
    this.#cancelVoice();
    this.#cancelChallenge?.();
    this.#adoptHandOver = true;
    this.#token = null;
    this.#owner = null;
    this.#threadId = undefined;
    this.#resetPending = false;
    this.#messages = [];
    this.#logFrom = 0;
    this.#busy = false;
    if (this.#els) {
      this.#els.input.value = "";
      this.#fitInput();
      this.#syncSend();
      this.#renderLog();
    }
    if (this.isConnected) this.#restore();
  }

  // The panel on screen shows the conversation the user had before the page reloaded, which needs to
  // know who the user is: the token is asked for now rather than at the first message. Quietly: an
  // anonymous visitor's is asked only for a session this browser already holds, never a new one nor
  // a challenge, and a failure leaves the panel as it was.
  #restore(): void {
    if (!this.#open || this.#token || this.#busy || !this.getAttribute("app"))
      return;
    if (this.#restoring === this.#identity) return;
    const identity = this.#identity;
    this.#restoring = identity;
    this.#getToken(false, true)
      .catch(() => {})
      .finally(() => {
        if (this.#restoring === identity) this.#restoring = undefined;
      });
  }

  reset(): void {
    if (this.#busy) return;
    this.#adoptHandOver = false;
    this.#threadId = undefined;
    const key = this.#threadKey();
    if (key) {
      safeStorage(() => localStorage.removeItem(key));
      safeStorage(() => localStorage.removeItem(`${key}#log`));
    } else this.#resetPending = true;
    this.#messages = [];
    this.#logFrom = 0;
    this.#renderLog();
  }

  #t(): AgentTexts {
    const lang = (
      this.getAttribute("lang") ||
      navigator.language ||
      "en"
    ).toLowerCase();
    return { ...TEXTS[lang.startsWith("pt") ? "pt" : "en"], ...this.#texts };
  }

  #paint(): void {
    // NOTE: a microphone left recording behind a hidden panel is one the person cannot see, however
    // the panel came to be hidden (`close()`, leaving inline mode).
    if (!this.#open) this.#cancelVoice();
    const t = this.#t();
    const fab = this.#els.fab;
    fab.setAttribute("aria-label", this.#open ? t.close : t.open);
    fab.setAttribute("aria-expanded", String(this.#open));
    if (fab.dataset.icon !== String(this.#open)) {
      fab.dataset.icon = String(this.#open);
      fab.innerHTML = this.#open ? ICON_FAB_CLOSE : ICON_CHAT;
    }
    this.#els.panel.hidden = !this.#open;
    this.#els.panel.setAttribute("aria-label", t.title);
    this.#els.title.textContent = t.title;
    this.#els.reset.textContent = t.reset;
    this.#els.close.setAttribute("aria-label", t.close);
    this.#els.input.placeholder = t.placeholder;
    this.#els.input.setAttribute("aria-label", t.placeholder);
    this.#els.send.textContent = t.send;
    this.#els.mic.setAttribute("aria-label", t.record);
    this.#els.recCancel.setAttribute("aria-label", t.cancelRecording);
    this.#els.recSend.setAttribute("aria-label", t.sendRecording);
    this.#paintVoice();
    this.#syncSend();
    this.#renderLog();
  }

  #syncSend(): void {
    this.#els.send.disabled = this.#busy || !this.#els.input.value.trim();
    this.#els.mic.disabled = this.#busy;
    this.#els.reset.disabled = this.#busy || this.#voice !== "idle";
  }

  // The textarea as tall as what is typed, up to `INPUT_MAX_PX`; past it, it scrolls. The borders
  // are added back, since `scrollHeight` leaves them out of a border-box height.
  // NOTE: Chrome counts a wrapped placeholder in `scrollHeight`, so a host's long placeholder on a
  // narrow panel would open the empty box two lines tall. The placeholder stays on one line instead.
  #fitInput(): void {
    const el = this.#els.input;
    el.style.height = "auto";
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = full > 0 ? `${Math.min(full, INPUT_MAX_PX)}px` : "";
    el.classList.toggle("scroll", full > INPUT_MAX_PX);
  }

  // The form while a voice message is under way: the recording bar in place of the textarea.
  #paintVoice(): void {
    const t = this.#t();
    const voice = this.#voice;
    const idle = voice === "idle";
    this.#els.rec.hidden = idle;
    this.#els.rec.dataset.state = voice;
    this.#els.input.hidden = !idle;
    this.#els.send.hidden = !idle;
    this.#els.mic.hidden = !idle || !voiceSupported();
    this.#els.recSend.hidden = voice !== "recording";
    this.#els.recTime.hidden = voice !== "recording";
    const ending = this.#recording?.ending === true;
    this.#els.recTime.classList.toggle("ending", ending);
    const label =
      voice === "asking"
        ? t.requestingMic
        : voice === "transcribing"
          ? t.transcribing
          : voice === "recording"
            ? ending
              ? t.recordingEnding
              : t.recording
            : "";
    this.#els.recLabel.textContent = label;
    if (this.#els.voiceStatus.textContent !== label)
      this.#els.voiceStatus.textContent = label;
    this.#syncSend();
  }

  async #startVoice(): Promise<void> {
    if (this.#voice !== "idle" || this.#busy || !voiceSupported()) return;
    const t = this.#t();
    const run = ++this.#voiceRun;
    this.#voice = "asking";
    this.#paintVoice();
    this.#els.recCancel.focus();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (run !== this.#voiceRun) return;
      this.#endVoice();
      this.#push({ kind: "error", text: micRefusal(e, t) });
      return;
    }
    // NOTE: cancelled while the browser asked: the microphone it just opened is closed at once.
    if (run !== this.#voiceRun) {
      stopTracks(stream);
      return;
    }
    const [mimeType, extension] = RECORDING_TYPES.find(([type]) =>
      MediaRecorder.isTypeSupported?.(type),
    ) ?? ["", "webm"];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32_000,
      });
    } catch {
      stopTracks(stream);
      this.#endVoice();
      this.#push({ kind: "error", text: t.voiceFailed });
      return;
    }
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    const stopped = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true }),
    );
    const rec: Recording = {
      stream,
      recorder,
      extension,
      chunks,
      stopped,
      startedAt: Date.now(),
      timer: setInterval(() => this.#tick(), 250),
      ending: false,
    };
    this.#recording = rec;
    // NOTE: a recorder that stops on its own (its tracks ended) sends what it has, as Send would;
    // one that fails is a recording lost.
    recorder.addEventListener("stop", () => {
      if (this.#recording === rec) void this.#finishVoice();
    });
    recorder.addEventListener("error", () => {
      if (this.#recording !== rec) return;
      this.#cancelVoice();
      this.#push({ kind: "error", text: t.voiceFailed });
    });
    try {
      recorder.start(1000);
    } catch {
      this.#cancelVoice();
      this.#push({ kind: "error", text: t.voiceFailed });
      return;
    }
    this.#voice = "recording";
    this.#els.recTime.textContent = clock(0);
    this.#paintVoice();
    this.#els.recSend.focus();
  }

  #tick(): void {
    const rec = this.#recording;
    if (!rec || this.#voice !== "recording") return;
    const elapsed = Date.now() - rec.startedAt;
    this.#els.recTime.textContent = clock(Math.min(elapsed, RECORDING_MAX_MS));
    if (elapsed >= RECORDING_MAX_MS) {
      void this.#finishVoice();
      return;
    }
    if (!rec.ending && elapsed >= RECORDING_MAX_MS - RECORDING_WARN_MS) {
      rec.ending = true;
      this.#paintVoice();
    }
  }

  // Stops the recording and sends it: the transcription comes back as the person's message, which
  // then runs as any typed one does.
  async #finishVoice(): Promise<void> {
    const rec = this.#recording;
    if (!rec || this.#voice !== "recording") return;
    const t = this.#t();
    const run = this.#voiceRun;
    const identity = this.#identity;
    clearInterval(rec.timer);
    const duration = Date.now() - rec.startedAt;
    this.#voice = "transcribing";
    if (rec.recorder.state !== "inactive") rec.recorder.stop();
    stopTracks(rec.stream);
    this.#paintVoice();
    this.#els.recCancel.focus();
    await rec.stopped;
    if (run !== this.#voiceRun) return;
    const audio = new Blob(rec.chunks, {
      type: rec.recorder.mimeType || rec.chunks[0]?.type || "audio/webm",
    });
    if (duration < RECORDING_MIN_MS || audio.size === 0) {
      this.#endVoice();
      this.#push({ kind: "error", text: t.voiceTooShort });
      return;
    }
    rec.abort = new AbortController();
    let heard: { text: string } | { error: string };
    try {
      heard = await this.#transcribe(
        audio,
        rec.extension,
        identity,
        rec.abort.signal,
        this.#challengeEpoch,
      );
    } catch {
      heard = { error: t.voiceFailed };
    }
    if (run !== this.#voiceRun || identity !== this.#identity) return;
    this.#endVoice();
    if ("error" in heard) {
      if (heard.error) this.#push({ kind: "error", text: heard.error });
      return;
    }
    const text = heard.text.trim();
    if (!text) {
      this.#push({ kind: "error", text: t.voiceEmpty });
      return;
    }
    void this.#converse(text, true);
  }

  // Ends whatever part of a voice message is under way, without sending it: the microphone is
  // released and a transcription on the way is dropped.
  #cancelVoice(): void {
    if (this.#voice === "idle") return;
    this.#voiceRun++;
    // NOTE: nothing but the voice message can be asking for a challenge now (no turn runs beside it,
    // and the panel's own ask never shows one), so its challenge goes with it, and the next message
    // asks for its own.
    this.#challengeEpoch++;
    this.#cancelChallenge?.(new ChallengeCancelled());
    const rec = this.#recording;
    // NOTE: ended before the recorder is stopped, so its `stop` finds no recording to send.
    this.#endVoice();
    if (rec) {
      clearInterval(rec.timer);
      rec.abort?.abort();
      if (rec.recorder.state !== "inactive") rec.recorder.stop();
      stopTracks(rec.stream);
    }
  }

  #endVoice(): void {
    const wasFocused = this.#root.activeElement !== null;
    this.#recording = null;
    this.#voice = "idle";
    if (!this.#els) return;
    this.#paintVoice();
    if (wasFocused && this.#open) this.#els.input.focus();
  }

  // The recording's transcription by the app's agent. A 401 renews the token once, as the turn does;
  // each refusal the page can do something about has its own text.
  async #transcribe(
    audio: Blob,
    extension: string,
    identity: number,
    signal: AbortSignal,
    epoch: number,
    renewed = false,
  ): Promise<{ text: string } | { error: string }> {
    const t = this.#t();
    let token: string;
    try {
      token = await this.#getToken(renewed, false, epoch);
    } catch {
      return { error: identity === this.#identity ? t.signInFailed : "" };
    }
    if (identity !== this.#identity) return { error: "" };
    const form = new FormData();
    form.append(
      "audio",
      new File([audio], `voice.${extension}`, { type: audio.type }),
    );
    const res = await fetch(
      `${this.#instance()}/api/v1/sdk/${encodeURIComponent(this.getAttribute("app") ?? "")}/transcribe`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "accept-language":
            this.getAttribute("lang") || navigator.language || "en",
        },
        body: form,
        signal,
      },
    );
    if (res.status === 401 && !renewed && identity === this.#identity)
      return this.#transcribe(audio, extension, identity, signal, epoch, true);
    const body = (await res.json().catch(() => null)) as {
      text?: unknown;
      error?: string;
    } | null;
    if (res.ok)
      return typeof body?.text === "string"
        ? { text: body.text }
        : { error: t.voiceFailed };
    // NOTE: a 400 is the agent's speech-to-text, off or without a usable credential; the body's
    // shape was the widget's own, so it is never the cause.
    if (res.status === 400 || res.status === 404)
      return { error: t.voiceUnavailable };
    if (res.status === 413) return { error: t.voiceTooLong };
    if (res.status === 429) return { error: body?.error || t.voiceFailed };
    return { error: t.voiceFailed };
  }

  #renderLog(): void {
    const t = this.#t();
    const log = this.#els.log;
    log.replaceChildren();
    if (!this.#messages.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = t.empty;
      log.appendChild(p);
    }
    for (const m of this.#messages) {
      if (m.kind === "step") {
        const p = document.createElement("p");
        p.className = "step";
        p.textContent = `${m.ok === undefined ? "…" : m.ok ? "✓" : "✗"} ${m.name}`;
        log.appendChild(p);
        continue;
      }
      const div = document.createElement("div");
      div.className = `msg ${m.kind}`;
      if (m.kind === "agent") div.appendChild(renderMarkdown(document, m.text));
      else if (m.kind === "user" && m.voice) {
        const mark = document.createElement("span");
        mark.className = "voice-mark";
        mark.setAttribute("role", "img");
        mark.setAttribute("aria-label", t.voiceMark);
        mark.innerHTML = ICON_MIC_MARK;
        div.append(mark, document.createTextNode(m.text));
      } else div.textContent = m.text;
      log.appendChild(div);
    }
    if (this.#busy) {
      const p = document.createElement("p");
      p.className = "status";
      p.setAttribute("role", "status");
      p.textContent = t.thinking;
      log.appendChild(p);
    }
    log.scrollTop = log.scrollHeight;
  }

  #push(...m: Message[]): void {
    this.#messages.push(...m);
    this.#renderLog();
  }

  #submit(): void {
    const text = this.#els.input.value.trim();
    if (!text || this.#busy) return;
    this.#els.input.value = "";
    this.#fitInput();
    void this.#converse(text);
  }

  #instance(): string {
    return (this.getAttribute("instance") || SCRIPT_ORIGIN).replace(/\/+$/, "");
  }

  // `epoch` is the challenge epoch the caller asks under: a voice message passes the one it started
  // with, so nothing asked on its behalf after it was cancelled shows a challenge.
  async #getToken(
    force = false,
    quiet = false,
    epoch = this.#challengeEpoch,
  ): Promise<string> {
    const asking = this.#asking;
    // NOTE: a message sent while the panel is still asking for the token to restore the conversation
    // waits for that one instead of asking again, and before the token it may already hold: the ask
    // ends after the anonymous hand-over, which decides the thread the message continues. One that
    // stopped only for being quiet is asked loudly, and one whose challenge a cancelled voice message
    // took down is asked again.
    if (!force && asking?.identity === this.#identity) {
      try {
        return await asking.token;
      } catch (e) {
        if (
          !(e instanceof QuietStop || e instanceof ChallengeCancelled) ||
          quiet
        )
          throw e;
        // NOTE: a caller cancelled while it waited asks nothing more.
        if (epoch !== this.#challengeEpoch) throw new ChallengeCancelled();
      }
    }
    if (
      !force &&
      this.#token &&
      stillFresh(readClaims(this.#token), Date.now())
    )
      return this.#token;
    const token = this.#askToken(quiet, epoch);
    const entry = { identity: this.#identity, quiet, token };
    this.#asking = entry;
    token
      .catch(() => {})
      .finally(() => {
        if (this.#asking === entry) this.#asking = undefined;
      });
    return await token;
  }

  async #askToken(quiet: boolean, epoch: number): Promise<string> {
    const identity = this.#identity;
    let token: string;
    let signedIn = true;
    if (this.#tokenProvider) token = await this.#tokenProvider();
    else {
      const url = this.getAttribute("token-url");
      if (url) {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`token-url answered ${res.status}`);
        token = await tokenFromResponse(res);
      } else {
        token = await this.#anonymousToken(quiet, epoch);
        signedIn = false;
      }
    }
    // NOTE: a token asked for the previous identity is not kept for the new one.
    if (identity !== this.#identity)
      throw new Error("fazer-ai-agent: identity changed");
    this.#token = token;
    this.#bindOwner();
    if (signedIn) await this.#handOverAnonymous(token, identity);
    return token;
  }

  #sessionKey(): string {
    return `fazer-ai-agent:${this.getAttribute("app") ?? ""}#session`;
  }

  // A visitor who talked anonymously and is now signed in takes the conversations along, once: the
  // instance moves the session's threads to the signed-in user, and the credential is forgotten. The
  // newest becomes the open conversation when there is none. A failure keeps the credential for the
  // next token, and never stops the turn.
  async #handOverAnonymous(token: string, identity: number): Promise<void> {
    const key = this.#sessionKey();
    const session =
      this.#anonSession ?? safeStorage(() => localStorage.getItem(key));
    if (!session) return;
    try {
      const res = await fetch(
        `${this.#instance()}/api/v1/sdk/${encodeURIComponent(this.getAttribute("app") ?? "")}/session/claim`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ session }),
        },
      );
      if (!res.ok || identity !== this.#identity) return;
      const { threadIds } = (await res.json()) as { threadIds: string[] };
      if (identity !== this.#identity) return;
      this.#anonSession = undefined;
      safeStorage(() => localStorage.removeItem(key));
      const newest = threadIds[0];
      if (
        newest !== undefined &&
        this.#threadId === undefined &&
        this.#adoptHandOver
      ) {
        this.#threadId = newest;
        const threadKey = this.#threadKey();
        if (threadKey)
          safeStorage(() => localStorage.setItem(threadKey, newest));
        this.#adoptLog(newest);
      }
    } catch {
      // NOTE: the hand-over is a convenience; the signed-in turn goes on without it.
    }
  }

  // With no way to sign a user in, the instance's anonymous session for this browser: its credential
  // stays in storage, so the same browser resumes the same session and conversation.
  async #anonymousToken(
    quiet = false,
    epoch = this.#challengeEpoch,
  ): Promise<string> {
    const app = this.getAttribute("app") ?? "";
    const key = this.#sessionKey();
    const identity = this.#identity;
    const held =
      this.#anonSession ??
      safeStorage(() => localStorage.getItem(key)) ??
      undefined;
    if (quiet && held === undefined) throw new QuietStop();
    // A quiet ask only renews: a session the instance no longer knows is not replaced by a new
    // one, which would spend the address's allowance on a panel merely opened.
    const ask = (session: string | undefined, turnstile?: string) =>
      fetch(
        `${this.#instance()}/api/v1/sdk/${encodeURIComponent(app)}/session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            quiet ? { session, renew: true } : { session, turnstile },
          ),
        },
      );
    // A new session behind the app's human check needs a solved challenge. One the instance no
    // longer recognizes becomes a new session too, so its refusal (named by the `turnstile` field)
    // asks for the challenge and the session once more; so does a challenge that expired on the way.
    const siteKey = this.getAttribute("turnstile-site-key");
    let res = await ask(
      held,
      held === undefined && siteKey
        ? await this.#challenge(siteKey, identity, epoch)
        : undefined,
    );
    if (
      res.status === 403 &&
      siteKey &&
      (await refusedField(res.clone())) === "turnstile"
    ) {
      // NOTE: a credential the instance refused is dead; forgotten, so the next attempt (this retry,
      // or a later one if it fails) solves the challenge first instead of probing with it again.
      if (held !== undefined && identity === this.#identity) {
        this.#anonSession = undefined;
        safeStorage(() => localStorage.removeItem(key));
      }
      if (quiet) throw new QuietStop();
      res = await ask(
        undefined,
        await this.#challenge(siteKey, identity, epoch),
      );
    }
    if (quiet && res.status === 404) throw new QuietStop();
    if (!res.ok) throw new Error(`the instance answered ${res.status}`);
    const { session, token } = (await res.json()) as {
      session: string;
      token: string;
    };
    // NOTE: a session asked for before a change of identity may answer after a newer one; keeping it
    // would put the browser back on the older session at the next renewal or reload.
    if (identity !== this.#identity)
      throw new Error("fazer-ai-agent: identity changed");
    this.#anonSession = session;
    if (session !== held) safeStorage(() => localStorage.setItem(key, session));
    return token;
  }

  // Shows the app's Turnstile challenge in the panel, projected from the host's own DOM (Cloudflare's
  // widget renders into the page, not into a shadow root), and answers its token once solved.
  // `epoch` is the one the token request that needs the challenge started under: a voice message
  // cancelled at any point of that request shows none.
  async #challenge(
    siteKey: string,
    identity: number,
    epoch: number,
  ): Promise<string> {
    if (epoch !== this.#challengeEpoch) throw new ChallengeCancelled();
    const turnstile = await loadTurnstile();
    if (identity !== this.#identity)
      throw new Error("fazer-ai-agent: identity changed");
    if (epoch !== this.#challengeEpoch) throw new ChallengeCancelled();
    const host = document.createElement("div");
    host.slot = "challenge";
    this.appendChild(host);
    let id: string | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        const failed = () =>
          reject(new Error("fazer-ai-agent: the human check did not pass"));
        // NOTE: a challenge solved for the previous identity would still open an anonymous session.
        this.#cancelChallenge = (
          reason = new Error("fazer-ai-agent: identity changed"),
        ) => reject(reason);
        id = turnstile.render(host, {
          sitekey: siteKey,
          callback: resolve,
          "error-callback": failed,
          "expired-callback": failed,
          "timeout-callback": failed,
        });
      });
    } finally {
      this.#cancelChallenge = null;
      if (id !== undefined) turnstile.remove(id);
      host.remove();
    }
  }

  // Follows the token's owner. A different user (a renewal can return one) gets their own stored
  // thread and none of the previous user's messages, except the question being asked now.
  #bindOwner(): void {
    const claims = this.#token ? readClaims(this.#token) : {};
    // The user and the scope together, as the instance binds a thread to both: one person in two
    // organizations has two conversations.
    const sub = claims.sub
      ? claims.scope === undefined
        ? encodeURIComponent(claims.sub)
        : `${encodeURIComponent(claims.sub)}:${encodeURIComponent(claims.scope)}`
      : null;
    if (sub === this.#owner) return;
    if (this.#owner !== null) {
      const asking = this.#busy
        ? this.#messages.filter((m) => m.kind === "user").slice(-1)
        : [];
      this.#messages = asking;
      this.#logFrom = 0;
      // NOTE: a reset was the previous owner's; one pressed before any token said whose stays.
      this.#adoptHandOver = true;
      this.#els.input.value = "";
      this.#syncSend();
      this.#renderLog();
    }
    this.#owner = sub;
    this.#threadId = undefined;
    const key = this.#threadKey();
    if (!key) return;
    if (this.#resetPending) {
      this.#resetPending = false;
      safeStorage(() => localStorage.removeItem(key));
      safeStorage(() => localStorage.removeItem(`${key}#log`));
      return;
    }
    this.#threadId = safeStorage(() => localStorage.getItem(key)) ?? undefined;
    const earlier = this.#threadId ? readLog(key, this.#threadId) : [];
    if (earlier.length) {
      this.#messages = [...earlier, ...this.#messages];
      this.#logFrom = 0;
      this.#renderLog();
    }
  }

  // The log of a thread the instance just handed over to this user, kept under the anonymous owner
  // it had: shown ahead of what is on screen and moved under this owner. Found by the thread, whose
  // id only its owner's browser holds and which the instance has just made this user's.
  #adoptLog(thread: string): void {
    const key = this.#threadKey();
    const prefix = `fazer-ai-agent:${this.getAttribute("app") ?? ""}:`;
    if (!key) return;
    const keys =
      safeStorage(() =>
        Array.from({ length: localStorage.length }, (_, i) =>
          localStorage.key(i),
        ),
      ) ?? [];
    for (const k of keys) {
      if (!k?.startsWith(prefix) || !k.endsWith("#log")) continue;
      const owner = k.replace(/#log$/, "");
      if (owner === key) continue;
      const earlier = readLog(owner, thread);
      if (!earlier.length) continue;
      safeStorage(() => localStorage.removeItem(k));
      this.#messages = [...earlier, ...this.#messages];
      this.#logFrom = 0;
      this.#saveLog();
      this.#renderLog();
      return;
    }
  }

  // What is shown again after a reload: the user's messages and the replies, for the thread on screen.
  #saveLog(): void {
    const key = this.#threadKey();
    const thread = this.#threadId;
    if (!key || !thread) return;
    const messages = this.#messages
      .slice(Math.max(this.#logFrom, 0))
      .filter((m) => m.kind === "user" || m.kind === "agent")
      .slice(-LOG_MAX);
    safeStorage(() =>
      localStorage.setItem(`${key}#log`, JSON.stringify({ thread, messages })),
    );
  }

  #threadKey(): string | null {
    const app = this.getAttribute("app");
    return app && this.#owner ? `fazer-ai-agent:${app}:${this.#owner}` : null;
  }

  #clientTools(): ClientToolSpec[] {
    const tools: ClientToolSpec[] = [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {} },
    }));
    const targets = highlightTargets();
    if (targets.length)
      tools.push({
        name: HIGHLIGHT_TOOL,
        description:
          "Point the user at an element of the page they are looking at, such as a button they must press themselves. Use it for an action you cannot or must not take for them.",
        parameters: {
          type: "object",
          properties: { target: { type: "string", enum: targets } },
          required: ["target"],
          additionalProperties: false,
        },
      });
    return tools;
  }

  // A floating panel covers the whole page on a phone, so while the highlight shows it steps aside
  // and comes back when the outline is gone.
  #stepAside(): void {
    if (this.getAttribute("mode") === "inline" || !this.#open) return;
    if (!window.matchMedia?.("(max-width: 640px)").matches) return;
    this.close();
    setTimeout(() => {
      if (!this.#open) this.open();
    }, HIGHLIGHT_MS);
  }

  async #runCall(call: ToolCall): Promise<ToolAnswer> {
    try {
      if (call.name === HIGHLIGHT_TOOL) {
        this.#stepAside();
        return { ok: true, result: highlight(String(call.args.target ?? "")) };
      }
      const tool = this.#tools.get(call.name);
      if (!tool) return { ok: false, error: `unknown tool ${call.name}` };
      return { ok: true, result: (await tool.run(call.args ?? {})) ?? null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async #converse(text: string, voice = false): Promise<void> {
    const t = this.#t();
    this.#busy = true;
    this.#push(voice ? { kind: "user", text, voice } : { kind: "user", text });
    this.#syncSend();
    // The thread whose pending calls the next request answers. If that request fails the answers are
    // gone and the thread stays suspended, refusing every new message, so it is abandoned.
    let suspended: Suspended | undefined;
    const identity = this.#identity;
    const stale = () => identity !== this.#identity;
    try {
      try {
        await this.#getToken();
      } catch {
        if (!stale()) this.#push({ kind: "error", text: t.signInFailed });
        return;
      }
      if (stale()) return;
      let body: Json = {
        message: text,
        context:
          typeof this.#context === "function"
            ? this.#context()
            : (this.#context ?? undefined),
      };
      // The tools the last request declared and the names its pending calls used: answering a call
      // re-declares its tool even if the page no longer offers it (a navigation removed the target),
      // since the instance refuses answers for a tool the turn does not declare.
      let declared = new Map<string, ClientToolSpec>();
      let pending: string[] = [];
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const tools = this.#clientTools();
        for (const name of pending) {
          const spec = declared.get(name);
          if (spec && !tools.some((tool) => tool.name === name))
            tools.push(spec);
        }
        const requestKey = this.#threadKey();
        const result = await this.#turn(
          () => ({
            ...body,
            threadId: this.#threadId,
            clientTools: tools,
          }),
          false,
          identity,
        );
        if (!("error" in result))
          suspended =
            result.turn.status === "done"
              ? undefined
              : { thread: result.turn.threadId, key: requestKey };
        if (stale()) return;
        if (result.retryWithoutThread) {
          this.#threadId = undefined;
          // The question is asked again on the new thread; what came before it was the old one's.
          this.#logFrom = this.#messages.findLastIndex(
            (m) => m.kind === "user",
          );
          round--;
          continue;
        }
        if ("error" in result) {
          this.#abandon(suspended);
          this.#push({ kind: "error", text: result.error || t.failed });
          return;
        }
        const turn = result.turn;
        this.#threadId = turn.threadId;
        const key = this.#threadKey();
        if (key) safeStorage(() => localStorage.setItem(key, turn.threadId));
        suspended =
          turn.status === "done" ? undefined : { thread: turn.threadId, key };
        if (turn.status === "done") {
          this.#push({ kind: "agent", text: turn.reply });
          this.#saveLog();
          return;
        }
        // NOTE: no round left to send answers in, so nothing runs: a tool whose result cannot reach
        // the turn would act unrecorded, and the thread, still suspended, is abandoned for a new one.
        if (round === MAX_ROUNDS - 1) {
          this.#abandon(suspended);
          break;
        }
        declared = new Map(tools.map((tool) => [tool.name, tool]));
        pending = turn.calls.map((call) => call.name);
        const answers: Record<string, ToolAnswer> = {};
        for (const call of turn.calls) {
          // Pointing at an element shows on the page itself, so it gets no progress line.
          const step: Message | undefined =
            call.name === HIGHLIGHT_TOOL
              ? undefined
              : {
                  kind: "step",
                  name: this.#tools.get(call.name)?.label || call.name,
                };
          if (step) this.#push(step);
          const answer = await this.#runCall(call);
          answers[call.toolCallId] = answer;
          if (stale()) return;
          if (step?.kind === "step") {
            step.ok = answer.ok;
            this.#renderLog();
          }
        }
        body = { answers };
      }
      this.#push({ kind: "error", text: t.tooManySteps });
    } catch {
      if (stale()) return;
      this.#abandon(suspended);
      this.#push({ kind: "error", text: t.failed });
    } finally {
      if (stale()) this.#abandon(suspended);
      else this.#busy = false;
      this.#syncSend();
      this.#renderLog();
    }
  }

  // Forgets a suspended thread under the key of the owner it was suspended for, which a renewal may
  // have replaced on screen by another user's thread; that one is left alone.
  #abandon(suspended: Suspended | undefined): void {
    if (!suspended) return;
    const { thread, key } = suspended;
    if (this.#threadId === thread) {
      this.#threadId = undefined;
      this.#logFrom = this.#messages.length;
    }
    if (key && safeStorage(() => localStorage.getItem(key)) === thread)
      safeStorage(() => localStorage.removeItem(key));
    if (key && readLog(key, thread).length)
      safeStorage(() => localStorage.removeItem(`${key}#log`));
  }

  // One request of a turn. A 401 renews the token once and rebuilds the body, since the renewed token
  // may name another user with another thread; a 404 on a resumed thread (another user's, or one the
  // instance no longer has) asks the caller to start a new one.
  async #turn(
    build: () => Json,
    renewed = false,
    identity = this.#identity,
  ): Promise<
    | { turn: TurnResult; retryWithoutThread?: false }
    | { error: string; retryWithoutThread?: boolean }
  > {
    const before = this.#owner;
    const authorization = `Bearer ${await this.#getToken()}`;
    // NOTE: even a cached token is awaited, and the identity can change in that gap; posting now
    // would send the previous user's message, and its tools would run, before any later check.
    if (identity !== this.#identity) return { error: "" };
    const body = build();
    // NOTE: a token renewed on the way here (near its expiry) may name another user, and answers
    // belong to the previous user's suspended turn.
    if (before !== null && this.#owner !== before && body.answers !== undefined)
      return { error: "" };
    const res = await fetch(
      `${this.#instance()}/api/v1/sdk/${encodeURIComponent(this.getAttribute("app") ?? "")}/turn`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          accept: "text/event-stream",
          "accept-language":
            this.getAttribute("lang") || navigator.language || "en",
        },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 401 && !renewed) {
      // NOTE: the identity may have changed while the request was out; renewing now would fetch the
      // new user's token and send the previous user's message under it.
      if (identity !== this.#identity) return { error: "" };
      const owner = this.#owner;
      await this.#getToken(true);
      // NOTE: answers belong to the previous user's suspended turn; the new user's thread has
      // nothing waiting for them, so the turn stops instead of sending them there.
      if (this.#owner !== owner && body.answers !== undefined)
        return { error: "" };
      return this.#turn(build, true, identity);
    }
    if (unusableThread(res.status, body, false))
      return { error: "", retryWithoutThread: true };
    if (
      !res.headers.get("content-type")?.includes("text/event-stream") ||
      !res.body
    ) {
      const parsed = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (res.ok && parsed && "status" in parsed)
        return { turn: parsed as unknown as TurnResult };
      return { error: parsed?.error ?? "" };
    }
    for await (const ev of readSse(res.body)) {
      if (ev.event === "tool") {
        const step = JSON.parse(ev.data) as {
          phase: string;
          name: string;
          ok?: boolean;
        };
        if (identity !== this.#identity) continue;
        if (step.phase === "start")
          this.#push({ kind: "step", name: step.name });
        else {
          const open = [...this.#messages]
            .reverse()
            .find(
              (m) =>
                m.kind === "step" && m.name === step.name && m.ok === undefined,
            );
          if (open && open.kind === "step") open.ok = step.ok ?? true;
          this.#renderLog();
        }
      } else if (ev.event === "pending" || ev.event === "done") {
        return { turn: JSON.parse(ev.data) as TurnResult };
      } else if (ev.event === "error") {
        const refusal = JSON.parse(ev.data) as {
          status?: number;
          error?: string;
        };
        // NOTE: a refusal raised after the first heartbeat arrives here instead of as an HTTP
        // status, so a stale resumed thread is recovered from here too.
        if (
          refusal.status !== undefined &&
          unusableThread(refusal.status, body, true)
        )
          return { error: "", retryWithoutThread: true };
        return { error: refusal.error ?? "" };
      }
    }
    return { error: "" };
  }
}

// A new message on a resumed thread the instance cannot continue: `404` when it is not this user's
// or no longer exists, `409` when it is suspended on calls nobody will answer (the page that ran them
// reloaded) or another tab is running on it. Each is recovered by starting a new thread. A `409` only
// as the HTTP status, refused before any work: inside the stream it is a turn that lost its claim
// after its tools may have written, and sending the message again would repeat them.
function unusableThread(
  status: number,
  body: Json,
  streamed: boolean,
): boolean {
  return (
    (status === 404 || (status === 409 && !streamed)) &&
    body.threadId !== undefined &&
    body.message !== undefined
  );
}

// The input a refusal names (`field`), or null when it names none or is not JSON.
async function refusedField(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as Json;
    return typeof body.field === "string" ? body.field : null;
  } catch {
    return null;
  }
}

function voiceSupported(): boolean {
  return (
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

// mm:ss of a recording's length.
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Why the browser gave no microphone: the person (or the page's policy) said no, or there is none
// it can use.
function micRefusal(e: unknown, t: AgentTexts): string {
  const name = e instanceof Error ? e.name : "";
  return name === "NotAllowedError" || name === "SecurityError"
    ? t.micDenied
    : t.micMissing;
}

// A quiet ask for the token stopped where only a loud one goes on: no session to resume, or a
// challenge to show.
class QuietStop extends Error {}

// A token request whose challenge a cancelled voice message took down: a message that was waiting
// on that request asks for its own.
class ChallengeCancelled extends Error {}

// The stored conversation of an owner, when it is of this thread; anything else reads as none.
function readLog(key: string, thread: string): Message[] {
  const raw = safeStorage(() => localStorage.getItem(`${key}#log`));
  if (!raw) return [];
  try {
    const log = JSON.parse(raw) as { thread?: unknown; messages?: unknown };
    if (log.thread !== thread || !Array.isArray(log.messages)) return [];
    return log.messages.filter(
      (m): m is Message =>
        (m?.kind === "user" || m?.kind === "agent") &&
        typeof m.text === "string",
    );
  } catch {
    return [];
  }
}

function safeStorage<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

export function highlightTargets(root: ParentNode = document): string[] {
  const names = new Set<string>();
  for (const el of root.querySelectorAll(`[${TARGET_ATTR}]`)) {
    const name = el.getAttribute(TARGET_ATTR);
    if (name) names.add(name);
  }
  return [...names];
}

// Outlines the named element in the host's page for a few seconds. The outline is a fixed box over
// the element's rectangle rather than a style on the element, so the host's own styles are untouched.
export function highlight(
  target: string,
  root: Document = document,
): { shown: string } | { shown: null; reason: string } {
  const el = root.querySelector(`[${TARGET_ATTR}="${CSS.escape(target)}"]`);
  if (!(el instanceof HTMLElement))
    return { shown: null, reason: "not on this page" };
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const box = root.createElement("div");
  box.setAttribute("data-fazer-ai-highlight", target);
  // Re-measured every frame while it shows: the smooth scroll above is still moving the element.
  const place = () => {
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${rect.left - 6}px`,
      top: `${rect.top - 6}px`,
      width: `${rect.width + 12}px`,
      height: `${rect.height + 12}px`,
    });
  };
  Object.assign(box.style, {
    position: "fixed",
    border: "3px solid #4f46e5",
    borderRadius: "10px",
    boxShadow: "0 0 0 9999px rgba(0,0,0,.18)",
    pointerEvents: "none",
    zIndex: "2147482999",
    transition: "opacity .3s",
  });
  place();
  root.body.appendChild(box);
  const follow = () => {
    if (!box.isConnected) return;
    place();
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
  setTimeout(() => box.remove(), HIGHLIGHT_MS);
  return { shown: target };
}

if (!customElements.get("fazer-ai-agent"))
  customElements.define("fazer-ai-agent", FazerAiAgent);
