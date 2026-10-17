// A voice agent's Playground: a call to the agent through the browser's microphone, on
// the SAVED settings (the agent on the provider is set up from them). Before the call, what is needed and
// what to expect; during and after it, the call screen (PlaygroundCall.tsx).

import { Headphones, Phone, Settings2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "@/client/components";
import { providerLabel } from "@/client/lib/providerLabels";
import type { CallProvider } from "@/modules/voice-call/settings";
import { PlaygroundCallView } from "./PlaygroundCall";
import { usePlaygroundCall } from "./usePlaygroundCall";

export function VoicePlayground({
  agentId,
  provider,
  hasKey,
  unsaved,
  liveness,
  onSave,
  onOpenGeneral,
}: {
  agentId: string;
  provider: CallProvider;
  hasKey: boolean;
  unsaved: boolean;
  /** What saving does to the customers' calls: the agent stays in production, enters it, leaves it,
   * or stays in test. */
  liveness: "live" | "goingLive" | "leavingLive" | "test";
  /** Saves the unsaved changes, when they are all ones this button can save (General and the call). */
  onSave?: () => Promise<boolean>;
  onOpenGeneral: () => void;
}) {
  const { t } = useTranslation();
  const call = usePlaygroundCall(agentId);

  if (call.call.state !== "idle")
    return (
      <Card className="flex h-[72dvh] flex-col p-0">
        <PlaygroundCallView
          call={call}
          provider={provider}
          onOpenGeneral={onOpenGeneral}
        />
      </Card>
    );

  return (
    <Card className="flex h-[72dvh] flex-col items-center justify-center gap-5 p-6 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/15 text-success">
        <Phone className="h-8 w-8" aria-hidden="true" />
      </div>
      <div className="flex max-w-md flex-col gap-1.5">
        <h3 className="font-semibold text-lg text-text-primary">
          {t("playground.voice.title", "Call the agent")}
        </h3>
        <p className="text-sm text-text-secondary">
          {t(
            "playground.voice.desc",
            "Talk through your microphone, as a customer would on WhatsApp. No customer is called and nothing reaches Chatwoot: what the agent would do in the conversation is simulated.",
          )}
        </p>
      </div>
      {!hasKey ? (
        <div className="flex flex-col items-center gap-2">
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            {t(
              "playground.voice.noKey",
              "Choose the {{provider}} key on General and save first.",
              { provider: providerLabel(provider, t) },
            )}
          </p>
          <Button variant="secondary" onClick={onOpenGeneral}>
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            {t("playground.goToGeneral", "Go to General")}
          </Button>
        </div>
      ) : unsaved && onSave ? (
        // The call runs on what is saved, so with changes pending the first action saves them.
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => void call.start(onSave)}>
            <Phone className="h-4 w-4" aria-hidden="true" />
            {liveness === "goingLive"
              ? t(
                  "playground.call.goLiveAndStart",
                  "Put in production and call",
                )
              : t("playground.call.saveAndStart", "Save and call")}
          </Button>
          <Button variant="secondary" onClick={() => void call.start()}>
            {t("playground.call.startSaved", "Call the saved version")}
          </Button>
        </div>
      ) : (
        <Button onClick={() => void call.start()}>
          <Phone className="h-4 w-4" aria-hidden="true" />
          {unsaved
            ? t("playground.call.startSaved", "Call the saved version")
            : t("playground.call.start", "Call")}
        </Button>
      )}
      <ul className="flex max-w-md flex-col gap-1 text-left text-text-muted text-xs">
        <li className="flex items-start gap-1.5">
          <Headphones
            className="mt-px h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          {t(
            "playground.voice.headphones",
            "Use headphones: on speakers the agent can hear itself.",
          )}
        </li>
        {unsaved && (
          <li className="flex items-start gap-1.5 text-warning">
            <TriangleAlert
              className="mt-px h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            {!onSave
              ? t(
                  "playground.voice.unsaved",
                  "There are unsaved changes. Save them to try them, or call the saved version.",
                )
              : liveness === "goingLive"
                ? t(
                    "playground.voice.unsavedGoingLive",
                    "Saving puts this agent in production: it starts answering the calls of the inboxes marked on Channels.",
                  )
                : liveness === "leavingLive"
                  ? t(
                      "playground.voice.unsavedLeavingLive",
                      "Saving takes this agent out of production: it stops answering the calls of the inboxes marked on Channels.",
                    )
                  : liveness === "live"
                    ? t(
                        "playground.voice.unsavedLive",
                        "There are unsaved changes. This agent answers customers: saving puts them on its calls too.",
                      )
                    : t(
                        "playground.voice.unsaved",
                        "There are unsaved changes. Save them to try them, or call the saved version.",
                      )}
          </li>
        )}
      </ul>
    </Card>
  );
}
