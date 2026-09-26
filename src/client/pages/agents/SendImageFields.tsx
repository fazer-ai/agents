import { useTranslation } from "react-i18next";
import { FormField, Textarea } from "@/client/components";
import { readSendImageConfig } from "@/modules/images/settings";

// NOTE: Mirrors agent.settings.sendImage (modules/images/settings). Edited as one host per line and
// stored as an array; the reader normalizes, de-duplicates and caps it.
export interface SendImageState {
  allowedHosts: string;
}

export function readSendImageState(raw: unknown): SendImageState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const hosts = Array.isArray(o.allowedHosts)
    ? o.allowedHosts.filter((h): h is string => typeof h === "string")
    : [];
  return { allowedHosts: hosts.join("\n") };
}

export function serializeSendImage(state: SendImageState): {
  allowedHosts: string[];
} {
  return {
    allowedHosts: state.allowedHosts
      .split("\n")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

// What the runtime would read out of this form: a list whose every line the reader drops is as empty
// as no list, and the tool refuses every call either way. Drives the card's warning and its dot.
export function sendImageHasNoHost(state: SendImageState): boolean {
  return (
    readSendImageConfig({ sendImage: serializeSendImage(state) }).allowedHosts
      .length === 0
  );
}

// Props named after the block, not `value`: the editor's text-cap fence waives this uncapped textarea
// by the expression it renders (tests/client/editor-text-caps.test.ts).
export function SendImageFields({
  sendImage,
  setSendImage,
}: {
  sendImage: SendImageState;
  setSendImage: (v: SendImageState) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <FormField
        label={t("editor.sendImageHosts", "Allowed hosts")}
        description={t(
          "editor.sendImageHostsHint",
          'One per line, e.g. cdn.minhaloja.com.br. Start with "*." to cover a domain and its subdomains (*.minhaloja.com.br). Paste a full URL and only its host is kept.',
        )}
      >
        <Textarea
          value={sendImage.allowedHosts}
          onChange={(e) => setSendImage({ allowedHosts: e.target.value })}
          rows={4}
          placeholder="cdn.minhaloja.com.br"
        />
      </FormField>
      <p className="text-text-muted text-xs">
        {t(
          "editor.sendImageSourceNote",
          "The agent chooses the address, but only these sites can be reached. Output checks inspect the text, not the image: the list restricts where an image comes from, not what it shows.",
        )}
      </p>
    </div>
  );
}
