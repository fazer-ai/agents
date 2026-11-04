import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormField, Input } from "@/client/components";

// The two optional addresses of a Chatwoot connection, folded under "Advanced": most installations
// leave both empty. The section starts open when either already has a value, and stays open while
// either shows an error, so a refusal is never hidden behind the fold. Folded with a value, its
// header says what is set.
export function AdvancedAddresses({
  webhookBaseUrl,
  publicUrl,
  onWebhookBaseUrl,
  onPublicUrl,
  webhookBaseUrlError,
  publicUrlError,
}: {
  webhookBaseUrl: string;
  publicUrl: string;
  onWebhookBaseUrl: (v: string) => void;
  onPublicUrl: (v: string) => void;
  webhookBaseUrlError?: string | null;
  publicUrlError?: string | null;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const hasWebhook = webhookBaseUrl.trim() !== "";
  const hasPublic = publicUrl.trim() !== "";
  // Read once, when the dialog mounts the section: typing into a field must not fold or unfold it.
  const [toggled, setToggled] = useState(hasWebhook || hasPublic);
  const hasError = Boolean(webhookBaseUrlError || publicUrlError);
  const open = toggled || hasError;
  const summary = hasWebhook
    ? t("channels.advancedPrivateSet", "Private network configured")
    : hasPublic
      ? t("channels.advancedPublicSet", "Public address configured")
      : null;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="text-text-primary flex items-center gap-1 self-start text-sm font-medium"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setToggled(!open)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        )}
        {t("channels.advanced", "Advanced")}
        {!open && summary && (
          <span className="text-text-muted font-normal">· {summary}</span>
        )}
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-4">
          <FormField
            label={t("channels.webhookBaseUrl", "Address this Chatwoot calls")}
            description={t(
              "channels.webhookBaseUrlHint",
              "Where this Chatwoot reaches fazer.ai agents. Leave empty to use this app's public address; fill in the private address when Chatwoot and the agents share a private network.",
            )}
            error={webhookBaseUrlError}
          >
            <Input
              value={webhookBaseUrl}
              onChange={(e) => onWebhookBaseUrl(e.target.value)}
              placeholder="http://10.0.0.6:3000"
            />
          </FormField>
          <FormField
            label={t("channels.publicUrl", "Chatwoot public address")}
            description={t(
              "channels.publicUrlHint",
              "The address people open Chatwoot on, used for links. Leave empty when it is the base URL; fill it in when the base URL is a private address.",
            )}
            error={publicUrlError}
          >
            <Input
              value={publicUrl}
              onChange={(e) => onPublicUrl(e.target.value)}
              placeholder="https://chat.example.com"
            />
          </FormField>
        </div>
      )}
    </div>
  );
}
