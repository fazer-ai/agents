// A voice agent's settings, drawn in two places: the Voice card on General (the provider and its key,
// the voice and the models) and the Call tab (how the line behaves). Both edit one form,
// `settings.calls`, and one save writes it with the agent, after which the editor asks the provider
// for the agent's state and the card says it (`VoiceStatus`).

import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  PhoneIncoming,
  PhoneOff,
  Speech,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CredentialPicker,
  FormField,
  Input,
  Select,
  Switch,
  Textarea,
} from "@/client/components";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { providerLabel } from "@/client/lib/providerLabels";
import {
  CALL_ASR_MODELS,
  CALL_BACKGROUND_SOUNDS,
  CALL_LIMITS,
  CALL_LLMS,
  CALL_PROVIDERS,
  CALL_TOOL_SOUNDS,
  CALL_TTS_MODELS,
  CALL_TURN_EAGERNESS,
  type CallAsrModel,
  type CallBackgroundSound,
  type CallProvider,
  type CallToolSound,
  type CallTtsModel,
  type CallTurnEagerness,
  callProviderAgentUrl,
  callProviderKeysUrl,
} from "@/modules/voice-call/settings";
import {
  CALLS_FORM_RANGES,
  type CallsFormState,
  type CallsRangeField,
  callsFormErrors,
  KEY_PROBLEMS,
} from "./callsFormState";

type SetCalls = React.Dispatch<React.SetStateAction<CallsFormState>>;

/** What the provider says about the saved agent, asked after load and after every save. */
export type VoiceStatus =
  | { state: "checking" }
  | { state: "ready"; agentId: string | null }
  | { state: "problem"; problem: string; detail: string | null };

function CardHeader({
  icon: Icon,
  title,
  hint,
  aside,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
        <div className="min-w-0">
          <h3 className="font-medium text-sm text-text-primary">{title}</h3>
          <p className="text-text-muted text-xs">{hint}</p>
        </div>
      </div>
      {aside}
    </div>
  );
}

// The permission a provider's key needs to run agents, as that provider's dashboard names it.
function useKeyPermission() {
  const { t } = useTranslation();
  return (provider: CallProvider): string =>
    ({
      elevenlabs: t(
        "editor.voicePermissionElevenlabs",
        "ElevenLabs Agents (read and write)",
      ),
    })[provider];
}

function useProblemText() {
  const { t } = useTranslation();
  const permission = useKeyPermission();
  return (problem: string, provider: CallProvider): string => {
    const name = providerLabel(provider, t);
    return (
      {
        disabled: t(
          "editor.callsProblemDisabled",
          "Calls are off on the saved agent.",
        ),
        no_credential: t(
          "editor.voiceProblemNoCredential",
          "Choose the {{provider}} key on General and save.",
          { provider: name },
        ),
        credential_unusable: t(
          "editor.voiceProblemCredential",
          "The key could not be read from the vault.",
        ),
        invalid_key: t(
          "editor.voiceProblemInvalidKey",
          "{{provider}} refused the key.",
          { provider: name },
        ),
        missing_permission: t(
          "editor.voiceProblemPermission",
          "This key cannot run agents. On {{provider}}, create one with the {{permission}} permission.",
          { provider: name, permission: permission(provider) },
        ),
        unreachable: t(
          "editor.voiceProblemUnreachable",
          "{{provider}} could not be reached.",
          { provider: name },
        ),
        sync_failed: t(
          "editor.voiceProblemSync",
          "{{provider}} refused the agent's settings.",
          { provider: name },
        ),
        microphone: t(
          "playground.call.noMicrophone",
          "The browser did not allow the microphone.",
        ),
        audio: t(
          "playground.call.noAudio",
          "The browser did not start the call's audio. Click Call again.",
        ),
      }[problem] ?? problem
    );
  };
}

// What the provider said about the saved agent, as a line for the editor's configuration warnings: a
// problem there means the agent cannot take a call, and the card that says so in detail is on General,
// out of sight from any other tab. Only the provider's verdicts on the key or the settings go up; a
// check that could not run says nothing about the key, so it stays on the card's line.
export function useVoiceCallWarning(
  status: VoiceStatus,
  provider: CallProvider,
): { message: string; action: string } | null {
  const { t } = useTranslation();
  if (status.state !== "problem") return null;
  const name = providerLabel(provider, t);
  const reviewKey = t("editor.voiceWarningReviewKey", "Review the key");
  switch (status.problem) {
    case "invalid_key":
      return {
        message: t(
          "editor.voiceWarningInvalidKey",
          "The agent cannot take calls because the key was refused.",
        ),
        action: reviewKey,
      };
    case "missing_permission":
      return {
        message: t(
          "editor.voiceWarningPermission",
          "The agent cannot take calls because the key is not allowed to run agents on {{provider}}.",
          { provider: name },
        ),
        action: reviewKey,
      };
    case "credential_unusable":
      return {
        message: t(
          "editor.voiceWarningCredential",
          "The agent cannot take calls because its key could not be read from the vault.",
        ),
        action: reviewKey,
      };
    case "sync_failed":
      return {
        message: t(
          "editor.voiceWarningSync",
          "The agent cannot take calls because {{provider}} refused its settings.",
          { provider: name },
        ),
        action: t("editor.voiceWarningReviewVoice", "Review the voice"),
      };
    default:
      return null;
  }
}

export function VoiceStatusLine({
  status,
  dirty,
  provider,
}: {
  status: VoiceStatus;
  dirty: boolean;
  provider: CallProvider;
}) {
  const { t } = useTranslation();
  const problemText = useProblemText();
  const name = providerLabel(provider, t);
  if (dirty)
    return (
      <span className="text-text-muted text-xs">
        {t(
          "editor.voiceStatusUnsaved",
          "Saving sets the agent up on {{provider}}.",
          { provider: name },
        )}
      </span>
    );
  if (status.state === "checking")
    return (
      <span className="flex items-center gap-1.5 text-text-muted text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("editor.voiceStatusChecking", "Checking with {{provider}}…", {
          provider: name,
        })}
      </span>
    );
  if (status.state === "ready") {
    const url = status.agentId
      ? callProviderAgentUrl(provider, status.agentId)
      : null;
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t(
            "editor.voiceStatusReady",
            "Connection with {{provider}} verified",
            {
              provider: name,
            },
          )}
        </span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title={t(
              "editor.voiceProviderLinkHint",
              "Settings are changed here: the next save overwrites changes made on {{provider}}.",
              { provider: name },
            )}
            className="flex items-center gap-1 text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
          >
            {t(
              "editor.voiceProviderLink",
              "See calls and transcripts on {{provider}}",
              { provider: name },
            )}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5 text-error text-xs">
      <TriangleAlert
        className="mt-px h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
      <span>
        {problemText(status.problem, provider)}
        {status.detail && !KEY_PROBLEMS.has(status.problem) && (
          <span className="block text-text-muted">{status.detail}</span>
        )}
      </span>
    </span>
  );
}

export { useProblemText };

/** The text under a number out of range, or null. */
function useRangeError(calls: CallsFormState) {
  const { t } = useTranslation();
  const wrong = new Set(callsFormErrors(calls));
  return (field: CallsRangeField): string | null => {
    if (!wrong.has(field)) return null;
    const [min, max] = CALLS_FORM_RANGES[field];
    return t(
      "editor.callsOutOfRange",
      "Use a number from {{min}} to {{max}}.",
      {
        min: String(min).replace(".", ","),
        max: String(max).replace(".", ","),
      },
    );
  };
}

/** The speech speed as a slider over the accepted range, the value shown beside it. */
function SpeedSlider({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [min, max] = CALL_LIMITS.speed;
  const n = Number(value.replace(",", "."));
  const shown = Number.isFinite(n) ? n : 1;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={0.05}
          value={shown}
          onChange={(e) => onChange(e.target.value.replace(".", ","))}
          aria-label={t("editor.voiceSpeed", "Speech speed")}
          className="h-10 min-w-0 flex-1 accent-primary"
        />
        <span className="w-12 shrink-0 text-right text-sm text-text-primary tabular-nums">
          {`${shown.toFixed(2).replace(".", ",")}×`}
        </span>
      </div>
      {/* "Normal" sits under 1 on the track, which is not its middle. */}
      <div className="relative mr-15 h-4 text-text-muted text-xs">
        <span className="absolute left-0">
          {t("editor.voiceSpeedSlower", "Slower")}
        </span>
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${((1 - min) / (max - min)) * 100}%` }}
        >
          {t("editor.voiceSpeedNormal", "Normal is 1×")}
        </span>
        <span className="absolute right-0">
          {t("editor.voiceSpeedFaster", "Faster")}
        </span>
      </div>
    </div>
  );
}

/**
 * Voice, on General: the provider that takes the calls and its key, with the agent's state there, the
 * voice and its speed, and the three models a call runs (the one that converses, the voice, and the
 * transcription of the person).
 */
export function VoiceCard({
  calls,
  setCalls,
  status,
  dirty,
  voicePicker,
}: {
  calls: CallsFormState;
  setCalls: SetCalls;
  status?: VoiceStatus;
  dirty?: boolean;
  voicePicker: (props: {
    provider: CallProvider;
    credentialRef: string;
    value: string;
    onChange: (v: string) => void;
  }) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const rangeError = useRangeError(calls);
  const permission = useKeyPermission();
  const set = (patch: Partial<CallsFormState>) =>
    setCalls((c) => ({ ...c, ...patch }));
  const name = providerLabel(calls.provider, t);
  // The voice models by name, and what ElevenLabs says each is for.
  const ttsName: Record<CallTtsModel, string> = {
    eleven_flash_v2_5: "Flash v2.5",
    eleven_v4_turbo: "v4 Turbo",
    eleven_multilingual_v2: "Multilingual v2",
  };
  const ttsLabel = (v: CallTtsModel) =>
    `${ttsName[v]} · ${
      {
        eleven_flash_v2_5: t("editor.voiceTtsFlash", "the fastest"),
        eleven_v4_turbo: t("editor.voiceTtsV4Turbo", "the most expressive"),
        eleven_multilingual_v2: t(
          "editor.voiceTtsMultilingual",
          "the most natural, slower",
        ),
      }[v]
    }`;
  // Product names, the same in every language.
  const asrLabel = (v: CallAsrModel) =>
    ({
      scribe_realtime: "Scribe Realtime",
      scribe_v2_turbo: "Scribe v2 Turbo",
    })[v];
  // What the collapsed Models section shows, so the choice is visible without opening it.
  const modelsSummary = [
    CALL_LLMS.find((m) => m.id === calls.llm)?.label ?? calls.llm,
    ttsName[calls.ttsModel],
    asrLabel(calls.asrModel),
  ].join(" · ");
  return (
    <Card id="general-voice" className="flex scroll-mt-4 flex-col gap-4">
      <CardHeader
        icon={Speech}
        title={t("editor.voiceSection", "Voice")}
        hint={t(
          "editor.voiceSectionHint",
          "Who takes the calls, how the agent sounds, and the models behind it.",
        )}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t("editor.provider", "Provider")}>
          <Select
            value={calls.provider}
            onChange={(e) => set({ provider: e.target.value as CallProvider })}
          >
            {CALL_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p, t)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label={t("editor.voiceCredential", "API key")}
          required
          help={t(
            "editor.voiceCredentialHelp",
            "A {{provider}} key with the {{permission}} permission. Saving creates the agent on that account and keeps it in step.",
            { provider: name, permission: permission(calls.provider) },
          )}
          group
        >
          <CredentialPicker
            value={calls.credentialRef}
            onChange={(v) => set({ credentialRef: v })}
            compatibleTypes={credentialCompat.tts(calls.provider)}
            defaultCreateType={credentialCompat.tts(calls.provider)[0]}
            ariaLabel={t("editor.voiceCredential", "API key")}
            createLabel={t("editor.voiceAddKey", "Add key")}
          />
          {!calls.credentialRef && (
            <p className="mt-1.5 text-text-muted text-xs">
              {t(
                "editor.voiceNoKey",
                "The agent answers calls on your {{provider}} account. Create a key there with the {{permission}} permission, then add it with the button above.",
                { provider: name, permission: permission(calls.provider) },
              )}{" "}
              <a
                href={callProviderKeysUrl(calls.provider)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
              >
                {t("editor.voiceCreateKey", "Create a key on {{provider}}", {
                  provider: name,
                })}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </p>
          )}
          {/* Without a key the picker already says so; a second, red line saying it again reads as an error on a form nobody filled yet. */}
          {status &&
            !(
              status.state === "problem" && status.problem === "no_credential"
            ) && (
              <div className="mt-1.5">
                <VoiceStatusLine
                  status={status}
                  dirty={!!dirty}
                  provider={calls.provider}
                />
              </div>
            )}
        </FormField>
        <FormField
          label={t("editor.voiceVoice", "Voice")}
          description={
            calls.credentialRef
              ? undefined
              : t(
                  "editor.voiceVoiceNoKey",
                  "Once the key is added, you can choose one of your account's voices.",
                )
          }
          group
        >
          {/* The account's voices are listed with its key; before that the field names the voice that
              would speak, not its id. */}
          {calls.credentialRef ? (
            voicePicker({
              provider: calls.provider,
              credentialRef: calls.credentialRef,
              value: calls.voice,
              onChange: (v) => set({ voice: v }),
            })
          ) : (
            <Input
              disabled
              value={t("editor.voiceDefault", "Default voice")}
              aria-label={t("editor.voiceVoice", "Voice")}
            />
          )}
        </FormField>
        <FormField
          error={rangeError("speed")}
          label={t("editor.voiceSpeed", "Speech speed")}
          group
        >
          <SpeedSlider
            value={calls.speed}
            onChange={(v) => set({ speed: v })}
          />
        </FormField>
      </div>
      <details className="group rounded-md border border-border-default">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm">
          <span className="min-w-0">
            <span className="font-medium text-text-primary">
              {t("editor.voiceModels", "Models")}
            </span>
            <span className="block text-text-muted text-xs">
              {modelsSummary}
            </span>
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-text-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="grid gap-4 border-border-default border-t p-3 sm:grid-cols-3">
          <FormField
            label={t("editor.voiceModel", "Conversation model")}
            description={t(
              "editor.voiceModelHint",
              "Understands the person and decides what to say.",
            )}
          >
            <Select
              value={calls.llm}
              onChange={(e) => set({ llm: e.target.value })}
            >
              {CALL_LLMS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!CALL_LLMS.some((m) => m.id === calls.llm) && (
                <option value={calls.llm}>{calls.llm}</option>
              )}
            </Select>
          </FormField>
          <FormField
            label={t("editor.voiceTtsModel", "Voice model")}
            description={
              calls.ttsModel === "eleven_flash_v2_5"
                ? t(
                    "editor.voiceTtsFlashHint",
                    "Turns the answer into speech. Flash reads numbers as written: put phone numbers, dates and times in words in the instructions.",
                  )
                : t(
                    "editor.voiceTtsModelHint",
                    "Turns the answer into speech. Only the models that speak Portuguese are listed.",
                  )
            }
          >
            <Select
              value={calls.ttsModel}
              onChange={(e) =>
                set({ ttsModel: e.target.value as CallTtsModel })
              }
            >
              {CALL_TTS_MODELS.map((m) => (
                <option key={m} value={m}>
                  {ttsLabel(m)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={t("editor.voiceAsrModel", "Transcription")}
            description={t(
              "editor.voiceAsrModelHint",
              "Turns what the person says into text, while they speak.",
            )}
          >
            <Select
              value={calls.asrModel}
              onChange={(e) =>
                set({ asrModel: e.target.value as CallAsrModel })
              }
            >
              {CALL_ASR_MODELS.map((m) => (
                <option key={m} value={m}>
                  {asrLabel(m)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </details>
    </Card>
  );
}

/** The Call tab: how the line behaves, from the hello to the hang-up, and what it sounds like. */
export function CallSettings({
  calls,
  setCalls,
}: {
  calls: CallsFormState;
  setCalls: SetCalls;
}) {
  const { t } = useTranslation();
  const rangeError = useRangeError(calls);
  const set = (patch: Partial<CallsFormState>) =>
    setCalls((c) => ({ ...c, ...patch }));
  const soundLabel = (v: CallBackgroundSound | CallToolSound) =>
    ({
      office1: t("editor.callsSoundOffice1", "Office"),
      office2: t("editor.callsSoundOffice2", "Busy office"),
      restaurant: t("editor.callsSoundRestaurant", "Restaurant"),
      city: t("editor.callsSoundCity", "Street"),
      typing: t("editor.callsSoundTyping", "Typing"),
      elevator1: t("editor.callsSoundElevator1", "Hold music 1"),
      elevator2: t("editor.callsSoundElevator2", "Hold music 2"),
      elevator3: t("editor.callsSoundElevator3", "Hold music 3"),
      elevator4: t("editor.callsSoundElevator4", "Hold music 4"),
    })[v];
  const turnLabel = (v: CallTurnEagerness) =>
    ({
      patient: t("editor.callsTurnPatient", "Longer"),
      normal: t("editor.callsTurnNormal", "Default"),
      eager: t("editor.callsTurnEager", "Shorter"),
    })[v];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <CardHeader
          icon={PhoneIncoming}
          title={t("editor.callsConversation", "Conversation")}
          hint={t(
            "editor.callsConversationHint",
            "When the agent answers, and the names it should hear right.",
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("editor.callsTurn", "Wait after the person pauses")}
            description={t(
              "editor.callsTurnHint",
              "A shorter wait feels quicker and may cut off someone who was about to go on.",
            )}
          >
            <Select
              value={calls.turnEagerness}
              onChange={(e) =>
                set({ turnEagerness: e.target.value as CallTurnEagerness })
              }
            >
              {CALL_TURN_EAGERNESS.map((v) => (
                <option key={v} value={v}>
                  {turnLabel(v)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <FormField
          label={t("editor.callsKeywords", "Terms to recognize")}
          help={t(
            "editor.callsKeywordsHelp",
            "Names the speech recognition should get right: people, products, brands. One per line, up to {{max}}.",
            { max: CALL_LIMITS.keywords },
          )}
          description={t(
            "editor.callsKeywordsHint",
            "One per line. Example: Dr. Roberto Almeida",
          )}
        >
          <Textarea
            rows={3}
            maxLength={CALL_LIMITS.keywords * (CALL_LIMITS.keywordChars + 1)}
            value={calls.keywords}
            onChange={(e) => set({ keywords: e.target.value })}
          />
        </FormField>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader
          icon={PhoneOff}
          title={t("editor.callsEnding", "Ending the call")}
          hint={t(
            "editor.callsEndingHint",
            "When the call ends on its own. The agent also hangs up after saying goodbye.",
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            error={rangeError("silenceEndCallSecs")}
            label={t("editor.callsSilence", "End after silence")}
            description={
              calls.endOnSilence
                ? t(
                    "editor.callsSilenceHint",
                    "Hangs up when nobody speaks for this many seconds.",
                  )
                : t(
                    "editor.callsSilenceOffHint",
                    "Off: silence never ends the call.",
                  )
            }
            group
          >
            <div className="flex items-center gap-3">
              <Switch
                checked={calls.endOnSilence}
                onCheckedChange={(v) => set({ endOnSilence: v })}
                aria-label={t("editor.callsSilence", "End after silence")}
              />
              <Input
                inputMode="numeric"
                value={calls.silenceEndCallSecs}
                disabled={!calls.endOnSilence}
                aria-label={t("editor.callsSilenceSecs", "Seconds of silence")}
                onChange={(e) => set({ silenceEndCallSecs: e.target.value })}
                className="w-24"
              />
              <span className="text-sm text-text-secondary">
                {t("editor.unitSeconds", "seconds")}
              </span>
            </div>
          </FormField>
          <FormField
            error={rangeError("maxDurationMin")}
            label={t("editor.callsMaxDuration", "Longest call")}
            description={t(
              "editor.callsMaxDurationHint",
              "The call ends when it reaches this length.",
            )}
            group
          >
            <div className="flex items-center gap-3">
              <Input
                inputMode="numeric"
                value={calls.maxDurationMin}
                aria-label={t("editor.callsMaxDuration", "Longest call")}
                onChange={(e) => set({ maxDurationMin: e.target.value })}
                className="w-24"
              />
              <span className="text-sm text-text-secondary">
                {t("editor.unitMinutes", "minutes")}
              </span>
            </div>
          </FormField>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <CardHeader
          icon={Volume2}
          title={t("editor.callsSound", "Sound")}
          hint={t(
            "editor.callsSoundHint",
            "What the person hears besides the agent. The agent does not hear it.",
          )}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={t("editor.callsBackground", "Background")}>
            <Select
              value={calls.backgroundSound}
              onChange={(e) =>
                set({
                  backgroundSound: e.target.value as CallBackgroundSound | "",
                })
              }
            >
              <option value="">{t("editor.callsSoundNone", "None")}</option>
              {CALL_BACKGROUND_SOUNDS.map((v) => (
                <option key={v} value={v}>
                  {soundLabel(v)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            error={rangeError("backgroundVolume")}
            label={t("editor.callsBackgroundVolume", "Background volume")}
            description={t(
              "editor.callsBackgroundVolumeHint",
              "Relative to the agent's voice. Around 15% is noticed without getting in the way.",
            )}
            group
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={CALLS_FORM_RANGES.backgroundVolume[0]}
                max={CALLS_FORM_RANGES.backgroundVolume[1]}
                step={1}
                value={Number(calls.backgroundVolume.replace(",", ".")) || 0}
                disabled={!calls.backgroundSound}
                onChange={(e) => set({ backgroundVolume: e.target.value })}
                aria-label={t(
                  "editor.callsBackgroundVolume",
                  "Background volume",
                )}
                className="h-10 min-w-0 flex-1 accent-primary disabled:opacity-50"
              />
              <span className="w-12 shrink-0 text-right text-sm text-text-primary tabular-nums">
                {`${calls.backgroundVolume}%`}
              </span>
            </div>
          </FormField>
          <FormField
            label={t("editor.callsToolSound", "Sound during lookups")}
            description={t(
              "editor.callsToolSoundHint",
              "Plays while the agent checks something, when it says nothing first, so the line does not sound dropped.",
            )}
          >
            <Select
              value={calls.toolSound}
              onChange={(e) =>
                set({ toolSound: e.target.value as CallToolSound | "" })
              }
            >
              <option value="">
                {t("editor.callsToolSoundNone", "Silence")}
              </option>
              {CALL_TOOL_SOUNDS.map((v) => (
                <option key={v} value={v}>
                  {soundLabel(v)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </Card>
      <p className="text-text-muted text-xs">
        {t(
          "editor.callsTabFooter",
          "Settings apply to the next call. Saving sends them to {{provider}}.",
          { provider: providerLabel(calls.provider, t) },
        )}
      </p>
    </div>
  );
}
