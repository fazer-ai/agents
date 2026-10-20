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

// A destination the agent can take the user to by clicking through the page as they would: the
// `data-fazer-ai-action` names to press in order, and on a phone, where the menu is laid out
// differently, the names to press there.
export interface AgentPath {
  name: string;
  // What the destination is, for the agent choosing where to go.
  description: string;
  steps: string[];
  phone?: string[];
  // How long each step's element may take to appear after the previous click, in milliseconds.
  stepTimeout?: number;
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
  pageAction: string;
  pagePoint: string;
  pageNavigate: string;
  backToChat: string;
  history: string;
  back: string;
  historyLoading: string;
  historyEmpty: string;
  historyFailed: string;
  historyMore: string;
  untitled: string;
  transcriptLoading: string;
  transcriptFailed: string;
  transcriptMore: string;
  notKept: string;
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
    pageAction: "Using the page",
    pagePoint: "Showing you on the page",
    pageNavigate: "Taking you there",
    backToChat: "Back to the conversation",
    history: "Conversations",
    back: "Back to the conversation",
    historyLoading: "Loading the conversations…",
    historyEmpty: "No earlier conversations yet.",
    historyFailed: "Could not load the conversations.",
    historyMore: "Show older",
    untitled: "Conversation",
    transcriptLoading: "Loading the conversation…",
    transcriptFailed: "Could not load this conversation's messages.",
    transcriptMore: "Show earlier messages",
    notKept:
      "The earlier messages of this conversation were not kept. You can go on from here.",
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
    pageAction: "Usando a página",
    pagePoint: "Mostrando na página",
    pageNavigate: "Levando você até lá",
    backToChat: "Voltar à conversa",
    history: "Conversas",
    back: "Voltar para a conversa",
    historyLoading: "Carregando as conversas…",
    historyEmpty: "Nenhuma conversa anterior ainda.",
    historyFailed: "Não foi possível carregar as conversas.",
    historyMore: "Mostrar mais antigas",
    untitled: "Conversa",
    transcriptLoading: "Carregando a conversa…",
    transcriptFailed: "Não foi possível carregar as mensagens desta conversa.",
    transcriptMore: "Mostrar mensagens anteriores",
    notKept:
      "As mensagens anteriores desta conversa não foram guardadas. Dá para continuar daqui.",
  },
};

// A turn can ask for tools several times before it answers; this bounds an agent that keeps asking.
const MAX_ROUNDS = 8;
const HIGHLIGHT_TOOL = "highlight_element";
const HIGHLIGHT_MS = 6000;
const TARGET_ATTR = "data-fazer-ai-target";
// What the agent may click is a list of its own, apart from what it may only point at: a page marks
// an element with this attribute to let the agent press it for the user.
const ACTION_TOOL = "click_element";
const ACTION_ATTR = "data-fazer-ai-action";
// A path is played in one call: each step's element may take this long to appear after the previous
// click (a route change, a menu that opens), by default and at most.
const NAVIGATE_TOOL = "navigate_to";
const STEP_TIMEOUT_MS = 5000;
const STEP_TIMEOUT_MAX_MS = 30_000;
const STEP_POLL_MS = 50;
// When the host turns them on, how long the element shows outlined before the click, how long the
// drawn pointer takes to reach it, and how long the pointer stays after the click.
const ACTION_HIGHLIGHT_MS = 900;
const CURSOR_MS = 600;
const CURSOR_LINGER_MS = 1500;
// On a phone the open panel covers the page, so while the agent acts on it the panel shrinks to a
// strip, in this long a transition, below this width.
const MORPH_MS = 220;
// How long the strip holds after the agent points at the page and after it clicks. Read at the call,
// so a test can shorten the deadline it asserts instead of waiting it out; the widget never changes it.
export const STRIP_HOLD_MS = { point: HIGHLIGHT_MS, click: CURSOR_LINGER_MS };
const PHONE_QUERY = "(max-width: 640px)";
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
.strip {
  display: none; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 0; cursor: pointer;
  background: none; color: inherit; font: inherit; text-align: left;
}
.strip .lines { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.strip .strip-step { font-size: 12px; color: var(--fazer-ai-muted); }
.strip .strip-line { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.strip .strip-line:empty { display: none; }
.strip svg { flex: none; color: var(--fazer-ai-muted); }
@media (max-width: 640px) {
  :host(:not([mode="inline"])) .panel.reduced > :not(.strip) { display: none; }
  :host(:not([mode="inline"])) .panel.reduced .strip { display: flex; }
  :host(:not([mode="inline"])) .panel.reduced {
    inset: auto 8px calc(8px + env(safe-area-inset-bottom)) 8px; border-radius: var(--fazer-ai-radius);
  }
  :host(:not([mode="inline"])) .panel.reduced[data-at="top"] {
    inset: calc(8px + env(safe-area-inset-top)) 8px auto 8px;
  }
}
@media (max-width: 640px) {
  :host(:not([mode="inline"])) .fab[aria-expanded="true"] { display: none; }
}
header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--fazer-ai-border); }
header h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
.ghost { background: none; border: 0; color: var(--fazer-ai-muted); cursor: pointer; font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 6px; }
.ghost:hover { color: var(--fazer-ai-text); background: var(--fazer-ai-surface); }
.ghost:disabled { opacity: .5; cursor: default; }
.challenge { display: flex; justify-content: center; }
.log[hidden], .threads[hidden], form[hidden], .challenge[hidden], header button[hidden] { display: none; }
.threads { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
.threads ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.thread { width: 100%; display: flex; flex-direction: column; gap: 2px; text-align: left; background: none; border: 0; border-radius: 8px; padding: 10px 12px; color: inherit; font: inherit; cursor: pointer; }
.thread:hover, .thread:focus-visible { background: var(--fazer-ai-surface); }
.thread[aria-current="true"] { background: var(--fazer-ai-surface); }
.thread[aria-current="true"] .thread-title { font-weight: 600; }
.thread-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-time { color: var(--fazer-ai-muted); font-size: 12px; }
.threads .status, .threads .empty { padding: 10px 12px; }
.threads .failed, .log .failed { color: var(--fazer-ai-error); }
.threads .more { align-self: center; margin-top: 6px; }
.log .more { align-self: center; }
.icon.small { width: 28px; height: 28px; border-radius: 6px; }
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
const ICON_GROW =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
const ICON_HISTORY =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>';
const ICON_BACK =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const ICON_CLOSE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// A thread waiting for the browser's answers, with the storage key of the owner it belongs to.
interface Suspended {
  thread: string;
  key: string | null;
}

type VoiceState = "idle" | "asking" | "recording" | "transcribing";

// One of the user's earlier conversations, as the instance lists them.
interface ListedThread {
  threadId: string;
  title: string | null;
  lastTurnAt: string;
}

// The list of earlier conversations on screen: what has loaded, where the next page starts, and
// whether that page is on its way.
interface ThreadList {
  state: "idle" | "loading" | "ready" | "failed";
  items: ListedThread[];
  next: string | null;
  more: boolean;
}

const NO_THREADS: ThreadList = {
  state: "idle",
  items: [],
  next: null,
  more: false,
};

// A reopened conversation's messages as the instance kept them: whether they have loaded, whether
// they are all there (`recorded`), where the earlier page starts, and whether it is on its way.
interface Transcript {
  state: "loading" | "ready" | "failed";
  recorded: boolean;
  before: string | null;
  older: boolean;
}

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
  static observedAttributes = ["lang", "token-url", "mode", "history"];

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
  #paths = new Map<string, AgentPath>();
  #context: Json | (() => Json) | null = null;
  // The drawn pointer of `action-cursor`, where it last stopped, and the timer that hides it.
  #cursor: HTMLElement | null = null;
  #cursorAt: { x: number; y: number } | null = null;
  #cursorTimer: ReturnType<typeof setTimeout> | undefined;
  // Bumped when the identity changes or the widget leaves the page: a click still waiting on its
  // outline or pointer would otherwise land with the next user's session, or with nobody watching.
  #actions = 0;
  // While the agent acts on the page from a phone: the timer that grows the panel back, and the
  // transition running between the two sizes.
  #growTimer: ReturnType<typeof setTimeout> | undefined;
  #growBy = 0;
  #morphing: Animation | null = null;
  #following = 0;
  #phoneQuery: MediaQueryList | null = null;
  #onPhoneChange = (e: MediaQueryListEvent) => {
    if (!e.matches) this.#settle();
  };
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
  // The open conversation's messages as the instance kept them, read when it is reopened (after a
  // reload, from the list, at a hand-over): loading, how far back they go, and whether they are all
  // there. Null for a conversation begun on screen.
  #transcript: Transcript | null = null;
  // Bumped on every load and whenever the open conversation changes, so a late page is dropped.
  #transcriptRun = 0;
  // The load in flight, which a message waits for before it is sent: the instance would record it
  // first, and the page read after would show it twice.
  #transcriptPending: Promise<void> | null = null;
  // What the panel shows: the conversation, or the list of the user's earlier ones.
  #view: "chat" | "threads" = "chat";
  #threads: ThreadList = NO_THREADS;
  // Bumped on every load of the list and on leaving it, so an answer for an earlier load is dropped.
  #threadsRun = 0;
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
    back: HTMLButtonElement;
    history: HTMLButtonElement;
    threads: HTMLElement;
    challenge: HTMLElement;
    form: HTMLFormElement;
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
    strip: HTMLElement;
    stripStep: HTMLElement;
    stripLine: HTMLElement;
    stripBack: HTMLElement;
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    this.#root.innerHTML = `<style>${STYLE}</style>
<button class="fab" type="button" aria-controls="panel" aria-expanded="false">${ICON_CHAT}</button>
<section class="panel" id="panel" hidden role="dialog" tabindex="-1">
  <button class="strip" type="button"><span class="lines" aria-live="polite"><span class="strip-step"></span><span class="strip-line"></span></span><span class="sr strip-back"></span>${ICON_GROW}</button>
  <header><button class="icon small back" type="button" hidden>${ICON_BACK}</button><h2></h2><button class="icon small history" type="button">${ICON_HISTORY}</button><button class="ghost reset" type="button"></button><button class="ghost close" type="button">${ICON_CLOSE}</button></header>
  <div class="log" aria-live="polite"></div>
  <div class="threads" hidden></div>
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
      back: q(".back"),
      history: q(".history"),
      threads: q(".threads"),
      challenge: q(".challenge"),
      form: q("form"),
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
      strip: q(".strip"),
      stripStep: q(".strip-step"),
      stripLine: q(".strip-line"),
      stripBack: q(".strip-back"),
    };
    this.#els.fab.addEventListener("click", () =>
      this.#open ? this.close() : this.open(),
    );
    this.#els.mic.addEventListener("click", () => void this.#startVoice());
    this.#els.recCancel.addEventListener("click", () => this.#cancelVoice());
    this.#els.recSend.addEventListener("click", () => void this.#finishVoice());
    this.#els.panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.#view === "threads") {
        e.preventDefault();
        e.stopPropagation();
        this.#showChat();
        return;
      }
      if (this.#voice === "idle") return;
      e.preventDefault();
      e.stopPropagation();
      this.#cancelVoice();
    });
    this.#els.history.addEventListener("click", () => this.#showThreads());
    this.#els.back.addEventListener("click", () => this.#showChat());
    this.#els.close.addEventListener("click", () => this.close());
    // A tap or a key on the strip moves focus into the conversation it brings back, without opening
    // the phone's keyboard as the textarea would.
    this.#els.strip.addEventListener("click", () => {
      this.#grow();
      this.#els.panel.focus();
    });
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
    this.#actions++;
    this.#cursor?.remove();
    this.#settle();
    this.#phoneQuery?.removeEventListener("change", this.#onPhoneChange);
    this.#phoneQuery = null;
  }

  attributeChangedCallback(
    name: string,
    old: string | null,
    value: string | null,
  ) {
    // NOTE: absent is a way of signing in too (an anonymous session), so adding the URL changes who
    // the widget speaks for as much as replacing it does.
    if (name === "token-url" && old !== value) this.identityChanged();
    if (name === "mode") {
      this.#open = value === "inline";
      this.#settle();
    }
    this.#paint();
    if (this.isConnected) this.#restore();
  }

  // Before the agent clicks a marked element, outline it for a moment (`action-highlight`) and move a
  // drawn pointer onto it (`action-cursor`). Both are off unless the host sets them.
  get actionHighlight(): boolean {
    return this.hasAttribute("action-highlight");
  }

  set actionHighlight(on: boolean) {
    this.toggleAttribute("action-highlight", on);
  }

  get actionCursor(): boolean {
    return this.hasAttribute("action-cursor");
  }

  set actionCursor(on: boolean) {
    this.toggleAttribute("action-cursor", on);
  }

  tool(def: AgentTool): void {
    if (BUILT_IN_TOOLS.includes(def.name))
      throw new Error(`${def.name} is built in`);
    this.#tools.set(def.name, def);
  }

  untool(name: string): void {
    this.#tools.delete(name);
  }

  path(def: AgentPath): void {
    const names = (list: unknown) =>
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((step) => typeof step === "string" && step !== "");
    if (typeof def?.name !== "string" || !def.name)
      throw new Error("a path needs a name");
    if (!names(def.steps))
      throw new Error(`path ${def.name} needs at least one step`);
    if (def.phone !== undefined && !names(def.phone))
      throw new Error(`path ${def.name} has an empty phone variant`);
    this.#paths.set(def.name, {
      ...def,
      steps: [...def.steps],
      phone: def.phone && [...def.phone],
    });
  }

  unpath(name: string): void {
    this.#paths.delete(name);
  }

  context(value: Json | (() => Json) | null): void {
    this.#context = value;
  }

  open(): void {
    this.#open = true;
    this.#settle();
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
    this.#actions++;
    this.#cancelVoice();
    this.#cancelChallenge?.();
    this.#adoptHandOver = true;
    this.#token = null;
    this.#owner = null;
    this.#threadId = undefined;
    this.#resetPending = false;
    this.#messages = [];
    this.#forgetTranscript();
    this.#view = "chat";
    this.#threads = NO_THREADS;
    this.#threadsRun++;
    this.#busy = false;
    if (this.#els) {
      this.#settle();
      this.#els.input.value = "";
      this.#fitInput();
      this.#paint();
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

  // "New conversation": the next message starts a thread. The one set aside stays in the list of
  // earlier conversations, where it reopens with its messages.
  reset(): void {
    if (this.#busy) return;
    this.#adoptHandOver = false;
    this.#threadId = undefined;
    const key = this.#threadKey();
    if (key) safeStorage(() => localStorage.removeItem(key));
    else this.#resetPending = true;
    this.#messages = [];
    this.#forgetTranscript();
    this.#view = "chat";
    this.#threadsRun++;
    this.#paint();
  }

  #lang(): string {
    return this.getAttribute("lang") || navigator.language || "en";
  }

  #t(): AgentTexts {
    const lang = this.#lang().toLowerCase();
    return { ...TEXTS[lang.startsWith("pt") ? "pt" : "en"], ...this.#texts };
  }

  #paint(): void {
    // NOTE: a microphone left recording behind a hidden panel is one the person cannot see, however
    // the panel came to be hidden (`close()`, leaving inline mode).
    if (!this.#open) {
      this.#cancelVoice();
      this.#settle();
    }
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
    const historyOn = this.getAttribute("history") !== "off";
    if (!historyOn && this.#view === "threads") {
      this.#view = "chat";
      this.#threadsRun++;
    }
    const listing = this.#view === "threads";
    this.#els.title.textContent = listing ? t.history : t.title;
    this.#els.history.hidden = !historyOn || listing;
    this.#els.history.setAttribute("aria-label", t.history);
    this.#els.back.hidden = !listing;
    this.#els.back.setAttribute("aria-label", t.back);
    this.#els.log.hidden = listing;
    this.#els.challenge.hidden = listing;
    this.#els.form.hidden = listing;
    this.#els.threads.hidden = !listing;
    this.#els.threads.setAttribute("aria-label", t.history);
    if (listing) this.#renderThreads();
    this.#els.reset.textContent = t.reset;
    this.#els.close.setAttribute("aria-label", t.close);
    this.#els.stripBack.textContent = t.backToChat;
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
    this.#els.history.disabled = this.#busy || this.#voice !== "idle";
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

  // Kept at the newest message, or, with `fromBottom`, that far above the end, so a page put ahead
  // of what was on screen leaves it where it was.
  #renderLog(fromBottom?: number): void {
    const t = this.#t();
    const log = this.#els.log;
    log.replaceChildren();
    const line = (className: string, text: string) => {
      const p = document.createElement("p");
      p.className = className;
      p.textContent = text;
      log.appendChild(p);
      return p;
    };
    const kept = this.#transcript;
    if (kept?.state === "loading")
      line("status", t.transcriptLoading).setAttribute("role", "status");
    else if (kept?.state === "failed")
      line("status failed", t.transcriptFailed);
    else if (kept?.before) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ghost more";
      more.textContent = t.transcriptMore;
      more.disabled = kept.older || this.#busy;
      more.addEventListener("click", () => void this.#loadOlder());
      log.appendChild(more);
    } else if (kept?.state === "ready" && !kept.recorded)
      line(this.#messages.length ? "status" : "empty", t.notKept);
    if (!this.#messages.length && !kept) line("empty", t.empty);
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
    log.scrollTop = log.scrollHeight - (fromBottom ?? 0);
    this.#els.stripLine.textContent = latestLine(this.#messages);
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
      const adopt =
        newest !== undefined &&
        this.#threadId === undefined &&
        this.#adoptHandOver;
      if (adopt) {
        this.#threadId = newest;
        const threadKey = this.#threadKey();
        if (threadKey)
          safeStorage(() => localStorage.setItem(threadKey, newest));
        // NOTE: awaited, as obtaining the token is, so a message waiting to be sent goes after it.
        await this.#loadTranscript(newest, token);
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
      this.#forgetTranscript();
      // NOTE: a reset was the previous owner's; one pressed before any token said whose stays.
      this.#adoptHandOver = true;
      this.#settle();
      // NOTE: the list on screen was the previous user's.
      this.#view = "chat";
      this.#threads = NO_THREADS;
      this.#threadsRun++;
      this.#els.input.value = "";
      this.#paint();
    }
    this.#owner = sub;
    this.#threadId = undefined;
    const key = this.#threadKey();
    if (!key) return;
    if (this.#resetPending) {
      this.#resetPending = false;
      safeStorage(() => localStorage.removeItem(key));
      return;
    }
    this.#threadId = safeStorage(() => localStorage.getItem(key)) ?? undefined;
    // NOTE: with the token just obtained, which a load started from inside obtaining it must use.
    if (this.#threadId && this.#token)
      void this.#loadTranscript(this.#threadId, this.#token);
  }

  #forgetTranscript(): void {
    this.#transcript = null;
    this.#transcriptPending = null;
    this.#transcriptRun++;
  }

  // Reads the open conversation's latest messages from the instance and shows them ahead of what is
  // on screen, which is only what was said since (a message waits for this load before it is sent).
  // With `token`, the one being obtained, used as is; without, asked for quietly and renewed once.
  #loadTranscript(thread: string, token?: string): Promise<void> {
    const run = ++this.#transcriptRun;
    const identity = this.#identity;
    const live = () =>
      run === this.#transcriptRun &&
      identity === this.#identity &&
      this.#threadId === thread;
    this.#transcript = {
      state: "loading",
      recorded: true,
      before: null,
      older: false,
    };
    this.#renderLog();
    const pending = this.#fetchTranscript(thread, null, live, token).then(
      (page) => {
        if (!live()) return;
        if (page === "failed") {
          this.#transcript = {
            state: "failed",
            recorded: true,
            before: null,
            older: false,
          };
        } else {
          this.#messages = [...page.messages, ...this.#messages];
          this.#transcript = {
            state: "ready",
            recorded: page.recorded,
            before: page.before,
            older: false,
          };
        }
        if (this.#transcriptPending === pending) this.#transcriptPending = null;
        this.#renderLog();
      },
    );
    this.#transcriptPending = pending;
    return pending;
  }

  // The page before the earliest message shown, put ahead of it. Not while a turn runs: a renewal
  // from here could rebind the owner under it.
  async #loadOlder(): Promise<void> {
    const kept = this.#transcript;
    const thread = this.#threadId;
    if (!kept?.before || kept.older || !thread || this.#busy) return;
    const run = this.#transcriptRun;
    const identity = this.#identity;
    const live = () =>
      run === this.#transcriptRun &&
      identity === this.#identity &&
      this.#threadId === thread;
    kept.older = true;
    const log = this.#els.log;
    this.#renderLog(log.scrollHeight - log.scrollTop);
    const page = await this.#fetchTranscript(thread, kept.before, live);
    if (!live()) return;
    kept.older = false;
    const fromBottom = log.scrollHeight - log.scrollTop;
    if (page !== "failed") {
      this.#messages = [...page.messages, ...this.#messages];
      kept.before = page.before;
    }
    this.#renderLog(fromBottom);
  }

  async #fetchTranscript(
    thread: string,
    before: string | null,
    live: () => boolean,
    given?: string,
    renewed = false,
  ): Promise<
    { messages: Message[]; recorded: boolean; before: string | null } | "failed"
  > {
    let token: string;
    try {
      token = given ?? (await this.#getToken(renewed, true));
    } catch {
      return "failed";
    }
    if (!live()) return "failed";
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    let res: Response;
    try {
      res = await fetch(
        `${this.#instance()}/api/v1/sdk/${encodeURIComponent(this.getAttribute("app") ?? "")}/threads/${encodeURIComponent(thread)}/messages${query}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "accept-language": this.#lang(),
          },
        },
      );
    } catch {
      return "failed";
    }
    // NOTE: a token being obtained is not renewed from inside obtaining it, and none is renewed under
    // a running turn, whose owner a renewal naming another user would change.
    if (
      res.status === 401 &&
      !renewed &&
      given === undefined &&
      !this.#busy &&
      live()
    )
      return this.#fetchTranscript(thread, before, live, undefined, true);
    if (!res.ok) return "failed";
    return transcriptPage(await res.json().catch(() => null)) ?? "failed";
  }

  // The list of the user's earlier conversations, in place of the open one. Asked quietly, as the
  // panel's restore is: an anonymous visitor this browser never opened a session for has none, and
  // is not given one to find that out.
  #showThreads(): void {
    if (this.#busy || this.#voice !== "idle") return;
    this.#view = "threads";
    this.#paint();
    this.#els.back.focus();
    void this.#loadThreads(false);
  }

  #showChat(): void {
    if (this.#view === "chat") return;
    this.#view = "chat";
    this.#threadsRun++;
    this.#paint();
    if (this.#open) this.#els.input.focus();
  }

  async #loadThreads(more: boolean): Promise<void> {
    const run = ++this.#threadsRun;
    const identity = this.#identity;
    const cursor = more ? this.#threads.next : null;
    this.#threads = more
      ? { ...this.#threads, more: true }
      : { state: "loading", items: [], next: null, more: false };
    this.#renderThreads();
    const live = () => run === this.#threadsRun && identity === this.#identity;
    const page = await this.#fetchThreads(cursor, live);
    if (!live()) return;
    const kept = more ? this.#threads.items : [];
    this.#threads =
      page === "failed"
        ? { state: "failed", items: kept, next: null, more: false }
        : page === "none"
          ? { state: "ready", items: kept, next: null, more: false }
          : {
              state: "ready",
              items: [...kept, ...page.threads],
              next: page.nextCursor,
              more: false,
            };
    this.#renderThreads();
  }

  // One page of the list. A 401 renews the token once, as the turn does, while the list is still
  // the one asked for: a renewal for a list left behind could rebind the owner under a running turn.
  // A visitor with no session to resume has no conversations to list.
  async #fetchThreads(
    cursor: string | null,
    live: () => boolean,
    renewed = false,
  ): Promise<
    { threads: ListedThread[]; nextCursor: string | null } | "none" | "failed"
  > {
    let token: string;
    try {
      token = await this.#getToken(renewed, true);
    } catch (e) {
      return e instanceof QuietStop ? "none" : "failed";
    }
    if (!live()) return "failed";
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    let res: Response;
    try {
      res = await fetch(
        `${this.#instance()}/api/v1/sdk/${encodeURIComponent(this.getAttribute("app") ?? "")}/threads${query}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "accept-language": this.#lang(),
          },
        },
      );
    } catch {
      return "failed";
    }
    if (res.status === 401 && !renewed && live())
      return this.#fetchThreads(cursor, live, true);
    if (!res.ok) return "failed";
    return threadPage(await res.json().catch(() => null)) ?? "failed";
  }

  #renderThreads(): void {
    const t = this.#t();
    const box = this.#els.threads;
    const list = this.#threads;
    box.replaceChildren();
    const line = (className: string, text: string) => {
      const p = document.createElement("p");
      p.className = className;
      p.textContent = text;
      box.appendChild(p);
      return p;
    };
    if (list.state === "loading") {
      line("status", t.historyLoading).setAttribute("role", "status");
      return;
    }
    if (list.items.length) {
      const ul = document.createElement("ul");
      const now = Date.now();
      for (const item of list.items) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "thread";
        if (item.threadId === this.#threadId)
          button.setAttribute("aria-current", "true");
        const title = document.createElement("span");
        title.className = "thread-title";
        title.textContent = item.title ?? t.untitled;
        const time = document.createElement("span");
        time.className = "thread-time";
        time.textContent = whenLabel(item.lastTurnAt, this.#lang(), now);
        button.append(title, time);
        button.addEventListener("click", () => this.#openThread(item.threadId));
        li.appendChild(button);
        ul.appendChild(li);
      }
      box.appendChild(ul);
    } else if (list.state === "ready") line("empty", t.historyEmpty);
    if (list.state === "failed") line("status failed", t.historyFailed);
    if (list.next && list.state === "ready") {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ghost more";
      more.textContent = t.historyMore;
      more.disabled = list.more;
      more.addEventListener("click", () => void this.#loadThreads(true));
      box.appendChild(more);
    }
  }

  // Opens one of the earlier conversations: the next message continues it, and its messages are
  // read from the instance, on any device.
  #openThread(thread: string): void {
    if (this.#busy || this.#voice !== "idle") return;
    const key = this.#threadKey();
    if (key && thread !== this.#threadId) {
      this.#threadId = thread;
      safeStorage(() => localStorage.setItem(key, thread));
      this.#messages = [];
      // NOTE: the person chose this conversation; a hand-over arriving later does not replace it.
      this.#adoptHandOver = false;
      void this.#loadTranscript(thread);
    }
    this.#showChat();
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
    if (this.#paths.size) {
      const paths = [...this.#paths.values()];
      tools.push({
        name: NAVIGATE_TOOL,
        // The destinations are listed in the parameter's own description, not the tool's: the turn
        // route caps a tool's description, and a page may declare many paths.
        description:
          "Take the user to a place in the app by clicking through it for them, step by step, as they would; they see each click and learn the way. Prefer it over the page's own navigation tools or a link whenever the destination is listed; fall back to those only when no destination fits or this stops, and say where it stopped.",
        parameters: {
          type: "object",
          properties: {
            destination: {
              type: "string",
              enum: paths.map((p) => p.name),
              description: `Where to take the user:\n${paths.map((p) => `- ${p.name}: ${p.description}`).join("\n")}`,
            },
          },
          required: ["destination"],
          additionalProperties: false,
        },
      });
    }
    const actions = actionTargets();
    if (actions.length)
      tools.push({
        name: ACTION_TOOL,
        description:
          "Click an element of the page the user is looking at, for them and as they would: a button, a tab, a menu entry. Only the elements listed can be clicked, and the page's own confirmations still apply. For an action the user must take themselves, point at it with highlight_element instead.",
        parameters: {
          type: "object",
          properties: { target: { type: "string", enum: actions } },
          required: ["target"],
          additionalProperties: false,
        },
      });
    return tools;
  }

  // Clicks the marked element through its own handlers, so the page's guards answer as they would a
  // person. The element is checked again after the outline and the pointer, which take time.
  async #act(
    target: string,
    // Why not to click after all, asked right before the click, once the outline and the pointer are
    // done: a path's guard, since the page may have opened its confirmation meanwhile.
    holdBack: (el: HTMLElement) => string | null = () => null,
  ): Promise<{ clicked: string } | { clicked: null; reason: string }> {
    // NOTE: the call's arguments are not checked against the enum before they reach here, so a name
    // the page does not offer (an empty one would match an unnamed mark) is refused first.
    if (!target || !actionTargets().includes(target))
      return { clicked: null, reason: "not on this page" };
    const el = document.querySelector(
      `[${ACTION_ATTR}="${CSS.escape(target)}"]`,
    );
    if (!(el instanceof HTMLElement))
      return { clicked: null, reason: "not on this page" };
    const refused = whyNotClickable(el);
    if (refused) return { clicked: null, reason: refused };
    const actions = this.#actions;
    const motion = !reducedMotion();
    // NOTE: "instant", not "auto": auto follows the host's `scroll-behavior`, which may be smooth.
    el.scrollIntoView({
      block: "center",
      behavior: motion ? "smooth" : "instant",
    });
    const box = this.actionHighlight ? outline(el, target, document) : null;
    const cancelled = () => this.#actions !== actions || !this.isConnected;
    try {
      if (box) await sleep(ACTION_HIGHLIGHT_MS);
      // NOTE: checked before the pointer too, which would otherwise draw on a page the widget left.
      if (cancelled()) return { clicked: null, reason: "cancelled" };
      if (this.actionCursor) await this.#pointAt(el, motion);
      if (cancelled()) return { clicked: null, reason: "cancelled" };
      // The host may have withdrawn the mark, or reused the node for another control, meanwhile.
      if (el.getAttribute(ACTION_ATTR) !== target)
        return { clicked: null, reason: "no longer offered" };
      const late = whyNotClickable(el) ?? holdBack(el);
      if (late) return { clicked: null, reason: late };
      el.click();
      return { clicked: target };
    } finally {
      box?.remove();
      if (this.#cursor) {
        const cursor = this.#cursor;
        clearTimeout(this.#cursorTimer);
        this.#cursorTimer = setTimeout(() => cursor.remove(), CURSOR_LINGER_MS);
      }
    }
  }

  // Plays a declared path: each step clicked through `#act`, as `click_element` would, after waiting
  // for its element to appear and be clickable. It stops at the first step that cannot be taken and
  // says which and why, and never goes another way on its own; a dialog the page opens between steps
  // (its own confirmation) stops it, since the user answers that.
  async #navigate(
    destination: string,
    t: AgentTexts,
  ): Promise<
    | { arrived: string }
    | {
        arrived: null;
        stoppedAt?: number;
        step?: string;
        reason: string;
      }
  > {
    const path = destination ? this.#paths.get(destination) : undefined;
    if (!path) return { arrived: null, reason: "no path to this destination" };
    const steps =
      path.phone && window.matchMedia?.(PHONE_QUERY).matches
        ? path.phone
        : path.steps;
    const timeout = Math.min(
      Math.max(Number(path.stepTimeout) || STEP_TIMEOUT_MS, STEP_POLL_MS),
      STEP_TIMEOUT_MAX_MS,
    );
    const actions = this.#actions;
    const cancelled = () => this.#actions !== actions || !this.isConnected;
    // The dialogs already showing when the path began are the page's own business; any other is a
    // guard for every step it does not hold, for as long as it shows, also one a step of the path
    // opened and pressed into.
    const before = openDialogs();
    const guarded = (el: Element | null) =>
      openDialogs().some(
        (dialog) => !before.includes(dialog) && !(el && dialog.contains(el)),
      )
        ? GUARD
        : null;
    // The strip grows back once, after the last click: between steps it only follows the next
    // element, so a slow step does not make it grow and shrink again.
    let shrunk = false;
    try {
      for (const [i, step] of steps.entries()) {
        const stop = (reason: string) => ({
          arrived: null,
          stoppedAt: i + 1,
          step,
          reason,
        });
        const deadline = performance.now() + timeout;
        for (;;) {
          if (cancelled()) return stop("cancelled");
          const el = markOf(ACTION_ATTR, step);
          // Checked before the step is taken as ready, and again right before its click: a click does
          // not go through hit testing, so a step still visible behind the page's confirmation would
          // otherwise be pressed past it. A dialog that holds the step is the path going on inside
          // it, not a guard.
          const guard = guarded(el);
          if (guard) return stop(guard);
          if (el instanceof HTMLElement && !whyNotClickable(el)) break;
          if (performance.now() >= deadline)
            return stop(
              el instanceof HTMLElement
                ? (whyNotClickable(el) ?? "did not appear")
                : "did not appear",
            );
          await sleep(STEP_POLL_MS);
        }
        shrunk =
          this.#shrink(markOf(ACTION_ATTR, step), t.pageNavigate) || shrunk;
        const clicked = await this.#act(step, guarded);
        if (clicked.clicked === null) return stop(clicked.reason);
        // The page renders what the click started (a route, a confirmation it schedules) in tasks of
        // its own, which a click with no outline and no pointer would otherwise not wait for.
        await sleep(STEP_POLL_MS);
      }
      return { arrived: path.name };
    } finally {
      if (shrunk) this.#growLater(CURSOR_LINGER_MS);
    }
  }

  // Moves the drawn pointer from where it last stopped (the widget's corner the first time) to the
  // element's centre, re-measured every frame while the scroll moves the element.
  async #pointAt(el: HTMLElement, motion: boolean): Promise<void> {
    clearTimeout(this.#cursorTimer);
    const cursor = this.#cursor ?? pointer(document);
    this.#cursor = cursor;
    if (!cursor.isConnected) document.body.appendChild(cursor);
    const centre = () => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const fab = this.#els.fab.getBoundingClientRect();
    const from = this.#cursorAt ?? {
      x: fab.width ? fab.left + fab.width / 2 : window.innerWidth - 48,
      y: fab.height ? fab.top + fab.height / 2 : window.innerHeight - 48,
    };
    if (motion) {
      const start = performance.now();
      await new Promise<void>((done) => {
        const step = () => {
          const k = Math.min(1, (performance.now() - start) / CURSOR_MS);
          const eased = 1 - (1 - k) ** 3;
          const to = centre();
          place(cursor, {
            x: from.x + (to.x - from.x) * eased,
            y: from.y + (to.y - from.y) * eased,
          });
          if (k < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
    }
    this.#cursorAt = centre();
    place(cursor, this.#cursorAt);
  }

  // The open panel covers the whole page on a phone, so while the agent acts on the page it shrinks
  // to a strip on the half of the screen away from the element, with the step and the latest line,
  // and grows back when the action is over or the person taps it. False where that does not apply:
  // a desktop, inline mode, a closed panel, or a host that set `reduce-on-action="off"`.
  #shrink(el: Element | null, step: string): boolean {
    if (!this.#onPhone() || this.getAttribute("reduce-on-action") === "off")
      return false;
    this.#watchPhone();
    // NOTE: only the timer stops; its deadline stays, so a shorter action does not end the strip
    // while an earlier highlight still shows.
    clearTimeout(this.#growTimer);
    const panel = this.#els.panel;
    this.#els.stripStep.textContent = step;
    this.#els.stripLine.textContent = latestLine(this.#messages);
    const at = el ? predictedSide(el) : "bottom";
    if (panel.classList.contains("reduced")) panel.dataset.at = at;
    else
      this.#morph(() => {
        panel.classList.add("reduced");
        panel.dataset.at = at;
      });
    if (el) this.#follow(el);
    else this.#following++;
    return true;
  }

  // The prediction cannot see every scroll container, so once the element stops moving the strip
  // takes the half away from where it actually is.
  #follow(el: Element): void {
    const panel = this.#els.panel;
    // A newer action owns the strip, so an older element still settling no longer moves it.
    const mine = ++this.#following;
    let last = Number.NaN;
    let still = 0;
    const step = () => {
      if (mine !== this.#following) return;
      if (!panel.classList.contains("reduced") && !this.#morphing) return;
      const rect = el.getBoundingClientRect();
      still = rect.top === last ? still + 1 : 0;
      last = rect.top;
      if (still < 3) {
        requestAnimationFrame(step);
        return;
      }
      panel.dataset.at =
        rect.top + rect.height / 2 > window.innerHeight / 2 ? "top" : "bottom";
    };
    requestAnimationFrame(step);
  }

  // Leaving the phone's width (a rotation, a resized window) leaves the strip with nothing to cover.
  #watchPhone(): void {
    if (this.#phoneQuery) return;
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query?.addEventListener) return;
    this.#phoneQuery = query;
    query.addEventListener("change", this.#onPhoneChange);
  }

  // Grows the panel back when the latest outstanding action is over: a click that ends while an
  // earlier highlight still shows waits for the highlight.
  #growLater(ms: number): void {
    clearTimeout(this.#growTimer);
    const now = performance.now();
    this.#growBy = Math.max(this.#growBy, now + ms);
    this.#growTimer = setTimeout(() => this.#grow(), this.#growBy - now);
  }

  #grow(): void {
    // A shrink still running (its end delayed in a background tab) would make the strip after this.
    if (this.#morphing) {
      this.#settle();
      return;
    }
    clearTimeout(this.#growTimer);
    this.#growBy = 0;
    const panel = this.#els.panel;
    if (!panel.classList.contains("reduced")) return;
    this.#morph(() => panel.classList.remove("reduced"));
    // NOTE: the log was not rendered while hidden, so it could not scroll to what arrived meanwhile.
    this.#els.log.scrollTop = this.#els.log.scrollHeight;
  }

  // Back to full size with no transition: the panel opened, closed, or changed hands.
  #settle(): void {
    clearTimeout(this.#growTimer);
    this.#growBy = 0;
    this.#following++;
    this.#morphing?.cancel();
    this.#morphing = null;
    this.#els.panel.classList.remove("reduced");
    this.#els.log.scrollTop = this.#els.log.scrollHeight;
  }

  // Changes the panel's size and animates the edge between the two as a clip on the larger box, so
  // the content is revealed or covered rather than squeezed. No animation for reduced motion.
  #morph(change: () => void): void {
    const panel = this.#els.panel;
    this.#morphing?.cancel();
    this.#morphing = null;
    const from = panel.getBoundingClientRect();
    change();
    const to = panel.getBoundingClientRect();
    if (reducedMotion() || typeof panel.animate !== "function") return;
    const big = from.height >= to.height ? from : to;
    const small = big === from ? to : from;
    if (!big.width || !big.height) return;
    const shrinking = big === from;
    // A keyframe cannot read the custom property, so the strip's rounding is read off it.
    const radius =
      Number.parseFloat(
        getComputedStyle(this).getPropertyValue("--fazer-ai-radius"),
      ) || 0;
    const clip = (r: DOMRect) =>
      `inset(${r.top - big.top}px ${big.right - r.right}px ${big.bottom - r.bottom}px ${r.left - big.left}px round ${radius}px)`;
    const frames = [{ clipPath: clip(big) }, { clipPath: clip(small) }];
    // NOTE: a shrink keeps the full panel during the transition and becomes the strip at its end.
    if (shrinking) panel.classList.remove("reduced");
    const run = panel.animate(shrinking ? frames : frames.reverse(), {
      duration: MORPH_MS,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
    this.#morphing = run;
    run.onfinish = () => {
      if (this.#morphing !== run) return;
      this.#morphing = null;
      if (shrinking) panel.classList.add("reduced");
    };
  }

  #onPhone(): boolean {
    return (
      this.isConnected &&
      this.getAttribute("mode") !== "inline" &&
      this.#open &&
      !!window.matchMedia?.(PHONE_QUERY).matches
    );
  }

  // Without the strip (`reduce-on-action="off"`), the panel steps aside while the agent acts on the
  // page and comes back when the outline is gone.
  #stepAside(): void {
    if (this.getAttribute("mode") === "inline" || !this.#open) return;
    if (!window.matchMedia?.(PHONE_QUERY).matches) return;
    this.close();
    setTimeout(() => {
      if (!this.#open) this.open();
    }, HIGHLIGHT_MS);
  }

  async #runCall(call: ToolCall): Promise<ToolAnswer> {
    try {
      const t = this.#t();
      if (call.name === HIGHLIGHT_TOOL) {
        const target = String(call.args.target ?? "");
        if (this.#shrink(markOf(TARGET_ATTR, target), t.pagePoint))
          this.#growLater(STRIP_HOLD_MS.point);
        else this.#stepAside();
        return { ok: true, result: highlight(target) };
      }
      if (call.name === NAVIGATE_TOOL) {
        // Without the strip, the panel steps aside for the whole path and comes back after it.
        const aside =
          this.getAttribute("reduce-on-action") === "off" && this.#onPhone();
        if (aside) this.close();
        try {
          return {
            ok: true,
            result: await this.#navigate(
              String(call.args.destination ?? ""),
              t,
            ),
          };
        } finally {
          if (aside)
            setTimeout(() => {
              if (!this.#open && this.isConnected) this.open();
            }, CURSOR_LINGER_MS);
        }
      }
      if (call.name === ACTION_TOOL) {
        const target = String(call.args.target ?? "");
        const shrunk = this.#shrink(markOf(ACTION_ATTR, target), t.pageAction);
        if (!shrunk) this.#stepAside();
        try {
          return { ok: true, result: await this.#act(target) };
        } finally {
          // NOTE: the strip stays a moment after the click, so the person sees what it did to the
          // page, and comes back also when the host's handler threw.
          if (shrunk) this.#growLater(STRIP_HOLD_MS.click);
        }
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
        ...(voice ? { voice: true } : {}),
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
          // NOTE: what was read of the dropped thread (how far back, whether kept) is not the new one's.
          this.#forgetTranscript();
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
                  name:
                    call.name === ACTION_TOOL
                      ? t.pageAction
                      : call.name === NAVIGATE_TOOL
                        ? t.pageNavigate
                        : this.#tools.get(call.name)?.label || call.name,
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
      this.#forgetTranscript();
    }
    if (key && safeStorage(() => localStorage.getItem(key)) === thread)
      safeStorage(() => localStorage.removeItem(key));
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
    if (this.#transcriptPending) await this.#transcriptPending;
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

// A page of a conversation's messages as the instance answers it; anything else is a failed load.
function transcriptPage(
  body: unknown,
): { messages: Message[]; recorded: boolean; before: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const { messages, recorded, before } = body as {
    messages?: unknown;
    recorded?: unknown;
    before?: unknown;
  };
  if (!Array.isArray(messages)) return null;
  return {
    messages: messages.flatMap((m): Message[] =>
      (m?.role === "user" || m?.role === "agent") && typeof m.text === "string"
        ? [
            m.role === "user" && m.voice === true
              ? { kind: "user", text: m.text, voice: true }
              : { kind: m.role, text: m.text },
          ]
        : [],
    ),
    recorded: recorded !== false,
    before: typeof before === "string" ? before : null,
  };
}

// A page of the list as the instance answers it; anything else is a failed load.
function threadPage(
  body: unknown,
): { threads: ListedThread[]; nextCursor: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const { threads, nextCursor } = body as {
    threads?: unknown;
    nextCursor?: unknown;
  };
  if (!Array.isArray(threads)) return null;
  return {
    threads: threads.filter(
      (t): t is ListedThread =>
        typeof t?.threadId === "string" &&
        typeof t.lastTurnAt === "string" &&
        (t.title === null || typeof t.title === "string"),
    ),
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  };
}

// When a conversation was last active, as a list line says it: relative within the week, then the
// date.
export function whenLabel(iso: string, lang: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  try {
    const relative = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    const minutes = Math.round((at - now) / 60_000);
    if (minutes === 0) return relative.format(0, "second");
    if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return relative.format(hours, "hour");
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) return relative.format(days, "day");
    const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
    return new Intl.DateTimeFormat(lang, {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(at);
  } catch {
    return new Date(at).toLocaleDateString();
  }
}

function safeStorage<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

const BUILT_IN_TOOLS = [HIGHLIGHT_TOOL, ACTION_TOOL, NAVIGATE_TOOL];
const GUARD = "the page opened a dialog; the user answers it";

// The page's modal dialogs showing right now: a confirmation that takes over between two steps of a
// path. One mounted but hidden is not showing yet, so it neither stops a path nor hides its own
// opening later.
function openDialogs(): Element[] {
  return [
    ...document.querySelectorAll(
      'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]',
    ),
  ].filter(
    (dialog) =>
      dialog instanceof HTMLElement && whyNotClickable(dialog) !== "hidden",
  );
}

// The marked element a call names, or null.
function markOf(attr: string, name: string): Element | null {
  if (!name) return null;
  return document.querySelector(`[${attr}="${CSS.escape(name)}"]`);
}

// Which half of the screen the strip takes while the agent acts on an element: away from where the
// element ends up once scrolled to the centre, as far as the page can scroll (an element near the
// end of the page stays in the lower half).
export function stripSide(
  rect: { top: number; height: number },
  view: { height: number; scrollY: number; scrollHeight: number },
): "top" | "bottom" {
  const centre = rect.top + rect.height / 2;
  const wanted = centre - view.height / 2;
  const room = Math.max(0, view.scrollHeight - view.height - view.scrollY);
  const moved = Math.min(Math.max(wanted, -view.scrollY), room);
  return centre - moved > view.height / 2 ? "top" : "bottom";
}

// Which half the strip takes for this element: where scrolling it to the centre leaves it, unless it
// is fixed or sticky, which the document's scroll does not move.
export function predictedSide(el: Element): "top" | "bottom" {
  const rect = el.getBoundingClientRect();
  for (let node: Element | null = el; node; node = node.parentElement) {
    const position = getComputedStyle(node).position;
    if (position === "fixed" || position === "sticky")
      return rect.top + rect.height / 2 > window.innerHeight / 2
        ? "top"
        : "bottom";
  }
  return stripSide(rect, {
    height: window.innerHeight,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  });
}

// The latest message of the conversation, as one line for the strip.
function latestLine(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.kind !== "step") return m.text.replace(/\s+/g, " ").trim();
  }
  return "";
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
  const box = outline(el, target, root);
  setTimeout(() => box.remove(), HIGHLIGHT_MS);
  return { shown: target };
}

// The outline both the highlight and a click before it draw: a fixed box over the element, followed
// every frame until it is removed.
function outline(el: HTMLElement, target: string, root: Document): HTMLElement {
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
  return box;
}

export function actionTargets(root: ParentNode = document): string[] {
  const names = new Set<string>();
  for (const el of root.querySelectorAll(`[${ACTION_ATTR}]`)) {
    const name = el.getAttribute(ACTION_ATTR);
    if (name) names.add(name);
  }
  return [...names];
}

// Why a person could not click this element right now, or null when they could: gone from the page,
// hidden (by an attribute or a style on it or an ancestor, or inside a closed <details>, or by what the
// browser reports it renders), or disabled (it or an ancestor).
export function whyNotClickable(el: HTMLElement): string | null {
  if (!el.isConnected) return "no longer on this page";
  if (el.closest("[hidden],[inert]")) return "hidden";
  // A closed <details> renders only its own summary, and its content keeps a normal computed style.
  for (
    let details = el.closest("details:not([open])");
    details;
    details = details.parentElement?.closest("details:not([open])") ?? null
  ) {
    if (!details.querySelector(":scope > summary")?.contains(el))
      return "hidden";
  }
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true }))
    return "hidden";
  for (let at: Element | null = el; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.display === "none") return "hidden";
    if (at === el && style.visibility === "hidden") return "hidden";
  }
  // NOTE: on it or an ancestor: a click on a mark inside a disabled button bubbles to that button.
  if (
    (el as { disabled?: unknown }).disabled === true ||
    el.closest(DISABLED) !== null
  )
    return "disabled";
  return null;
}

const DISABLED =
  'button[disabled], input[disabled], select[disabled], textarea[disabled], fieldset[disabled], [aria-disabled="true"]';

function reducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// The pointer `action-cursor` draws: an arrow in the host's page, above it and never in the way of a
// click (pointer events off), placed by its tip.
function pointer(root: Document): HTMLElement {
  const el = root.createElement("div");
  el.setAttribute("data-fazer-ai-cursor", "");
  el.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2l16 9-7 2-3 7z" fill="#111827" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(el.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "22px",
    height: "22px",
    pointerEvents: "none",
    zIndex: "2147483000",
    filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))",
  });
  return el;
}

function place(el: HTMLElement, at: { x: number; y: number }): void {
  el.style.transform = `translate(${at.x - 4}px, ${at.y - 2}px)`;
}

if (!customElements.get("fazer-ai-agent"))
  customElements.define("fazer-ai-agent", FazerAiAgent);
