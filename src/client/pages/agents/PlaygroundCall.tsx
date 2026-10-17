// A voice agent's call in the playground, the screen it fills while it lasts, over the agent's SAVED
// call settings (the agent on the provider is set up from them, not from the form). Every step of the
// line shows: preparing, ringing, on the call (who is talking, and that the microphone hears you),
// and how it ended.

import {
  Mic,
  Phone,
  PhoneOff,
  RotateCcw,
  Settings2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "@/client/components";
import { providerLabel } from "@/client/lib/providerLabels";
import { cn } from "@/client/lib/utils";
import type { CallProvider } from "@/modules/voice-call/settings";
import { KEY_PROBLEMS } from "./callsFormState";
import type {
  CallEnd,
  CallState,
  usePlaygroundCall,
} from "./usePlaygroundCall";
import { useProblemText } from "./VoiceAgentSettings";

type Call = ReturnType<typeof usePlaygroundCall>;

function clock(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function useElapsed(call: CallState): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call.state !== "live") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.state]);
  if (call.state !== "live") return "";
  return clock(Math.max(0, Math.floor((now - call.since) / 1000)));
}

export function PlaygroundCallView({
  call,
  provider,
  onOpenGeneral,
}: {
  call: Call;
  provider: CallProvider;
  /** Where a key or settings problem is fixed. */
  onOpenGeneral: () => void;
}) {
  const { t } = useTranslation();
  const elapsed = useElapsed(call.call);
  const scrollRef = useRef<HTMLOListElement>(null);
  const c = call.call;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new line
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [call.lines.length]);

  const problemText = useProblemText();

  const endText = (end: CallEnd): string => {
    switch (end.by) {
      case "operator":
        return t("playground.call.endedByYou", "You hung up.");
      case "dropped":
        return t("playground.call.dropped", "The line dropped.");
      case "error":
        return t(
          "playground.call.endedByError",
          "The call ended on an error in the voice engine.",
        );
      case "agent":
        return end.reason === "farewell"
          ? t(
              "playground.call.endedAfterFarewell",
              "The agent hung up after saying goodbye.",
            )
          : t("playground.call.endedByAgent", "The agent hung up.");
    }
  };

  const title =
    c.state === "preparing"
      ? t("playground.call.preparing", "Getting the line ready…")
      : c.state === "ringing"
        ? t("playground.call.ringing", "Ringing…")
        : c.state === "live"
          ? elapsed
          : c.state === "ended"
            ? t("playground.call.ended", "Call ended")
            : t("playground.call.failed", "The call did not start");

  const subtitle =
    c.state === "preparing"
      ? t(
          "playground.call.preparingHint",
          "Checking the agent on {{provider}} and asking for the microphone.",
          { provider: providerLabel(provider, t) },
        )
      : c.state === "ringing"
        ? t("playground.call.ringingHint", "Connecting the agent's voice.")
        : c.state === "live"
          ? call.meters.speaker === "agent"
            ? t("playground.call.agentSpeaking", "The agent is talking")
            : call.meters.speaker === "operator"
              ? t("playground.call.operatorSpeaking", "You are talking")
              : t("playground.call.listening", "The agent is listening")
          : c.state === "ended"
            ? [
                endText(c.end),
                c.durationSecs !== null
                  ? t("playground.call.duration", "Length {{time}}.", {
                      time: clock(c.durationSecs),
                    })
                  : "",
              ]
                .filter(Boolean)
                .join(" ")
            : c.state === "failed"
              ? problemText(c.problem, provider)
              : "";

  const detail =
    (c.state === "failed" && !KEY_PROBLEMS.has(c.problem) && c.detail) ||
    (c.state === "ended" && c.end.by === "error" && c.end.reason) ||
    null;

  const live = c.state === "live";
  const over = c.state === "ended" || c.state === "failed";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-4 p-4">
      <div className="flex flex-col items-center gap-2 pt-2">
        <div
          className={cn(
            "relative flex h-20 w-20 items-center justify-center rounded-full transition-colors",
            c.state === "failed"
              ? "bg-error/10 text-error"
              : over
                ? "bg-bg-tertiary text-text-muted"
                : "bg-success/15 text-success",
          )}
        >
          {(c.state === "ringing" ||
            (live && call.meters.speaker === "agent")) && (
            <span
              className="absolute inset-0 animate-ping rounded-full bg-success/25"
              aria-hidden="true"
            />
          )}
          {over ? (
            <PhoneOff className="h-8 w-8" aria-hidden="true" />
          ) : (
            <Phone className="h-8 w-8" aria-hidden="true" />
          )}
        </div>
        <p
          className="font-semibold text-lg text-text-primary tabular-nums"
          aria-live="polite"
        >
          {title}
        </p>
        <p
          className={cn(
            "max-w-md text-center text-sm",
            c.state === "failed" ? "text-error" : "text-text-secondary",
          )}
        >
          {subtitle}
        </p>
        {detail && (
          <p className="max-w-md text-center text-text-muted text-xs">
            {detail}
          </p>
        )}
        {(c.state === "ringing" || live) && (
          <div
            className="flex items-center gap-2 text-text-muted text-xs"
            title={t("playground.call.micLevel", "Your microphone")}
          >
            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className="h-full bg-success transition-[width] duration-100"
                style={{
                  width: `${Math.min(100, Math.round(call.meters.mic * 300))}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      <ol
        ref={scrollRef}
        className="flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-2 overflow-y-auto"
      >
        {live && call.lines.length === 0 && (
          <li className="m-auto text-center text-text-muted text-xs">
            {t(
              "playground.call.hint",
              "Talk as the customer would. The conversation tools are simulated, and nothing reaches Chatwoot.",
            )}
          </li>
        )}
        {call.lines.map((line, i) =>
          line.role === "tool" ? (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript, never reordered
              key={i}
              className="flex items-center gap-1.5 self-center text-text-muted text-xs"
            >
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="font-mono">{line.name}</span>
              {line.simulated && (
                <Badge variant="info">
                  {t("playground.call.toolSimulated", "simulated")}
                </Badge>
              )}
              {!line.ok && (
                <Badge variant="error">
                  {t("playground.call.toolFailed", "failed")}
                </Badge>
              )}
            </li>
          ) : (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript, never reordered
              key={i}
              className={cn(
                "max-w-[80%] rounded-lg px-3 py-2 text-sm",
                line.role === "agent"
                  ? "self-start bg-bg-tertiary text-text-primary"
                  : "self-end bg-accent/15 text-text-primary",
              )}
            >
              {line.text}
            </li>
          ),
        )}
      </ol>

      <div className="flex items-center gap-3 pb-1">
        {c.state === "preparing" ? (
          <Button variant="ghost" onClick={call.cancel}>
            <X className="h-4 w-4" aria-hidden="true" />
            {t("common.cancel", "Cancel")}
          </Button>
        ) : c.state === "ringing" || live ? (
          <Button variant="danger" onClick={call.hangUp}>
            <PhoneOff className="h-4 w-4" aria-hidden="true" />
            {t("playground.call.hangUp", "Hang up")}
          </Button>
        ) : over ? (
          <>
            {c.state === "failed" &&
              (KEY_PROBLEMS.has(c.problem) ||
                c.problem === "no_credential" ||
                c.problem === "sync_failed") && (
                <Button onClick={onOpenGeneral}>
                  <Settings2 className="h-4 w-4" aria-hidden="true" />
                  {c.problem === "sync_failed"
                    ? t("playground.call.reviewSettings", "Review the settings")
                    : t("playground.call.reviewKey", "Review the key")}
                </Button>
              )}
            <Button variant="secondary" onClick={() => void call.start()}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {t("playground.call.again", "Call again")}
            </Button>
            <Button variant="ghost" onClick={call.dismiss}>
              <X className="h-4 w-4" aria-hidden="true" />
              {t("playground.call.close", "Close")}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
