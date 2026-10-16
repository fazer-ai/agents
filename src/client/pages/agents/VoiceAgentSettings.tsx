// A voice agent's settings, drawn in two places: the Voice card on General (the key, the
// voice and the model that speaks) and the Call tab (how the line behaves). Both edit one form,
// `settings.calls`, and one save writes it with the agent, after which the editor asks ElevenLabs for
// the agent's state and the card says it (`VoiceStatus`).

import {
  CheckCircle2,
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
  SwitchField,
  Textarea,
} from "@/client/components";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { cn } from "@/client/lib/utils";
import {
  CALL_BACKGROUND_SOUNDS,
  CALL_LIMITS,
  CALL_LLMS,
  CALL_TOOL_SOUNDS,
  CALL_TURN_EAGERNESS,
  type CallBackgroundSound,
  type CallToolSound,
  type CallTurnEagerness,
} from "@/modules/voice-call/settings";
import {
  CALLS_FORM_RANGES,
  type CallsFormState,
  type CallsRangeField,
  callsFormErrors,
} from "./callsFormState";

type SetCalls = React.Dispatch<React.SetStateAction<CallsFormState>>;

/** What ElevenLabs says about the saved agent, asked after load and after every save. */
export type VoiceStatus =
  | { state: "checking" }
  | { state: "ready" }
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

function useProblemText() {
  const { t } = useTranslation();
  return (problem: string): string =>
    ({
      no_credential: t(
        "editor.voiceProblemNoCredential",
        "Choose the ElevenLabs key and save.",
      ),
      credential_unusable: t(
        "editor.voiceProblemCredential",
        "The key could not be read from the vault.",
      ),
      invalid_key: t(
        "editor.voiceProblemInvalidKey",
        "ElevenLabs refused the key.",
      ),
      missing_permission: t(
        "editor.voiceProblemPermission",
        "This key only does text-to-speech. Create one with the ElevenLabs Agents permission (read and write).",
      ),
      unreachable: t(
        "editor.voiceProblemUnreachable",
        "ElevenLabs could not be reached.",
      ),
      sync_failed: t(
        "editor.voiceProblemSync",
        "ElevenLabs refused the agent's settings.",
      ),
      microphone: t(
        "playground.call.noMicrophone",
        "The browser did not allow the microphone.",
      ),
    })[problem] ?? problem;
}

export function VoiceStatusLine({
  status,
  dirty,
}: {
  status: VoiceStatus;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const problemText = useProblemText();
  if (dirty)
    return (
      <span className="text-text-muted text-xs">
        {t(
          "editor.voiceStatusUnsaved",
          "Saving sets the agent up on ElevenLabs.",
        )}
      </span>
    );
  if (status.state === "checking")
    return (
      <span className="flex items-center gap-1.5 text-text-muted text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("editor.voiceStatusChecking", "Checking with ElevenLabs…")}
      </span>
    );
  if (status.state === "ready")
    return (
      <span className="flex items-center gap-1.5 text-success text-xs">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t("editor.voiceStatusReady", "Ready on ElevenLabs")}
      </span>
    );
  return (
    <span className="flex items-start gap-1.5 text-error text-xs">
      <TriangleAlert
        className="mt-px h-3.5 w-3.5 shrink-0"
        aria-hidden="true"
      />
      <span>
        {problemText(status.problem)}
        {status.detail && (
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

/**
 * Voice: who the agent sounds like and what thinks for it. On General it carries the ElevenLabs key and
 * its status; on the Call tab, the speech speed. Voice and model show on both, over the same state:
 * General is where the agent is named, the Call tab where everything about the line is tuned.
 */
export function VoiceCard({
  placement,
  calls,
  setCalls,
  status,
  dirty,
  voicePicker,
}: {
  placement: "general" | "call";
  calls: CallsFormState;
  setCalls: SetCalls;
  status?: VoiceStatus;
  dirty?: boolean;
  voicePicker: (props: {
    credentialRef: string;
    value: string;
    onChange: (v: string) => void;
  }) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const rangeError = useRangeError(calls);
  const set = (patch: Partial<CallsFormState>) =>
    setCalls((c) => ({ ...c, ...patch }));
  return (
    <Card
      id={placement === "general" ? "general-voice" : "call-voice"}
      className="flex scroll-mt-4 flex-col gap-4"
    >
      <CardHeader
        icon={Speech}
        title={t("editor.voiceSection", "Voice")}
        hint={t(
          "editor.voiceSectionHint",
          "How the agent sounds and what thinks for it, on your ElevenLabs account.",
        )}
      />
      <div
        className={cn(
          "grid gap-4",
          placement === "general" ? "sm:grid-cols-2" : "sm:grid-cols-3",
        )}
      >
        {placement === "general" && (
          <FormField
            className="sm:col-span-2"
            label={t("editor.voiceCredential", "ElevenLabs key")}
            required
            help={t(
              "editor.voiceCredentialHelp",
              "An ElevenLabs API key with the Agents permission (read and write). Saving creates the agent on that account and keeps it in step; do not edit it on the ElevenLabs dashboard, the next save overwrites it.",
            )}
            group
          >
            <CredentialPicker
              value={calls.credentialRef}
              onChange={(v) => set({ credentialRef: v })}
              required
              compatibleTypes={credentialCompat.tts("elevenlabs")}
              defaultCreateType={credentialCompat.tts("elevenlabs")[0]}
              ariaLabel={t("editor.voiceCredential", "ElevenLabs key")}
            />
            {status && (
              <div className="mt-1.5">
                <VoiceStatusLine status={status} dirty={!!dirty} />
              </div>
            )}
          </FormField>
        )}
        <FormField label={t("editor.voiceVoice", "Voice")} group>
          {voicePicker({
            credentialRef: calls.credentialRef,
            value: calls.voice,
            onChange: (v) => set({ voice: v }),
          })}
        </FormField>
        <FormField
          label={t("editor.voiceModel", "Model")}
          help={t(
            "editor.voiceModelHelp",
            "The model that answers during the call. The time next to each one is how long the person waits after speaking, measured on a test line.",
          )}
        >
          <Select
            value={calls.llm}
            onChange={(e) => set({ llm: e.target.value })}
          >
            {CALL_LLMS.map((m) => (
              <option key={m.id} value={m.id}>
                {`${m.id} · ${(m.latencyMs / 1000).toFixed(1).replace(".", ",")} s`}
              </option>
            ))}
            {!CALL_LLMS.some((m) => m.id === calls.llm) && (
              <option value={calls.llm}>{calls.llm}</option>
            )}
          </Select>
        </FormField>
        {placement === "call" && (
          <FormField
            error={rangeError("speed")}
            label={t("editor.voiceSpeed", "Speech speed")}
            description={t(
              "editor.voiceSpeedHint",
              "From {{min}} to {{max}}; 1 is normal.",
              {
                min: String(CALL_LIMITS.speed[0]).replace(".", ","),
                max: String(CALL_LIMITS.speed[1]).replace(".", ","),
              },
            )}
          >
            <Input
              inputMode="decimal"
              value={calls.speed}
              onChange={(e) => set({ speed: e.target.value })}
            />
          </FormField>
        )}
      </div>
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
      patient: t("editor.callsTurnPatient", "Waits longer"),
      normal: t("editor.callsTurnNormal", "Balanced"),
      eager: t("editor.callsTurnEager", "Answers quickly"),
    })[v];

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <CardHeader
          icon={PhoneIncoming}
          title={t("editor.callsConversation", "Conversation")}
          hint={t(
            "editor.callsConversationHint",
            "How the agent opens the call and takes its turn.",
          )}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            error={rangeError("openingDelaySecs")}
            label={t("editor.callsOpeningDelay", "Wait for the hello (s)")}
            help={t(
              "editor.callsOpeningDelayHelp",
              "On a call the agent places, how long it waits for the person to say hello before it speaks. A call to the inbox is answered at once.",
            )}
          >
            <Input
              inputMode="decimal"
              value={calls.openingDelaySecs}
              onChange={(e) => set({ openingDelaySecs: e.target.value })}
            />
          </FormField>
          <FormField
            label={t("editor.callsTurn", "Taking its turn")}
            help={t(
              "editor.callsTurnHelp",
              "How long the agent waits after the person pauses before it answers. Waiting longer interrupts less; answering quickly feels more responsive.",
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
            label={t("editor.callsSilence", "Hang up after silence (s)")}
            group
          >
            <div className="flex items-center gap-3">
              <SwitchField
                checked={calls.endOnSilence}
                onCheckedChange={(v) => set({ endOnSilence: v })}
                label={t("editor.callsSilenceOn", "On")}
                className="shrink-0"
              />
              <Input
                inputMode="numeric"
                value={calls.silenceEndCallSecs}
                disabled={!calls.endOnSilence}
                aria-label={t(
                  "editor.callsSilence",
                  "Hang up after silence (s)",
                )}
                onChange={(e) => set({ silenceEndCallSecs: e.target.value })}
              />
            </div>
          </FormField>
          <FormField
            error={rangeError("maxDurationMin")}
            label={t("editor.callsMaxDuration", "Longest call (min)")}
          >
            <Input
              inputMode="numeric"
              value={calls.maxDurationMin}
              onChange={(e) => set({ maxDurationMin: e.target.value })}
            />
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
            label={t("editor.callsBackgroundVolume", "Background volume (%)")}
            help={t(
              "editor.callsBackgroundVolumeHelp",
              "Relative to the agent's voice. 15 is a room you notice without it getting in the way.",
            )}
          >
            <Input
              inputMode="numeric"
              value={calls.backgroundVolume}
              disabled={!calls.backgroundSound}
              onChange={(e) => set({ backgroundVolume: e.target.value })}
            />
          </FormField>
          <FormField
            label={t("editor.callsToolSound", "While using a tool")}
            help={t(
              "editor.callsToolSoundHelp",
              "Fills the pause of a lookup, so it does not sound like the line dropped. Plays only when the agent says nothing before using the tool.",
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
          "Settings apply to the next call. Save to send them to ElevenLabs.",
        )}
      </p>
    </div>
  );
}
