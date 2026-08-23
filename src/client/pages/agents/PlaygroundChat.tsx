import {
  AlertTriangle,
  Bell,
  BookText,
  Braces,
  Clock,
  Eraser,
  Eye,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Info,
  Mic,
  Paperclip,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Button,
  Input,
  Markdown,
  MediaAudio,
  MediaImage,
  Skeleton,
  SwitchField,
  Textarea,
  Tooltip,
} from "@/client/components";
import {
  ConfirmDialog,
  type ConfirmPayload,
} from "@/client/components/ConfirmDialog";
import { useModalController } from "@/client/components/Modal";
import { useMediaObjectUrl } from "@/client/components/useMediaObjectUrl";
import { cn } from "@/client/lib/utils";
import { useKnowledgeManager } from "@/client/pages/resources/useKnowledgeManager";
import type {
  PlaygroundSessionMeta,
  PlaygroundTurn,
  RecordState,
  usePlaygroundChat,
} from "./usePlaygroundChat";
import { DEFAULT_PLAYGROUND_PROMPT_VARS } from "./usePlaygroundChat";

type Chat = ReturnType<typeof usePlaygroundChat>;
type TraceEntry = Extract<
  PlaygroundTurn,
  { role: "assistant" }
>["trace"][number];

// t('playground.missing.provider', 'Provider')
// t('playground.missing.model', 'Model')
// t('playground.missing.credential', 'API key')
const MISSING_LABEL_KEYS: Record<string, string> = {
  provider: "playground.missing.provider",
  model: "playground.missing.model",
  credential: "playground.missing.credential",
};

// Per-capability readiness for the composer. Each multimodal feature has its own credential, so a
// configured model (the global `missingConfig`) is not enough: audio in needs STT, audio out needs
// TTS, attachments need vision. An unmet capability disables only its control (with a reason),
// instead of failing server-side ("speech-to-text is not configured").
export type PlaygroundCapabilities = {
  audioInput: boolean; // STT → record/send voice notes
  audioReply: boolean; // TTS → "reply with audio"
  fileInput: boolean; // vision → attach image/document
  guardrails: boolean; // moderation → screen the turn like the inbox does
};

// Wraps a control in a hover tooltip explaining WHY it is disabled. A disabled <button> emits no
// pointer events, so the tooltip would never fire on it directly — the <span> trigger does.
function Gated({
  reason,
  label,
  children,
}: {
  reason?: string;
  label?: string;
  children: ReactElement;
}) {
  // Tooltip shows the gating reason when blocked, otherwise the action label.
  const content = reason ?? label;
  if (!content) return children;
  return (
    <Tooltip content={content}>
      <span className="inline-flex">{children}</span>
    </Tooltip>
  );
}

// The reusable playground console: a session sidebar + a chat column (messages + composer). Both
// the editor's Playground tab and the floating popup render this over the SAME `chat` hook value,
// so the conversation is shared. `showSidebar` lets the compact popup hide the session list.
export function PlaygroundChat({
  chat,
  agentId,
  missingConfig,
  capabilities,
  toolsDirty,
  showSidebar = true,
  heightClass = "h-[72dvh]",
  bare = false,
}: {
  chat: Chat;
  agentId: string;
  missingConfig: string[];
  capabilities: PlaygroundCapabilities;
  // The playground tests prompt/model/settings LIVE (draft override), but NOT tool grants — so the
  // only "unsaved" caveat is pending tool/knowledge changes.
  toolsDirty: boolean;
  showSidebar?: boolean;
  heightClass?: string;
  // When embedded (e.g. the popup), drop the outer border/bg so the host frame owns the chrome.
  bare?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notReady = missingConfig.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Read-only access to KB documents so a grounding source in the trace can open the exact document
  // or its base without leaving the playground (onChanged is a no-op — we only preview here).
  const km = useKnowledgeManager({ onChanged: () => {} });
  const confirm = useModalController<ConfirmPayload>();

  // Keep the latest turn in view as the conversation grows / the agent answers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every turn/typing change
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.turns, chat.busy]);

  return (
    <>
      <div
        className={cn(
          "flex overflow-hidden",
          bare
            ? "h-full"
            : cn(
                "rounded-lg border border-border bg-bg-secondary",
                heightClass,
              ),
        )}
      >
        {showSidebar && (
          <PlaygroundSessionsSidebar
            sessions={chat.sessions}
            currentThreadId={chat.currentThreadId}
            disabled={chat.busy || chat.recording}
            hasTurns={chat.turns.length > 0}
            onNew={chat.newSession}
            onPick={(tid) => void chat.loadSession(tid)}
            onDelete={(tid) =>
              confirm.open({
                title: t("playground.deleteSessionTitle", "Delete session"),
                message: t(
                  "playground.deleteSessionMessage",
                  "This deletes the saved session and its transcript. This cannot be undone.",
                ),
                danger: true,
                onConfirm: () => chat.deleteSession(tid),
              })
            }
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b px-3 py-2">
            <p className="text-text-secondary text-xs">
              {t("playground.hint", "Tests your live (unsaved) edits.")}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <SwitchField
                checked={chat.guardrails && capabilities.guardrails}
                onCheckedChange={chat.setGuardrails}
                disabled={!capabilities.guardrails}
                label={
                  capabilities.guardrails ? (
                    <span className="inline-flex items-center gap-1">
                      {t("playground.guardrails", "Run guardrails")}
                      <Tooltip
                        content={t(
                          "playground.guardrailsHint",
                          "Screens the message and the reply exactly as the inbox does, so you read what the customer would receive. Costs one extra model call per direction, plus one more when answer relevance runs alongside another reply check.",
                        )}
                      />
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {t("playground.guardrails", "Run guardrails")}
                      <Tooltip
                        content={t(
                          "playground.guardrailsUnavailable",
                          "Guardrails are off or have no credential. Configure them in the Guardrails tab to screen playground turns.",
                        )}
                      />
                    </span>
                  )
                }
              />
              <SwitchField
                checked={chat.forceAudio && capabilities.audioReply}
                onCheckedChange={chat.setForceAudio}
                disabled={!capabilities.audioReply}
                label={
                  capabilities.audioReply ? (
                    t("playground.replyWithAudio", "Reply with audio")
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {t("playground.replyWithAudio", "Reply with audio")}
                      <Tooltip
                        content={t(
                          "playground.audioReplyUnavailable",
                          "Text-to-speech is not configured. Set a provider and API key in the Behavior tab to reply with audio.",
                        )}
                      />
                    </span>
                  )
                }
              />
              <Tooltip
                content={t(
                  "playground.followup.hint",
                  "Trigger the proactive follow-up now, without waiting for the inactivity window.",
                )}
              >
                <span className="inline-flex">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void chat.simulateFollowup()}
                    loading={chat.followingUp}
                    disabled={notReady || chat.busy || !chat.hasConversation}
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    {t("playground.followup.button", "Simulate follow-up")}
                  </Button>
                </span>
              </Tooltip>
            </div>
          </div>

          {notReady && (
            <div className="m-3 flex flex-col items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              <span className="flex items-center gap-1.5 font-medium text-warning">
                <AlertTriangle
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                {t("playground.notReadyTitle", "Missing configuration")}
              </span>
              <p className="text-text-secondary">
                {t(
                  "playground.notReadyDesc",
                  "Set up the model before testing this agent:",
                )}
              </p>
              <ul className="list-inside list-disc text-text-secondary">
                {missingConfig.map((m) => (
                  <li key={m}>
                    {/* biome-ignore lint/plugin/no-dynamic-i18n-key: fixed set in MISSING_LABEL_KEYS */}
                    {MISSING_LABEL_KEYS[m] ? t(MISSING_LABEL_KEYS[m]) : m}
                  </li>
                ))}
              </ul>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/agents/${agentId}/general`)}
              >
                <Settings2 className="h-4 w-4" aria-hidden="true" />
                {t("playground.goToGeneral", "Go to General")}
              </Button>
            </div>
          )}

          {!notReady && toolsDirty && (
            <div className="mx-3 mt-3 flex items-center gap-1.5 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-text-muted text-xs">
              <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t(
                "playground.toolsDirtyNote",
                "Prompt and model changes are tested live. Tool changes need saving first.",
              )}
            </div>
          )}

          {!notReady && <ToolSimPanel chat={chat} />}

          {!notReady && <PromptVarsPanel chat={chat} />}

          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3"
            aria-live="polite"
          >
            {chat.loadingSession ? (
              <PlaygroundSkeleton />
            ) : (
              <>
                {chat.turns.length === 0 && !chat.busy && (
                  <p className="m-auto text-sm text-text-muted">
                    {t(
                      "playground.placeholder",
                      "Send a message to start testing.",
                    )}
                  </p>
                )}
                {chat.turns.map((turn, i) => (
                  <TurnBubble
                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only chat log, never reordered
                    key={i}
                    turn={turn}
                    onOpenDoc={km.openDocPreview}
                    onOpenKb={km.openDocs}
                  />
                ))}
                {chat.busy && <TypingIndicator />}
              </>
            )}
          </div>

          <Composer
            chat={chat}
            notReady={notReady}
            capabilities={capabilities}
          />
        </div>
      </div>
      {km.modals}
      <ConfirmDialog modal={confirm} />
    </>
  );
}

// Category label keys (a fixed set, so the dynamic lookup is safe):
// t('playground.toolsim.cat.native','Native')
// t('playground.toolsim.cat.utility','Utility')
// t('playground.toolsim.cat.knowledge','Knowledge')
// t('playground.toolsim.cat.http','HTTP')
// t('playground.toolsim.cat.mcp','MCP')
// t('playground.toolsim.cat.integration','Integration')
// t('playground.toolsim.cat.external','External')

// One tool row: its name + category badge + (for conversation natives) the auto-simulated
// marker, and a textarea to force a canned return. A blank textarea means "no mock" (the tool runs
// for real, or is auto-simulated); typing a value overrides its result.
type ToolInfo = Chat["tools"][number];
function ToolMockRow({
  tool,
  value,
  onChange,
}: {
  tool: ToolInfo;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-bg-secondary/50 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium font-mono text-text-primary">
          {tool.name}
        </span>
        <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">
          {/* biome-ignore lint/plugin/no-dynamic-i18n-key: category is a fixed set declared above. */}
          {t(`playground.toolsim.cat.${tool.category}`, tool.category)}
        </span>
        {tool.simulated && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
            {t("playground.toolsim.auto", "auto-simulated")}
          </span>
        )}
      </div>
      {tool.description && (
        <p className="text-text-muted">{tool.description}</p>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(
          "playground.toolsim.result",
          "Mocked result returned to the agent",
        )}
        rows={2}
        className="text-xs"
      />
    </div>
  );
}

// Tool simulation panel: auto-lists the agent's tools (loaded lazily on open) so the operator can
// force any tool's return without typing names by hand. Conversation natives are auto-simulated;
// every other tool runs for real unless a mock is supplied. Edits the shared `chat.toolMocks`.
function ToolSimPanel({ chat }: { chat: Chat }) {
  const { t } = useTranslation();
  const loadedOnceRef = useRef(false);

  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && !loadedOnceRef.current) {
      loadedOnceRef.current = true;
      void chat.loadTools();
    }
  };

  const setMock = (name: string, value: string) => {
    const next = { ...chat.toolMocks };
    if (value.trim() === "") delete next[name];
    else next[name] = value;
    chat.setToolMocks(next);
  };

  // Mocks whose tool isn't in the listed set (e.g. an MCP tool that failed to load) — still editable.
  const listed = new Set(chat.tools.map((tl) => tl.name));
  const extraMocks = Object.keys(chat.toolMocks).filter((n) => !listed.has(n));
  const count = Object.keys(chat.toolMocks).length;
  // Anything non-default to clear: a mock, a simulated time, or edited prompt variables.
  const hasSim =
    count > 0 ||
    chat.promptNow.trim() !== "" ||
    JSON.stringify(chat.promptVars) !==
      JSON.stringify(DEFAULT_PLAYGROUND_PROMPT_VARS);

  return (
    <details
      className="mx-3 mt-3 rounded-md border border-border bg-bg-tertiary text-xs"
      onToggle={onToggle}
    >
      <summary className="flex select-none items-center gap-1.5 px-3 py-2 text-text-secondary">
        <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("playground.toolsim.title", "Tool simulation")}
        {count > 0 && (
          <span className="rounded-full bg-accent/20 px-1.5 text-[10px] text-accent">
            {count}
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-2 border-border border-t p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-text-muted">
            {t(
              "playground.toolsim.note",
              "Conversation tools (handoff, resolve, …) are simulated automatically — they never touch a real conversation here. Add a mocked return to force any tool's result.",
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {hasSim && (
              <button
                type="button"
                onClick={chat.clearSimulation}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
              >
                <Eraser className="h-3 w-3" aria-hidden="true" />
                {t("playground.toolsim.clear", "Clear simulation")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void chat.loadTools()}
              disabled={chat.toolsLoading}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              <RefreshCw
                className={cn("h-3 w-3", { "animate-spin": chat.toolsLoading })}
                aria-hidden="true"
              />
              {t("common.refresh", "Refresh")}
            </button>
          </div>
        </div>
        <div className="flex max-h-[40dvh] flex-col gap-2 overflow-y-auto overscroll-contain pr-0.5">
          {chat.toolsLoading && chat.tools.length === 0 ? (
            <div className="flex flex-col gap-2" role="status">
              <span className="sr-only">{t("common.loading", "Loading…")}</span>
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-16 w-full rounded-md" />
            </div>
          ) : chat.tools.length === 0 && extraMocks.length === 0 ? (
            <p className="text-text-muted">
              {t(
                "playground.toolsim.none",
                "This agent has no tools to simulate.",
              )}
            </p>
          ) : (
            <>
              {chat.tools.map((tl) => (
                <ToolMockRow
                  key={tl.name}
                  tool={tl}
                  value={chat.toolMocks[tl.name] ?? ""}
                  onChange={(v) => setMock(tl.name, v)}
                />
              ))}
              {extraMocks.map((n) => (
                <ToolMockRow
                  key={n}
                  tool={{
                    name: n,
                    description: "",
                    category: "external",
                    simulated: false,
                  }}
                  value={chat.toolMocks[n] ?? ""}
                  onChange={(v) => setMock(n, v)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </details>
  );
}

// Editable simulated values for the prompt's context variables, so the playground never feeds the
// agent an empty {{nome_contato}} etc. Edits the shared `chat.promptVars`, merged into the draft at
// send time (blanks dropped → the server falls back to the real value). The General-tab preview
// reads the same `chat.promptVars`, so preview and playground agree.
const PROMPT_VAR_FIELDS = [
  "nome_contato",
  "email_contato",
  "telefone_contato",
  "canal",
  "nome_empresa",
  "nome_agente",
] as const;
function PromptVarsPanel({ chat }: { chat: Chat }) {
  const { t } = useTranslation();
  const setVar = (name: string, value: string) =>
    chat.setPromptVars({ ...chat.promptVars, [name]: value });
  const count =
    Object.values(chat.promptVars).filter((v) => v.trim() !== "").length +
    (chat.promptNow.trim() ? 1 : 0);
  return (
    <details className="mx-3 mt-3 rounded-md border border-border bg-bg-tertiary text-xs">
      <summary className="flex select-none items-center gap-1.5 px-3 py-2 text-text-secondary">
        <Braces className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("playground.promptvars.title", "Prompt variables")}
        {count > 0 && (
          <span className="rounded-full bg-accent/20 px-1.5 text-[10px] text-accent">
            {count}
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-2 border-border border-t p-3">
        {/* Special field: a single simulated "current time" that drives the whole {{hora_atual}}
            family. Kept above (and outside) the scrollable context-var list so it stays visible. */}
        <div className="flex flex-col gap-1 rounded-md border border-border bg-bg-secondary/50 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-medium text-text-secondary">
              <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t("playground.promptvars.timeTitle", "Simulated current time")}
            </span>
            {chat.promptNow.trim() && (
              <button
                type="button"
                onClick={() => chat.setPromptNow("")}
                className="shrink-0 rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
              >
                {t("playground.promptvars.timeReset", "Use real time")}
              </button>
            )}
          </div>
          <Input
            type="datetime-local"
            aria-label={t(
              "playground.promptvars.timeTitle",
              "Simulated current time",
            )}
            value={chat.promptNow}
            onChange={(e) => chat.setPromptNow(e.target.value)}
            className="h-7 text-xs"
          />
          <p className="text-text-muted">
            {t(
              "playground.promptvars.timeNote",
              "Sets the time for the date/time variables (hora_atual, data_atual, …), in the agent's timezone. Leave blank to use the real time.",
            )}
          </p>
        </div>
        <p className="text-text-muted">
          {t(
            "playground.promptvars.note",
            "Simulated values for the prompt's context variables. Leave company/agent blank to use the real ones.",
          )}
        </p>
        <div className="flex max-h-[40dvh] flex-col gap-2 overflow-y-auto overscroll-contain pr-0.5">
          {PROMPT_VAR_FIELDS.map((name) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-36 shrink-0 truncate font-mono text-text-muted">
                {`{{${name}}}`}
              </span>
              <Input
                aria-label={`{{${name}}}`}
                value={chat.promptVars[name] ?? ""}
                onChange={(e) => setVar(name, e.target.value)}
                placeholder={
                  name === "nome_empresa" || name === "nome_agente"
                    ? t("playground.promptvars.realPlaceholder", "Real value")
                    : undefined
                }
                className="h-7 flex-1 text-xs"
              />
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function TypingIndicator() {
  const { t } = useTranslation();
  return (
    <div
      className="typing-dots flex items-center gap-1 self-start rounded-lg bg-bg-tertiary px-3.5 py-3"
      role="status"
      aria-label={t("playground.thinking", "Thinking…")}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
      <span className="h-1.5 w-1.5 rounded-full bg-text-muted" />
    </div>
  );
}

const SKELETON_ROWS = [
  { side: "start", w: "w-48" },
  { side: "end", w: "w-32" },
  { side: "start", w: "w-56" },
] as const;

function PlaygroundSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" role="status">
      <span className="sr-only">{t("common.loading", "Loading…")}</span>
      {SKELETON_ROWS.map((row) => (
        <Skeleton
          key={`${row.side}-${row.w}`}
          className={cn(
            "h-10 rounded-lg",
            row.w,
            row.side === "end" ? "self-end" : "self-start",
          )}
        />
      ))}
    </div>
  );
}

function TurnBubble({
  turn,
  onOpenDoc,
  onOpenKb,
}: {
  turn: PlaygroundTurn;
  onOpenDoc: (doc: { id: string; title: string }) => void;
  onOpenKb: (kb: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  if (turn.role === "note") {
    // A note the guardrail produced carries the verdict that explains it. Rendered inline rather
    // than behind the "Execution details" disclosure, which belongs to a reply that exists.
    const verdicts = (turn.trace ?? []).filter((e) => e.type === "guardrail");
    return (
      <div className="flex w-full flex-col items-center gap-1">
        <p className="self-center px-2 text-center text-text-muted text-xs italic">
          {turn.text}
        </p>
        {verdicts.length > 0 && (
          <div className="flex w-full max-w-[85%] flex-col gap-1 text-xs">
            {verdicts.map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered, immutable trace
              <TraceRow key={i} entry={entry} />
            ))}
          </div>
        )}
      </div>
    );
  }
  // A user-uploaded file renders OUTSIDE the chat bubble: an inline image thumbnail or a file chip,
  // with the extracted content shown below it (always visible). Audio/text use the bubble.
  const userFile = turn.role === "user" && !!turn.fileUrl;
  return (
    <div
      className={cn(
        "flex max-w-[85%] flex-col gap-1",
        turn.role === "user" ? "items-end self-end" : "self-start",
      )}
    >
      {turn.role === "assistant" && turn.followup && (
        <span className="flex items-center gap-1 text-text-muted text-xs">
          <Bell className="h-3 w-3" aria-hidden="true" />
          {t("playground.followup.badge", "Simulated follow-up")}
        </span>
      )}
      {userFile ? (
        <UserFile turn={turn} />
      ) : (
        <div
          className={cn("rounded-lg px-3 py-2 text-sm", {
            "bg-accent text-accent-foreground": turn.role === "user",
            "bg-bg-tertiary text-text-primary": turn.role === "assistant",
            "border border-error/40 bg-error/10 text-error":
              turn.role === "error",
          })}
        >
          {turn.role === "error" && (
            <AlertTriangle
              className="mr-1.5 inline-block h-3.5 w-3.5 align-[-2px]"
              aria-hidden="true"
            />
          )}
          {turn.role === "assistant" ? (
            turn.text ? (
              <Markdown>{turn.text}</Markdown>
            ) : null
          ) : turn.role === "user" ? (
            <div className="flex flex-col gap-1.5">
              {turn.audioUrl && <MediaAudio src={turn.audioUrl} />}
              {(turn.text || turn.pending) && (
                <span className="whitespace-pre-wrap">
                  {turn.audio && (
                    <Mic
                      className="mr-1.5 inline-block h-3.5 w-3.5 align-[-2px]"
                      aria-hidden="true"
                    />
                  )}
                  {turn.pending
                    ? t("playground.audio.transcribing", "Transcribing…")
                    : turn.text}
                </span>
              )}
            </div>
          ) : (
            <span className="whitespace-pre-wrap">{turn.text}</span>
          )}
        </div>
      )}
      {userFile && <FileExtraction turn={turn} />}
      {turn.role === "assistant" && turn.audioUrl && (
        <MediaAudio src={turn.audioUrl} />
      )}
      {turn.role === "assistant" && (
        <TracePanel turn={turn} onOpenDoc={onOpenDoc} onOpenKb={onOpenKb} />
      )}
    </div>
  );
}

// Picks a lucide glyph for a file chip from its extension (documents vs spreadsheets vs generic).
function FileTypeIcon({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  const ext = (name?.split(".").pop() ?? "").toLowerCase();
  if (["pdf", "doc", "docx", "txt", "rtf", "odt", "md", "pages"].includes(ext))
    return <FileText className={className} aria-hidden="true" />;
  if (["xls", "xlsx", "csv", "ods", "tsv", "numbers"].includes(ext))
    return <FileSpreadsheet className={className} aria-hidden="true" />;
  return <FileIcon className={className} aria-hidden="true" />;
}

// A user-uploaded file: an inline image thumbnail (an image the agent "saw") or a file chip with an
// extension icon + name. Clicking opens the original in a new tab.
function UserFile({
  turn,
}: {
  turn: Extract<PlaygroundTurn, { role: "user" }>;
}) {
  const { t } = useTranslation();
  if (!turn.fileUrl) return null;
  const isImage =
    turn.extractKind === "image" || !!turn.fileMime?.startsWith("image/");
  if (isImage) {
    return (
      <MediaImage
        src={turn.fileUrl}
        alt={turn.fileName || t("playground.attachedImage", "Attached image")}
      />
    );
  }
  return <UserFileChip src={turn.fileUrl} fileName={turn.fileName} />;
}

// A non-image upload: a chip with an extension icon + name. The href opens the file's blob in a new
// tab (fetched WITH the tenant header, like the rest of the playground media) — a raw href to the
// endpoint would 401/tenant-fail for a SUPER_ADMIN. Until the blob resolves, the chip is shown
// non-clickable (the label is still useful).
function UserFileChip({ src, fileName }: { src: string; fileName?: string }) {
  const { t } = useTranslation();
  const { url } = useMediaObjectUrl(src);
  const cls =
    "inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary";
  const inner = (
    <>
      <FileTypeIcon
        name={fileName}
        className="h-4 w-4 shrink-0 text-text-secondary"
      />
      <span className="truncate">
        {fileName || t("playground.attachedFile", "Attached file")}
      </span>
    </>
  );
  if (!url) return <span className={cn(cls, "opacity-80")}>{inner}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  );
}

// The content the vision provider extracted from an uploaded file, shown below the file (image or
// chip) the moment it is ready (before the agent reply) so the operator sees exactly what the agent
// receives. Always visible (no <details>), capped with a scroll for long extractions — mirrors how a
// voice-note transcription is shown.
function FileExtraction({
  turn,
}: {
  turn: Extract<PlaygroundTurn, { role: "user" }>;
}) {
  const { t } = useTranslation();
  if (turn.pending) {
    return (
      <span className="text-text-muted text-xs">
        {t("playground.file.extracting", "Extracting…")}
      </span>
    );
  }
  if (turn.extractKind === "unsupported") {
    return (
      <span className="text-text-muted text-xs italic">
        {t(
          "playground.file.unsupported",
          "Content could not be extracted from this file.",
        )}
      </span>
    );
  }
  if (!turn.extracted) return null;
  return (
    <div className="w-full max-w-full rounded-md border border-border bg-bg-secondary/50 text-xs">
      <p className="select-none px-2 pt-1.5 font-medium text-text-muted">
        {t("playground.file.extracted", "Extracted content")}
      </p>
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap px-2 pb-1.5 text-text-secondary">
        {turn.extracted}
      </pre>
    </div>
  );
}

function Composer({
  chat,
  notReady,
  capabilities,
}: {
  chat: Chat;
  notReady: boolean;
  capabilities: PlaygroundCapabilities;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Reason shown when a multimodal control is disabled for missing config (not the global model
  // gate, which already shows the banner + disables everything). undefined ⇒ control is available.
  const fileReason =
    !notReady && !capabilities.fileInput
      ? t(
          "playground.fileInputUnavailable",
          "Image/document reading is not configured. Set a provider and API key in the Behavior tab to attach files.",
        )
      : undefined;
  const audioReason =
    !notReady && !capabilities.audioInput
      ? t(
          "playground.audioInputUnavailable",
          "Speech-to-text is not configured. Set a provider and API key in the Behavior tab to send voice notes.",
        )
      : undefined;
  const attachLabel = t("playground.attachFile", "Attach an image or document");
  const recordLabel = t("playground.audio.record", "Record a voice note");
  if (chat.recording && chat.recordStream) {
    return (
      <div className="border-border border-t p-3">
        <RecordingBar
          stream={chat.recordStream}
          recordState={chat.recordState}
          onPause={chat.pauseRecording}
          onResume={chat.resumeRecording}
          onCancel={chat.cancelRecording}
          onStop={chat.stopRecording}
        />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-border border-t p-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void chat.sendFile(file);
        }}
      />
      <Gated reason={fileReason} label={attachLabel}>
        <Button
          variant="secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={notReady || chat.busy || !capabilities.fileInput}
          aria-label={fileReason ?? attachLabel}
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
        </Button>
      </Gated>
      <Gated reason={audioReason} label={recordLabel}>
        <Button
          variant="secondary"
          onClick={() => void chat.startRecording()}
          loading={chat.transcribing}
          disabled={notReady || chat.busy || !capabilities.audioInput}
          aria-label={audioReason ?? recordLabel}
        >
          <Mic className="h-4 w-4" aria-hidden="true" />
        </Button>
      </Gated>
      <Input
        value={chat.input}
        onChange={(e) => chat.setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void chat.send();
          }
        }}
        placeholder={t("playground.input", "Type a message…")}
        disabled={notReady}
      />
      <Button
        onClick={() => void chat.send()}
        loading={chat.sending}
        disabled={!chat.input.trim() || chat.busy || notReady}
      >
        <Send className="h-4 w-4" aria-hidden="true" />
        {t("playground.send", "Send")}
      </Button>
    </div>
  );
}

// The recording bar replaces the text input while recording (text + audio are mutually exclusive):
// a moving waveform + timer + pause/resume, cancel (discard) and send (stop → transcribe).
function RecordingBar({
  stream,
  recordState,
  onPause,
  onResume,
  onCancel,
  onStop,
}: {
  stream: MediaStream;
  recordState: RecordState;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (recordState !== "recording") return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [recordState]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2">
      <Tooltip content={t("playground.audio.cancel", "Cancel recording")}>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("playground.audio.cancel", "Cancel recording")}
          className="shrink-0 rounded p-1 text-text-muted hover:text-error"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>
      <span
        className={cn(
          "inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-error",
          recordState === "recording" && "animate-pulse",
        )}
        aria-hidden="true"
      />
      <MovingWaveform stream={stream} active={recordState === "recording"} />
      <span className="shrink-0 text-sm text-text-secondary tabular-nums">{`${mm}:${ss}`}</span>
      <Tooltip
        content={
          recordState === "recording"
            ? t("playground.audio.pause", "Pause")
            : t("playground.audio.resume", "Resume")
        }
      >
        <button
          type="button"
          onClick={recordState === "recording" ? onPause : onResume}
          aria-label={
            recordState === "recording"
              ? t("playground.audio.pause", "Pause")
              : t("playground.audio.resume", "Resume")
          }
          className="shrink-0 rounded p-1 text-text-secondary hover:text-text-primary"
        >
          {recordState === "recording" ? (
            <Pause className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </Tooltip>
      <Tooltip content={t("playground.audio.send", "Send voice note")}>
        <span className="inline-flex">
          <Button
            size="sm"
            onClick={onStop}
            aria-label={t("playground.audio.send", "Send voice note")}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        </span>
      </Tooltip>
    </div>
  );
}

// Scrolling amplitude history (WhatsApp-style), themed via the canvas' `text-accent` color — NOT a
// hardcoded red. A ring buffer of recent peaks advances each frame while `active`; pausing freezes
// it. Web Audio AnalyserNode time-domain data, no dependency. AudioContext closed on unmount.
function MovingWaveform({
  stream,
  active,
}: {
  stream: MediaStream;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const audio = new Ctx();
    void audio.resume();
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const canvas = canvasRef.current;
    const color = canvas
      ? getComputedStyle(canvas).color || "#3b82f6"
      : "#3b82f6";
    // Fixed spacing between bars (in CSS px) so each bar stays the SAME thickness at any width — a
    // wider panel shows MORE bars, not fatter ones (the FAB looked right, the wide tab didn't).
    const PITCH = 7;
    let peaks: number[] = [];
    let raf = 0;

    // Size the backing store to the rendered (CSS) size, DPR-aware, and (re)compute the bar count.
    const resize = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = cv.clientWidth || 1;
      const cssH = cv.clientHeight || 32;
      cv.width = Math.max(1, Math.round(cssW * dpr));
      cv.height = Math.max(1, Math.round(cssH * dpr));
      const bars = Math.max(8, Math.floor(cssW / PITCH));
      // Preserve recent history when the width changes (grow ⇒ pad the left with silence).
      if (bars > peaks.length)
        peaks = new Array(bars - peaks.length).fill(0).concat(peaks);
      else if (bars < peaks.length) peaks = peaks.slice(peaks.length - bars);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas) ro.observe(canvas);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current;
      const c2d = cv?.getContext("2d");
      if (!cv || !c2d) return;
      if (activeRef.current) {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs((data[i] ?? 128) - 128) / 128;
          if (v > peak) peak = v;
        }
        peaks.push(peak);
        peaks.shift();
      }
      const { width, height } = cv;
      c2d.clearRect(0, 0, width, height);
      c2d.fillStyle = color;
      const barW = width / Math.max(1, peaks.length);
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(2, (peaks[i] ?? 0) * height);
        c2d.fillRect(i * barW + barW * 0.2, (height - h) / 2, barW * 0.6, h);
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      source.disconnect();
      void audio.close();
    };
  }, [stream]);

  return (
    <canvas
      ref={canvasRef}
      height={32}
      className="h-8 min-w-0 flex-1 text-accent"
    />
  );
}

// Past-session list (left rail). The active session is highlighted; "New session" is always
// visible (so a brand-new, unsaved session reads clearly). Clicking a row loads its transcript.
function PlaygroundSessionsSidebar({
  sessions,
  currentThreadId,
  disabled,
  hasTurns,
  onNew,
  onPick,
  onDelete,
}: {
  sessions: PlaygroundSessionMeta[];
  currentThreadId: string | undefined;
  disabled: boolean;
  hasTurns: boolean;
  onNew: () => void;
  onPick: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const isNew = currentThreadId === undefined;
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-border border-r md:flex">
      <div className="p-2">
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={onNew}
          disabled={(!hasTurns && isNew) || disabled}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("playground.newSession", "New session")}
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {isNew && (
          <div className="rounded-md bg-bg-hover px-2 py-1.5 text-sm text-text-primary">
            {t("playground.newSessionActive", "New session")}
          </div>
        )}
        {sessions.length === 0 && !isNew && (
          <p className="px-2 py-1.5 text-text-muted text-xs">
            {t("playground.historyEmpty", "No saved sessions yet.")}
          </p>
        )}
        {sessions.map((s) => {
          const active = s.threadId === currentThreadId;
          return (
            <div
              key={s.threadId}
              className={cn(
                "group flex items-center gap-1 rounded-md transition-colors hover:bg-bg-hover",
                { "bg-bg-hover": active },
              )}
            >
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm",
                  active ? "text-text-primary" : "text-text-secondary",
                )}
                onClick={() => onPick(s.threadId)}
                disabled={disabled}
              >
                {s.title || t("playground.untitledSession", "Untitled session")}
              </button>
              <button
                type="button"
                aria-label={t("common.delete", "Delete")}
                className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
                onClick={() => onDelete(s.threadId)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function TracePanel({
  turn,
  onOpenDoc,
  onOpenKb,
}: {
  turn: Extract<PlaygroundTurn, { role: "assistant" }>;
  onOpenDoc: (doc: { id: string; title: string }) => void;
  onOpenKb: (kb: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  if (turn.trace.length === 0 && turn.sources.length === 0) return null;

  return (
    <details className="w-full rounded-md border border-border bg-bg-secondary/50 text-xs">
      <summary className="select-none px-2 py-1 text-text-muted">
        {t("playground.trace.toggle", "Execution details")}{" "}
        {`(${turn.trace.length})`}
      </summary>
      <div className="flex flex-col gap-2 border-border border-t p-2">
        {turn.trace.map((entry, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ordered, immutable trace
          <TraceRow key={i} entry={entry} />
        ))}
        {turn.sources.length > 0 && (
          <div className="flex flex-col gap-1 border-border border-t pt-2">
            <span className="flex items-center gap-1 font-medium text-text-secondary">
              <BookText className="h-3.5 w-3.5" aria-hidden="true" />
              {t("playground.trace.sources", "Sources")}
            </span>
            {turn.sources.map((s) => {
              const docTitle = s.documentTitle || s.title;
              return (
                <div
                  key={`${s.kb}-${s.documentId ?? s.chunkId}`}
                  className="flex flex-wrap items-center gap-1 text-text-muted"
                >
                  {s.knowledgeBaseId ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenKb({
                          id: s.knowledgeBaseId as string,
                          name: s.kb,
                        })
                      }
                      className="text-accent hover:underline"
                    >
                      {s.kb}
                    </button>
                  ) : (
                    <span>{s.kb}</span>
                  )}
                  {docTitle && (
                    <>
                      <span aria-hidden="true">{" › "}</span>
                      {s.documentId ? (
                        <button
                          type="button"
                          onClick={() =>
                            onOpenDoc({
                              id: s.documentId as string,
                              title: docTitle,
                            })
                          }
                          className="text-left text-accent hover:underline"
                        >
                          {docTitle}
                        </button>
                      ) : (
                        <span>{docTitle}</span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// What one guardrail row SAYS. A table rather than a chain of ternaries, because two independent
// fields decide it and the chain grew a wrong arm for each: one sentence for both directions said
// the REPLY went out unscreened, on rows where the reply was screened and approved a line below;
// and every trip said "the configured reply", on text the judge itself had written.
export function guardrailTraceLabel(
  t: (key: string, fallback: string) => string,
  entry: Pick<
    Extract<TraceEntry, { type: "guardrail" }>,
    "direction" | "outcome" | "action"
  >,
): string {
  switch (entry.outcome) {
    case "clean":
      return t("playground.trace.guardrailClean", "approved");
    case "unavailable":
      return entry.direction === "input"
        ? t(
            "playground.trace.guardrailUnavailableInput",
            "could not be checked, so the message reached the agent unchecked",
          )
        : t(
            "playground.trace.guardrailUnavailableOutput",
            "could not be checked, so the reply went out unscreened",
          );
    case "suppressed":
      return t(
        "playground.trace.guardrailSuppressed",
        "blocked, nothing would be sent",
      );
    case "replaced":
      // `generated` reaches here only when the judge actually handed text back: the gate reports
      // `template` when the action was `generated` and no reply came with it, so this reads the
      // event and not the configuration.
      return entry.action === "generated"
        ? t(
            "playground.trace.guardrailReplacedGenerated",
            "replaced by a reply the guardrail wrote",
          )
        : t(
            "playground.trace.guardrailReplaced",
            "replaced by the configured reply",
          );
  }
}

function TraceRow({ entry }: { entry: TraceEntry }) {
  const { t } = useTranslation();
  if (entry.type === "assistant") {
    return (
      <p className="whitespace-pre-wrap text-text-muted italic">{entry.text}</p>
    );
  }
  if (entry.type === "tool_call") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1 font-medium text-text-secondary">
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.name}
        </span>
        <pre className="overflow-x-auto rounded bg-bg-tertiary px-2 py-1 text-text-muted">
          {JSON.stringify(entry.args, null, 2)}
        </pre>
      </div>
    );
  }
  if (entry.type === "guardrail") {
    const tripped =
      entry.outcome === "replaced" || entry.outcome === "suppressed";
    return (
      <div className="flex flex-col gap-0.5">
        <span
          className={cn("flex items-center gap-1 font-medium", {
            "text-warning": tripped || entry.outcome === "unavailable",
            "text-text-secondary": entry.outcome === "clean",
          })}
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.direction === "input"
            ? t("playground.trace.guardrailInput", "Guardrail on the message")
            : t("playground.trace.guardrailOutput", "Guardrail on the reply")}
          <span className="font-normal text-text-muted">
            {guardrailTraceLabel(t, entry)}
          </span>
        </span>
        {tripped && (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-bg-tertiary px-2 py-1 text-text-muted">
            {[entry.categories?.join(", "), entry.rationale]
              .filter(Boolean)
              .join(" — ")}
          </pre>
        )}
      </div>
    );
  }
  if (entry.type === "media") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1 font-medium text-text-secondary">
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.mediaKind === "document"
            ? t("playground.trace.visionDocument", "Document reading")
            : t("playground.trace.visionImage", "Image reading")}
          <span className="font-normal text-text-muted">
            {entry.provider}
            {entry.model ? ` · ${entry.model}` : ""}
          </span>
        </span>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-bg-tertiary px-2 py-1 text-text-muted">
          {entry.output}
        </pre>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn("flex items-center gap-1 font-medium", {
          "text-error": entry.isError,
          "text-text-secondary": !entry.isError,
        })}
      >
        {entry.isError && (
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {`→ ${entry.name || t("playground.trace.result", "result")}`}
        {entry.mocked && (
          <span className="rounded bg-accent/20 px-1 text-[10px] text-accent uppercase">
            {t("playground.trace.mocked", "mocked")}
          </span>
        )}
        {entry.simulated && (
          <span className="rounded bg-bg-tertiary px-1 text-[10px] text-text-muted uppercase">
            {t("playground.trace.simulated", "simulated")}
          </span>
        )}
      </span>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-bg-tertiary px-2 py-1 text-text-muted">
        {entry.output}
      </pre>
    </div>
  );
}
