import type { TFunction } from "i18next";
import type { ConfirmPayload } from "@/client/components/ConfirmDialog";
import { readRefusal } from "@/client/lib/fieldRefusal";

// A bind onto an inbox that an Agent Bot this instance does not own answers (or one whose bot could
// not be read) is refused with `field: "replaceForeignBot"` and a sentence naming the bot and saying
// that unbinding later does not bring it back. The console asks with that sentence and binds again
// with the confirmation; any other refusal is the caller's to report.
export function foreignAgentBotRefusal(e: unknown): string | null {
  const refusal = readRefusal(e);
  return refusal?.field === "replaceForeignBot" ? refusal.message : null;
}

export function replaceForeignBotConfirm(
  t: TFunction,
  message: string,
  onConfirm: () => Promise<void>,
): ConfirmPayload {
  return {
    title: t("channels.replaceForeignBotTitle", "Replace the inbox's bot?"),
    message,
    confirmLabel: t("channels.replaceForeignBotConfirm", "Replace bot"),
    danger: true,
    onConfirm,
  };
}
