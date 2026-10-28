import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { useMediaObjectUrl } from "./useMediaObjectUrl";

// Plays audio served by a cookie-authenticated, same-origin endpoint (the playground media route).
// That endpoint streams bytes WITHOUT range support, so a raw `<audio src={endpoint}>` shows 00:00
// and won't seek: Ogg/Opus needs the whole blob to compute its duration. useMediaObjectUrl fetches
// the blob (with the tenant header) and hands <audio> an object URL, mirroring the local-recording
// path (which plays fine).
//
// NOTE: Ogg/Opus plays in Chromium/Firefox; Safari support is limited (it may still not play).
export function MediaAudio({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { url, failed } = useMediaObjectUrl(src);

  if (failed) {
    return (
      <span className="text-text-muted text-xs italic">
        {t("playground.audio.loadFailed", "Could not load the audio.")}
      </span>
    );
  }
  if (!url) {
    return (
      <div
        className="bg-bg-tertiary h-8 w-44 max-w-full animate-pulse rounded-full"
        role="status"
        aria-label={t("common.loading", "Loading…")}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useMediaCaption: a recorded/generated voice note has no caption track
    <audio controls src={url} className={cn("h-8 max-w-full", className)} />
  );
}
