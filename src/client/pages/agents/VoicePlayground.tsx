// A voice agent's Playground: a call to the agent through the browser's microphone, on
// the SAVED settings (the agent on ElevenLabs is set up from them). Before the call, what is needed and
// what to expect; during and after it, the call screen (PlaygroundCall.tsx).

import { Headphones, Phone, Settings2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "@/client/components";
import { PlaygroundCallView } from "./PlaygroundCall";
import { usePlaygroundCall } from "./usePlaygroundCall";

export function VoicePlayground({
  agentId,
  hasKey,
  unsaved,
  onOpenGeneral,
}: {
  agentId: string;
  hasKey: boolean;
  unsaved: boolean;
  onOpenGeneral: () => void;
}) {
  const { t } = useTranslation();
  const call = usePlaygroundCall(agentId);

  if (call.call.state !== "idle")
    return (
      <Card className="flex h-[72dvh] flex-col p-0">
        <PlaygroundCallView call={call} />
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
            "Talk to it through your microphone, as a customer would on WhatsApp. The conversation tools are simulated, and nothing reaches Chatwoot.",
          )}
        </p>
      </div>
      {!hasKey ? (
        <div className="flex flex-col items-center gap-2">
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            {t(
              "playground.voice.noKey",
              "Choose the ElevenLabs key on General and save first.",
            )}
          </p>
          <Button variant="secondary" onClick={onOpenGeneral}>
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            {t("playground.goToGeneral", "Go to General")}
          </Button>
        </div>
      ) : (
        <Button onClick={() => void call.start()}>
          <Phone className="h-4 w-4" aria-hidden="true" />
          {t("playground.call.start", "Call")}
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
            {t(
              "playground.voice.unsaved",
              "You have unsaved changes. The call uses what is saved.",
            )}
          </li>
        )}
      </ul>
    </Card>
  );
}
