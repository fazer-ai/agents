import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/client/lib/api";

// Shape of the playground response, derived from the Eden treaty (never hand-declared — see
// docs/eden-treaty.md).
type PlaygroundData = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof api.api.v1.agents>["playground"]["post"]>
  >["data"]
>;

// What a turn spent, as the provider reported it (issue #839): the same numbers as its ledger rows.
export type PlaygroundUsage = PlaygroundData["usage"];

// How long a turn took and how much of that was model time. Live turns only: the ledger keeps no
// timing, so a reopened turn and the session total carry none.
export type PlaygroundTiming = PlaygroundData["timing"];

export function addTiming(
  a: PlaygroundTiming,
  b: PlaygroundTiming | undefined,
): PlaygroundTiming {
  if (!b) return a;
  return { turnMs: a.turnMs + b.turnMs, modelMs: a.modelMs + b.modelMs };
}

export function addUsage(
  a: PlaygroundUsage,
  b: PlaygroundUsage | undefined,
): PlaygroundUsage {
  if (!b) return a;
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    cachedReadTokens: a.cachedReadTokens + b.cachedReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    byNode: Object.fromEntries(
      [...new Set([...Object.keys(a.byNode), ...Object.keys(b.byNode)])].map(
        (node) => [node, (a.byNode[node] ?? 0) + (b.byNode[node] ?? 0)],
      ),
    ),
  };
}

export const NO_USAGE: PlaygroundUsage = {
  calls: 0,
  promptTokens: 0,
  cachedReadTokens: 0,
  cacheCreationTokens: 0,
  completionTokens: 0,
  byNode: {},
};

export type PlaygroundTurn =
  | {
      role: "user";
      text: string;
      // From a recorded voice note (shows a mic icon + transcription).
      audio?: boolean;
      // Local object URL for in-session playback of the recorded note (not persisted yet).
      audioUrl?: string;
      // URL of an uploaded image/document (object URL in-session, media endpoint on reopen).
      fileUrl?: string;
      // Original file name + mime (drives the chip's extension icon and the inline-image decision on
      // reopen, where `extractKind` may be absent).
      fileName?: string;
      fileMime?: string;
      // What the vision provider extracted from the uploaded file (shown below the file, before the
      // reply). `extractKind` distinguishes a real extraction from an unsupported file.
      extracted?: string;
      extractKind?: "image" | "document" | "unsupported";
      // Optimistic bubble shown while the transcription/extraction/reply is in flight.
      pending?: boolean;
    }
  // `turnId`: the turn the failure ended, when the server named it, for the link to its lines on the
  // Logs page (issue #841).
  | { role: "error"; text: string; turnId?: string }
  | {
      role: "note";
      text: string;
      trace?: PlaygroundData["trace"];
      // A turn the guardrail emptied, or a follow-up the agent declined, still spent what it spent.
      usage?: PlaygroundUsage;
      timing?: PlaygroundTiming;
    }
  | {
      role: "assistant";
      text: string;
      followup?: boolean;
      // Object URL for a generated TTS reply (populated in the TTS phase).
      audioUrl?: string;
      trace: PlaygroundData["trace"];
      sources: PlaygroundData["sources"];
      // Absent on a reopened session's old turns: a ledger row names its thread, not its turn.
      usage?: PlaygroundUsage;
      timing?: PlaygroundTiming;
    };

// Session-history metadata, derived from the Eden treaty (list endpoint).
export type PlaygroundSessionMeta = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<typeof api.api.v1.agents>["playground"]["sessions"]["get"]
    >
  >["data"]
>["sessions"][number];

export type RecordState = "idle" | "recording" | "paused";

// Unsaved draft (the live-edit popup): non-persisted prompt/model/settings sent with each turn.
// `toolMocks` (tool name → canned result) and `promptVars` (context-var simulation) are
// playground-owned, not part of the agent form; the hook merges them in at send time.
// NOTE: the wire contract is `playgroundDraftSchema` in api/v1/agents.controller.ts, not this
// interface. Elysia normalizes the request against that schema, so a field declared only here is
// stripped before the handler runs — silently, with the turn falling back to the saved config.
export interface PlaygroundDraft {
  systemPrompt?: string;
  // The Availability picker's current value ("" = none). A scalar column like systemPrompt, so it
  // travels with the draft; empty vs absent is the difference between "no schedule" and "use the
  // saved one".
  businessHoursId?: string;
  modelConfig?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  toolMocks?: Record<string, string>;
  promptVars?: Record<string, string>;
  // Simulated "current time" (offset-less wall-clock, e.g. "2026-06-14T23:00") for the {{hora_atual}}
  // family. Blank → the real now.
  promptNow?: string;
}

// Tool metadata for the simulate-a-return panel, derived from the Eden treaty (never hand-declared).
export type PlaygroundToolInfo = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<typeof api.api.v1.agents>["playground"]["tools"]["get"]
    >
  >["data"]
>["tools"][number];

// Example values for the prompt context variables, so the playground (and the General-tab preview)
// resolve {{nome_contato}} etc. to something sensible instead of empty. Company/agent are omitted on
// purpose — the server falls back to the real tenant/agent names when they aren't overridden here.
export const DEFAULT_PLAYGROUND_PROMPT_VARS: Record<string, string> = {
  nome_contato: "Maria Silva",
  email_contato: "maria.silva@exemplo.com",
  telefone_contato: "+55 11 98888-7777",
  canal: "WhatsApp",
};

// The tool/variable simulation is operator scratch state, persisted per agent in localStorage so a
// refresh / tab switch doesn't lose it (the conversation itself lives server-side). NOT sent anywhere
// but the playground draft. Cleared by the "clear simulation" action.
const SIM_STORAGE_PREFIX = "@app:playground-sim:";

interface PersistedSim {
  toolMocks: Record<string, string>;
  promptVars: Record<string, string>;
  promptNow: string;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}

function loadSim(agentId: string): PersistedSim {
  try {
    const raw = localStorage.getItem(SIM_STORAGE_PREFIX + agentId);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedSim>;
      return {
        toolMocks: isStringRecord(p.toolMocks) ? p.toolMocks : {},
        promptVars: isStringRecord(p.promptVars)
          ? p.promptVars
          : DEFAULT_PLAYGROUND_PROMPT_VARS,
        promptNow: typeof p.promptNow === "string" ? p.promptNow : "",
      };
    }
  } catch {
    // corrupt/unavailable storage → fall back to defaults
  }
  return {
    toolMocks: {},
    promptVars: DEFAULT_PLAYGROUND_PROMPT_VARS,
    promptNow: "",
  };
}

// The one definition of what an agent turn LOOKS like, shared by every path that produces one: the
// text turn, the file turn, the voice note, the follow-up, and the reload that rebuilds them from
// the server. The rule it carries — a turn the guardrail emptied renders as a NOTE carrying the
// verdict, never as a bubble reading "(no reply)" — used to be written once per call site, and the
// two media paths were born without it (issue #136): a suppressed file turn showed an empty bubble
// live and a note after a reload. A bubble reads as the agent having had nothing to say, which is
// precisely the distinction the transcript store exists to keep.
//
// NOTE: `silent` has no reload counterpart, and that predates this hook's guardrail work: a
// follow-up the agent declined leaves an empty AI message, which the rebuild drops by design. Only
// turns the guardrail acted on get a stored note.
// The app's catch-all answer to an unhandled failure outside development (`src/app.ts`). It says
// nothing the generic sentence does not, so it is not shown as if it were the server's reason.
const UNHANDLED_PLACEHOLDER = "Something went wrong";

// What a failed playground call tells the operator (issue #841). The server's own reason when the
// call carried one: a refusal's JSON `error`, or a plain-text body, which is the unhandled failure's
// detail in development. Otherwise a sentence that says what is known and nothing more: the old one
// pointed at the model's configuration on every failure, and the failure that prompted this was a
// database error with the model configured. A call that never got an answer is a failure to reach
// the server, which is a different thing to tell the operator.
export function playgroundFailure(
  err: unknown,
  t: (key: string, fallback: string) => string,
): { text: string; turnId?: string } {
  const value =
    err && typeof err === "object"
      ? (err as { value?: unknown }).value
      : undefined;
  const body =
    value && typeof value === "object"
      ? (value as { error?: unknown; turnId?: unknown })
      : undefined;
  const plain = typeof value === "string" ? value.trim() : "";
  const reason =
    typeof body?.error === "string" && body.error
      ? body.error
      : plain && plain !== UNHANDLED_PLACEHOLDER
        ? plain
        : undefined;
  const turnId =
    typeof body?.turnId === "string" && body.turnId ? body.turnId : undefined;
  // A request that never reached the server is not an answer, even though the client hands it back
  // as one: Eden turns a failed `fetch` into an error of status 503 whose value is the fetch's own
  // TypeError (measured against a closed port), so its presence says nothing about the server.
  const answered = !!err && !(value instanceof Error);
  const text =
    reason ??
    (answered
      ? t(
          "playground.error",
          "The server answered with an error and did not say why.",
        )
      : t(
          "playground.errorUnreachable",
          "Could not reach the server. Check the connection and try again.",
        ));
  return turnId ? { text, turnId } : { text };
}

export function agentTurn(
  t: (key: string, fallback: string) => string,
  r: {
    text: string;
    // The guardrail removed a reply the agent DID write.
    suppressed?: boolean;
    // The agent itself chose to send nothing (follow-up only; no verdict to show).
    silent?: boolean;
    followup?: boolean;
    audioUrl?: string;
    trace: PlaygroundData["trace"];
    sources: PlaygroundData["sources"];
    usage?: PlaygroundUsage;
    timing?: PlaygroundTiming;
  },
): PlaygroundTurn {
  const usage = {
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.timing ? { timing: r.timing } : {}),
  };
  if (r.suppressed) {
    // A hand-over with no message to the customer empties the reply too, and it is a different
    // outcome from a suppression: the case would reach a person (issue #704). Read off the verdict,
    // which a reload restores with the turn.
    const handedOff = r.trace.some(
      (e) => e.type === "guardrail" && e.outcome === "handed-off",
    );
    return {
      role: "note",
      ...usage,
      text: handedOff
        ? t(
            "playground.handedOffNote",
            "Nothing would be sent to the customer: the guardrail would hand the case to the team.",
          )
        : t(
            "playground.suppressedNote",
            "Nothing would be sent: the guardrail acted on this turn.",
          ),
      trace: r.trace,
    };
  }
  if (r.silent) {
    return {
      role: "note",
      ...usage,
      text: t(
        "playground.followup.silent",
        "Follow-up: the agent chose not to send anything.",
      ),
    };
  }
  return {
    role: "assistant",
    text: r.text || t("playground.empty", "(no reply)"),
    ...(r.followup ? { followup: true } : {}),
    ...(r.audioUrl ? { audioUrl: r.audioUrl } : {}),
    trace: r.trace,
    sources: r.sources,
    ...usage,
  };
}

// All playground chat state + actions for ONE agent, in a single hook so the editor tab and the
// floating popup can share the SAME conversation: lift this hook into the parent (AgentEditorPage)
// and the state survives switching between them. `getDraft` (when provided) is read at send time so
// every turn tests the operator's CURRENT unsaved edits (prompt/model/settings) live.
export function usePlaygroundChat(
  agentId: string,
  notReady: boolean,
  opts: { getDraft?: () => PlaygroundDraft | undefined } = {},
) {
  const { t } = useTranslation();
  // Read the latest draft getter each render so sends always see the current form state.
  const getDraftRef = useRef<(() => PlaygroundDraft | undefined) | undefined>(
    opts.getDraft,
  );
  getDraftRef.current = opts.getDraft;
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  // The open session's total (issue #839). Always the ledger's, re-read after every turn rather than
  // grown from the replies: a turn can fail after a call it was billed for, and the ledger is the
  // one place that has it. The per-turn line comes from the reply.
  const [sessionUsage, setSessionUsage] = useState<PlaygroundUsage>(NO_USAGE);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [followingUp, setFollowingUp] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [recordStream, setRecordStream] = useState<MediaStream | null>(null);
  const [sessions, setSessions] = useState<PlaygroundSessionMeta[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  // Manual "reply with audio" toggle: forces TTS on every turn regardless of the agent's mode.
  const [forceAudio, setForceAudio] = useState(false);
  // Guardrails run by default, because the playground exists to show what the customer would get.
  // Off is for iterating on the prompt, where the screening is a model call per turn and no signal.
  const [guardrails, setGuardrails] = useState(true);
  // Tool simulation: per-tool canned results (tool name → result), merged into the draft at send
  // time. Conversation native tools are simulated server-side regardless; this overrides any tool.
  const [toolMocks, setToolMocks] = useState<Record<string, string>>(
    () => loadSim(agentId).toolMocks,
  );
  const toolMocksRef = useRef(toolMocks);
  toolMocksRef.current = toolMocks;
  // Prompt-variable simulation (context vars → values), seeded with sensible examples so the agent
  // never sees empty {{nome_contato}} etc. Merged into the draft at send time (blanks dropped).
  const [promptVars, setPromptVars] = useState<Record<string, string>>(
    () => loadSim(agentId).promptVars,
  );
  const promptVarsRef = useRef(promptVars);
  promptVarsRef.current = promptVars;
  // Simulated "current time" (offset-less wall-clock), empty by default → the real now. Merged into
  // the draft at send time, where the server interprets it in the agent's timezone.
  const [promptNow, setPromptNow] = useState(() => loadSim(agentId).promptNow);
  const promptNowRef = useRef(promptNow);
  promptNowRef.current = promptNow;

  // Reload the persisted simulation when the agent changes in place (the editor reuses this hook
  // across /agents/:id). Declared BEFORE the persist effect so a switch never writes the old agent's
  // sim under the new agent's key. Skips the initial mount (the lazy initializers already loaded it).
  const simAgentRef = useRef(agentId);
  useEffect(() => {
    if (simAgentRef.current === agentId) return;
    simAgentRef.current = agentId;
    const sim = loadSim(agentId);
    setToolMocks(sim.toolMocks);
    setPromptVars(sim.promptVars);
    setPromptNow(sim.promptNow);
  }, [agentId]);

  // Persist the simulation per agent on every change (small, synchronous; React batches keystrokes).
  useEffect(() => {
    try {
      localStorage.setItem(
        SIM_STORAGE_PREFIX + agentId,
        JSON.stringify({ toolMocks, promptVars, promptNow }),
      );
    } catch {
      // storage unavailable (private mode) → simulation just won't persist
    }
  }, [agentId, toolMocks, promptVars, promptNow]);

  // Reset the simulation to defaults and drop the persisted copy.
  const clearSimulation = useCallback(() => {
    setToolMocks({});
    setPromptVars(DEFAULT_PLAYGROUND_PROMPT_VARS);
    setPromptNow("");
    try {
      localStorage.removeItem(SIM_STORAGE_PREFIX + agentId);
    } catch {
      // ignore
    }
  }, [agentId]);
  // The agent's tools for the simulate-a-return panel (loaded lazily when the panel opens).
  const [tools, setTools] = useState<PlaygroundToolInfo[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const loadingToolsRef = useRef(false);

  const loadTools = useCallback(async () => {
    if (loadingToolsRef.current) return;
    loadingToolsRef.current = true;
    setToolsLoading(true);
    try {
      const { data } = await api.api.v1
        .agents({ id: agentId })
        .playground.tools.get();
      if (data) setTools(data.tools);
    } catch {
      // Best-effort: a load failure leaves the list empty; the panel offers a retry.
    } finally {
      loadingToolsRef.current = false;
      setToolsLoading(false);
    }
  }, [agentId]);

  // The draft sent with each turn: the live agent-form draft (prompt/model/settings) plus the
  // playground-owned toolMocks + promptVars. Stable (reads refs), so callbacks don't churn on every
  // keystroke. Blank promptVars are dropped so the server falls back to the real/empty value.
  const buildDraft = useCallback((): PlaygroundDraft | undefined => {
    const d = getDraftRef.current?.();
    const tm = toolMocksRef.current;
    const hasMocks = Object.keys(tm).length > 0;
    const pv = Object.fromEntries(
      Object.entries(promptVarsRef.current).filter(([, v]) => v.trim() !== ""),
    );
    const hasVars = Object.keys(pv).length > 0;
    const now = promptNowRef.current.trim();
    if (!d && !hasMocks && !hasVars && !now) return undefined;
    return {
      ...(d ?? {}),
      ...(hasMocks ? { toolMocks: tm } : {}),
      ...(hasVars ? { promptVars: pv } : {}),
      ...(now ? { promptNow: now } : {}),
    };
  }, []);

  // URL of a persisted media blob (cookie-authenticated, same-origin) for <audio>/replay.
  const mediaUrl = useCallback(
    (mediaId: string) =>
      `/api/v1/agents/${agentId}/playground/media/${mediaId}`,
    [agentId],
  );

  const busy = sending || followingUp || transcribing || extracting;
  const recording = recordState !== "idle";
  const hasConversation = turns.some(
    (x) => x.role === "user" || x.role === "assistant",
  );

  const threadId = useRef<string | undefined>(undefined);
  // Whether the open thread already has a saved session row. Not the same as having a thread id:
  // a file's read names the thread before any turn ran, and a turn that then fails leaves a thread
  // with no session behind it, whose first successful turn must still refresh the history list.
  const sessionSaved = useRef(false);
  // Re-reads the session's total from the ledger. Awaited inside each turn, before the chat stops
  // being busy, so the next turn cannot start between the call and the number it would change.
  const refreshSessionUsage = useCallback(async () => {
    const tid = threadId.current;
    if (!tid) return;
    try {
      const { data } = await api.api.v1
        .agents({ id: agentId })
        .playground.sessions({ threadId: tid })
        .usage.get();
      if (data?.usage && threadId.current === tid) setSessionUsage(data.usage);
    } catch {
      // The total stays as it was; the next turn re-reads it.
    }
  }, [agentId]);

  // A new session gets its thread BEFORE its first call, so a first turn that fails after being
  // billed leaves that call on the thread the session keeps, not on one only the server knew.
  const ensureThread = useCallback(async () => {
    if (threadId.current) return;
    const { data } = await api.api.v1
      .agents({ id: agentId })
      .playground.threads.post();
    if (data) threadId.current = data.threadId;
    // No thread, no turn: a call billed on a thread only the server knew is spend the session would
    // never show. The caller's catch turns this into the error bubble.
    if (!threadId.current) throw new Error("playground thread not allocated");
  }, [agentId]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Set by cancelRecording so onstop discards instead of sending. MediaRecorder.stop() fires a final
  // `dataavailable` BEFORE onstop, which would repopulate the chunks even after a cancel cleared them
  // — so an empty-blob check is not a reliable cancel guard. This flag is.
  const canceledRef = useRef(false);
  // Object URLs we created for in-session audio playback — revoked on unmount to avoid leaks.
  const objectUrlsRef = useRef<Set<string>>(new Set());

  const trackUrl = useCallback((url: string) => {
    objectUrlsRef.current.add(url);
    return url;
  }, []);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  // ---- Session history (server-side; transcript reconstructed from the checkpointer) ----
  const refreshSessions = useCallback(async () => {
    const { data } = await api.api.v1
      .agents({ id: agentId })
      .playground.sessions.get();
    if (data) setSessions(data.sessions);
  }, [agentId]);

  const loadSession = useCallback(
    async (tid: string) => {
      setLoadingSession(true);
      try {
        const { data } = await api.api.v1
          .agents({ id: agentId })
          .playground.sessions({ threadId: tid })
          .get();
        if (!data) return;
        threadId.current = tid;
        sessionSaved.current = true;
        setSessionUsage(data.usage);
        setTurns(
          data.turns.map((rt): PlaygroundTurn => {
            if (rt.role === "user") {
              const audioM = rt.media?.find((m) => m.kind === "user_audio");
              const fileM = rt.media?.find((m) => m.kind === "user_file");
              return {
                role: "user",
                text: rt.text,
                ...(rt.audio ? { audio: true } : {}),
                ...(audioM ? { audioUrl: mediaUrl(audioM.id) } : {}),
                ...(fileM ? { fileUrl: mediaUrl(fileM.id) } : {}),
                ...(fileM?.fileName ? { fileName: fileM.fileName } : {}),
                ...(fileM?.mime ? { fileMime: fileM.mime } : {}),
                ...(rt.extractKind ? { extractKind: rt.extractKind } : {}),
                ...(rt.extracted ? { extracted: rt.extracted } : {}),
              };
            }
            const ttsM = rt.media?.find((m) => m.kind === "tts_audio");
            return agentTurn(t, {
              text: rt.text,
              suppressed: rt.suppressed,
              followup: rt.followup,
              ...(ttsM ? { audioUrl: mediaUrl(ttsM.id) } : {}),
              // The ledger's rows for this turn (issue #839): the same line the turn had live, less
              // its timing, which the ledger does not keep.
              ...(rt.usage ? { usage: rt.usage } : {}),
              trace: rt.trace,
              sources: rt.sources,
            });
          }),
        );
      } finally {
        setLoadingSession(false);
      }
    },
    [agentId, mediaUrl, t],
  );

  const newSession = useCallback(() => {
    threadId.current = undefined;
    sessionSaved.current = false;
    setTurns([]);
    setSessionUsage(NO_USAGE);
  }, []);

  const deleteSession = useCallback(
    async (tid: string) => {
      await api.api.v1
        .agents({ id: agentId })
        .playground.sessions({ threadId: tid })
        .delete();
      setSessions((prev) => prev.filter((s) => s.threadId !== tid));
      if (threadId.current === tid) newSession();
    },
    [agentId, newSession],
  );

  // On mount (per agent), load history and resume the most recent session so a tab switch / reload
  // doesn't lose the conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per agent mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await api.api.v1
        .agents({ id: agentId })
        .playground.sessions.get();
      if (cancelled || !data) return;
      setSessions(data.sessions);
      const latest = data.sessions[0];
      if (latest && !cancelled) await loadSession(latest.threadId);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Failures land in the thread as an error bubble (with the server's localized message when
  // available), not as a detached generic error line.
  const pushError = useCallback(
    (err?: unknown) => {
      setTurns((prev) => [
        ...prev,
        { role: "error", ...playgroundFailure(err, t) },
      ]);
    },
    [t],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || notReady) return;
    const wasNew = !sessionSaved.current;
    setInput("");
    setTurns((prev) => [...prev, { role: "user", text }]);
    setSending(true);
    try {
      await ensureThread();
      const { data, error: err } = await api.api.v1
        .agents({ id: agentId })
        .playground.post({
          message: text,
          threadId: threadId.current,
          draft: buildDraft(),
          forceAudio,
          guardrails,
        });
      if (err || !data) {
        pushError(err);
        return;
      }
      threadId.current = data.threadId;
      sessionSaved.current = true;
      setTurns((prev) => [
        ...prev,
        agentTurn(t, {
          text: data.reply,
          suppressed: data.suppressed,
          ...(data.ttsMediaId ? { audioUrl: mediaUrl(data.ttsMediaId) } : {}),
          trace: data.trace,
          sources: data.sources,
          usage: data.usage,
          timing: data.timing,
        }),
      ]);
      // A turn on a brand-new thread created a session row — surface it in the sidebar.
      if (wasNew) void refreshSessions();
    } catch {
      pushError();
    } finally {
      await refreshSessionUsage();
      setSending(false);
    }
  }, [
    agentId,
    buildDraft,
    busy,
    forceAudio,
    guardrails,
    input,
    mediaUrl,
    notReady,
    pushError,
    refreshSessions,
    t,
    refreshSessionUsage,
    ensureThread,
  ]);

  const simulateFollowup = useCallback(async () => {
    if (busy || notReady || !hasConversation) return;
    setFollowingUp(true);
    try {
      const { data, error: err } = await api.api.v1
        .agents({ id: agentId })
        .playground.followup.post({
          threadId: threadId.current,
          draft: buildDraft(),
          guardrails,
        });
      if (err || !data) {
        pushError(err);
        return;
      }
      threadId.current = data.threadId;
      sessionSaved.current = true;
      setTurns((prev) => [
        ...prev,
        agentTurn(t, {
          text: data.reply,
          suppressed: data.suppressed,
          silent: data.silent,
          followup: true,
          trace: data.trace,
          sources: data.sources,
          usage: data.usage,
          timing: data.timing,
        }),
      ]);
    } catch {
      pushError();
    } finally {
      await refreshSessionUsage();
      setFollowingUp(false);
    }
  }, [
    agentId,
    buildDraft,
    busy,
    guardrails,
    hasConversation,
    notReady,
    pushError,
    t,
    refreshSessionUsage,
  ]);

  // Drops the pending flag on the trailing optimistic user bubble (kept, still playable) — used when
  // a step fails so the bubble stays but stops showing the "Transcribing…"/"Extracting…" state.
  const clearPendingBubble = useCallback(() => {
    setTurns((prev) =>
      prev.map((x) =>
        x.role === "user" && x.pending ? { ...x, pending: false } : x,
      ),
    );
  }, []);

  // Surfaces the extraction on the trailing pending file bubble (the content the agent will see),
  // as soon as vision returns — BEFORE the agent reply.
  const applyExtraction = useCallback(
    (extractKind: "image" | "document" | "unsupported", extracted: string) => {
      setTurns((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const turn = next[i];
          if (turn?.role === "user" && turn.pending) {
            next[i] = { ...turn, pending: false, extractKind, extracted };
            break;
          }
        }
        return next;
      });
    },
    [],
  );

  // Upload an image/document → extract (vision) → turn, in two steps so the extracted content shows
  // the moment it is ready, not bundled with the reply (mirrors the voice-note flow):
  //   1) /file/extract → kind + content (fast) → render it under the file;
  //   2) /file (with that extraction) → the agent reply. Passing the extraction back skips a second
  //      vision round trip, so step 2 isn't slowed by re-extracting.
  const sendFile = useCallback(
    async (file: File) => {
      if (notReady || busy || recording) return;
      const wasNew = !sessionSaved.current;
      const fileUrl = trackUrl(URL.createObjectURL(file));
      setTurns((prev) => [
        ...prev,
        {
          role: "user",
          text: "",
          fileUrl,
          fileName: file.name || "arquivo",
          ...(file.type ? { fileMime: file.type } : {}),
          pending: true,
        },
      ]);
      const draft = buildDraft();
      const draftStr = draft ? JSON.stringify(draft) : undefined;

      // Step 1: extract only, and surface the extracted content right away.
      let kind: "image" | "document" | "unsupported";
      let extracted: string;
      let extractUsage: PlaygroundUsage | undefined;
      let extractTiming: PlaygroundTiming | undefined;
      let readTurnId: string | undefined;
      setExtracting(true);
      try {
        await ensureThread();
        const { data, error: err } = await api.api.v1
          .agents({ id: agentId })
          .playground.file.extract.post({
            file,
            threadId: threadId.current,
            draft: draftStr,
          });
        if (err || !data) {
          clearPendingBubble();
          pushError(err);
          return;
        }
        kind = data.kind;
        extracted = data.extracted;
        // The read is billed to the session it is sent into, so the turn below runs on the thread
        // the extraction named, and its line counts the read with the reply (issue #839).
        threadId.current = data.threadId;
        extractUsage = data.usage;
        extractTiming = data.timing;
        readTurnId = data.turnId;
        applyExtraction(kind, extracted);
      } catch {
        clearPendingBubble();
        pushError();
        return;
      } finally {
        // A read billed and then lost still belongs to the session's total.
        await refreshSessionUsage();
        setExtracting(false);
      }

      // Step 2: run the turn reusing the extraction (no second vision call) → the agent reply.
      setSending(true);
      try {
        const { data, error: err } = await api.api.v1
          .agents({ id: agentId })
          .playground.file.post({
            file,
            threadId: threadId.current,
            draft: draftStr,
            forceAudio: forceAudio ? "true" : undefined,
            guardrails: guardrails ? undefined : "false",
            kind,
            // JSON-encoded: a `{`/`[`-leading extraction would otherwise be auto-parsed by the
            // multipart layer (see the controller's decodeMultipartText).
            extracted: JSON.stringify(extracted),
            // The read's id, so the ledger keeps the read and the reply as one turn and a reopened
            // session shows them on one line, as here.
            turnId: readTurnId,
          });
        if (err || !data) {
          pushError(err);
          return;
        }
        threadId.current = data.threadId;
        sessionSaved.current = true;
        setTurns((prev) => [
          ...prev,
          agentTurn(t, {
            text: data.reply,
            suppressed: data.suppressed,
            ...(data.ttsMediaId ? { audioUrl: mediaUrl(data.ttsMediaId) } : {}),
            trace: data.trace,
            sources: data.sources,
            usage: addUsage(data.usage, extractUsage),
            timing: addTiming(data.timing, extractTiming),
          }),
        ]);
        if (wasNew) void refreshSessions();
      } catch {
        pushError();
      } finally {
        await refreshSessionUsage();
        setSending(false);
      }
    },
    [
      agentId,
      applyExtraction,
      buildDraft,
      busy,
      clearPendingBubble,
      forceAudio,
      guardrails,
      mediaUrl,
      notReady,
      pushError,
      recording,
      refreshSessions,
      t,
      trackUrl,
      refreshSessionUsage,
      ensureThread,
    ],
  );

  // ---- Recording (mic → transcribe → turn) ----
  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setRecordStream(null);
  }, []);

  // Replaces the trailing optimistic (pending) user bubble's placeholder with the transcription,
  // as soon as STT returns — BEFORE the agent reply, so the operator sees what was understood.
  const applyTranscription = useCallback(
    (transcription: string) => {
      setTurns((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const turn = next[i];
          if (turn?.role === "user" && turn.pending) {
            next[i] = {
              ...turn,
              text:
                transcription ||
                t("playground.audio.empty", "(no speech detected)"),
              pending: false,
            };
            break;
          }
        }
        return next;
      });
    },
    [t],
  );

  // Two steps so the transcription shows the moment it is ready, not bundled with the reply:
  //   1) /audio/transcribe → transcription (fast) → render it immediately;
  //   2) /audio (with that transcription) → the agent reply. Passing the transcription back skips a
  //      second STT round trip, so step 2 isn't slowed by re-transcribing.
  const sendRecording = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) return;
      const wasNew = !sessionSaved.current;
      const audioUrl = trackUrl(URL.createObjectURL(blob));
      // Optimistic bubble: the voice note appears immediately (playable) while transcription runs.
      setTurns((prev) => [
        ...prev,
        { role: "user", text: "", audio: true, audioUrl, pending: true },
      ]);
      const file = new File([blob], `recording.${recordingExt(blob.type)}`, {
        type: blob.type || "audio/webm",
      });
      const draft = buildDraft();
      // The draft rides multipart as a JSON string (objects can't be multipart fields).
      const draftStr = draft ? JSON.stringify(draft) : undefined;

      // Step 1: transcribe only, and surface the transcription right away.
      let transcription: string;
      setTranscribing(true);
      try {
        const { data, error: err } = await api.api.v1
          .agents({ id: agentId })
          .playground.audio.transcribe.post({ file, draft: draftStr });
        if (err || !data) {
          clearPendingBubble();
          pushError(err);
          return;
        }
        transcription = data.transcription;
        applyTranscription(transcription);
      } catch {
        clearPendingBubble();
        pushError();
        return;
      } finally {
        setTranscribing(false);
      }

      // Step 2: run the turn reusing the transcription (no second STT) → the agent reply.
      setSending(true);
      try {
        await ensureThread();
        const { data, error: err } = await api.api.v1
          .agents({ id: agentId })
          .playground.audio.post({
            file,
            threadId: threadId.current,
            draft: draftStr,
            forceAudio: forceAudio ? "true" : undefined,
            guardrails: guardrails ? undefined : "false",
            // JSON-encoded: a `{`/`[`-leading transcription would otherwise be auto-parsed by the
            // multipart layer (see the controller's parseTranscription).
            transcription: JSON.stringify(transcription),
          });
        if (err || !data) {
          pushError(err);
          return;
        }
        threadId.current = data.threadId;
        sessionSaved.current = true;
        setTurns((prev) => [
          ...prev,
          agentTurn(t, {
            text: data.reply,
            suppressed: data.suppressed,
            ...(data.ttsMediaId ? { audioUrl: mediaUrl(data.ttsMediaId) } : {}),
            trace: data.trace,
            sources: data.sources,
            usage: data.usage,
            timing: data.timing,
          }),
        ]);
        if (wasNew) void refreshSessions();
      } catch {
        pushError();
      } finally {
        await refreshSessionUsage();
        setSending(false);
      }
    },
    [
      agentId,
      applyTranscription,
      buildDraft,
      clearPendingBubble,
      forceAudio,
      guardrails,
      mediaUrl,
      pushError,
      refreshSessions,
      t,
      trackUrl,
      refreshSessionUsage,
      ensureThread,
    ],
  );

  const startRecording = useCallback(async () => {
    if (busy || recording || notReady) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setTurns((prev) => [
        ...prev,
        {
          role: "error",
          text: t(
            "playground.audio.micDenied",
            "Could not access the microphone. Check the browser permission.",
          ),
        },
      ]);
      return;
    }
    streamRef.current = stream;
    setRecordStream(stream);
    audioChunksRef.current = [];
    canceledRef.current = false;
    const rec = new MediaRecorder(stream);
    mediaRecorderRef.current = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
    };
    rec.onstop = () => {
      releaseStream();
      // A cancel set canceledRef before stop(): discard the recording (don't transcribe/send),
      // even though stop()'s trailing dataavailable repopulated the chunks.
      if (canceledRef.current) {
        canceledRef.current = false;
        audioChunksRef.current = [];
        return;
      }
      const blob = new Blob(audioChunksRef.current, {
        type: rec.mimeType || "audio/webm",
      });
      void sendRecording(blob);
    };
    rec.start();
    setRecordState("recording");
  }, [busy, notReady, recording, releaseStream, sendRecording, t]);

  const pauseRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") {
      rec.pause();
      setRecordState("paused");
    }
  }, []);

  const resumeRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "paused") {
      rec.resume();
      setRecordState("recording");
    }
  }, []);

  const stopRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop(); // → onstop → sendRecording
    setRecordState("idle");
  }, []);

  // Cancel: discard the recording without transcribing. Sets canceledRef so onstop drops the blob
  // (the size-0 trick is unreliable — stop() fires a final dataavailable that repopulates chunks).
  const cancelRecording = useCallback(() => {
    const rec = mediaRecorderRef.current;
    canceledRef.current = true;
    if (rec && rec.state !== "inactive") rec.stop();
    else releaseStream();
    setRecordState("idle");
  }, [releaseStream]);

  return {
    // state
    turns,
    sessionUsage,
    input,
    setInput,
    sending,
    followingUp,
    transcribing,
    busy,
    recordState,
    recording,
    recordStream,
    sessions,
    loadingSession,
    hasConversation,
    currentThreadId: threadId.current,
    forceAudio,
    setForceAudio,
    guardrails,
    setGuardrails,
    toolMocks,
    setToolMocks,
    promptVars,
    setPromptVars,
    promptNow,
    setPromptNow,
    clearSimulation,
    tools,
    toolsLoading,
    // actions
    loadTools,
    send,
    sendFile,
    simulateFollowup,
    refreshSessions,
    loadSession,
    newSession,
    deleteSession,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
  };
}

// Map a MediaRecorder mime to a file extension for the upload. webm is checked first: Chrome
// reports `audio/webm;codecs=opus`, which also matches "opus" — the container wins.
export function recordingExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "webm";
}
